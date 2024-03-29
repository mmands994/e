/* global module, Application, User, Reddit */
var moment = require('moment');
var refreshToken = sails.config.reddit.adminRefreshToken;
var _ = require("lodash");

module.exports = {

  apply: async function (req, res) {
    try {
      var allFlairs = await Flair.find();
      var userRefs = await Reference.find({user: req.user.name});
      var appData = {user: req.user.name, flair: req.allParams().flair, sub: req.allParams().sub};
      if (await Application.findOne(appData)) {
        return res.status(400).json({error: 'You have already applied for that flair'});
      }
      var flairIndex = allFlairs.map(function (flairObj) {
        return flairObj.name;
      }).indexOf(req.allParams().flair);
      if (flairIndex === -1) {
        return res.status(400).json({error: 'That flair does not exist'});
      }
      var applicationFlair = allFlairs[flairIndex];
      if (!Flairs.canUserApply(userRefs, applicationFlair, Flairs.getUserFlairs(req.user, allFlairs))) {
        return res.status(400).json({error: 'You do not qualify for that flair'});
      }
      return res.ok(await Application.create(appData));
    } catch (err) {
      return res.serverError(err);
    }
  },

  denyApp: async function (req, res) {
    try {
      var matching_apps = await Application.destroy(req.allParams().id);
      var apps = await Flairs.getApps();
      if (!matching_apps.length) {
        return res.status(404).json(apps);
      }
      return res.ok(apps);
    } catch (err) {
      return res.serverError(err);
    }
  },

  approveApp: async function (req, res) {
    try {
      var app = await Application.findOne(req.allParams().id);
      if (!app) {
        return res.status(404).json(await Flairs.getApps());
      }
      var user = await User.findOne(app.user);
      var shortened = app.sub === 'pokemontrades' ? 'ptrades' : 'svex';
      var relevant_flair = Flairs.makeNewCSSClass(_.get(user, 'flair.' + shortened + '.flair_css_class') || '', app.flair, app.sub);
      user.flair[shortened].flair_css_class = relevant_flair;
      await Reddit.setUserFlair(req.user.redToken, user.name, relevant_flair, user.flair[shortened].flair_text, app.sub);
      var promises = [];
      promises.push(user.save());
      promises.push(Event.create({type: "flairTextChange", user: req.user.name,content: "Changed " + user.name + "'s flair to " + relevant_flair}));
      var pmContent = 'Your application for ' + Flairs.formattedName(app.flair) + ' flair on /r/' + app.sub + ' has been approved.';
      promises.push(Reddit.sendPrivateMessage(refreshToken, 'FlairHQ Notification', pmContent, user.name));
      promises.push(Application.destroy({id: req.allParams().id}));
      await* promises;
      sails.log.info("/u/" + req.user.name + ": Changed " + user.name + "'s flair to " + relevant_flair);
      return res.ok(await Flairs.getApps());
    } catch (err) {
      return res.serverError(err);
    }
  },

  setText: async function (req, res) {
    var flairs;
    try {
      flairs = Flairs.flairCheck(req.allParams().ptrades, req.allParams().svex);
    } catch (e) {
      return res.status(400).json({error: e});
    }
    try {
      var appData = {
        limit: 1,
        sort: "createdAt DESC",
        user: req.user.name,
        type: "flairTextChange"
      };
      var events = await Event.find(appData);
      var now = moment();
      if (events.length) {
        var then = moment(events[0].createdAt);
        then.add(2, 'minutes');
        if (then.isAfter(now)) {
          return res.status(400).json({error: "You set your flair too recently, please try again in a few minutes."});
        }
      }

      var blockReport = _.isEqual(flairs.fcs, req.user.loggedFriendCodes.slice(0, flairs.fcs.length));

      var flagged = _.reject(flairs.fcs, Flairs.validFC);
      var ipAddress = req.headers['x-forwarded-for'] || req.ip;
      // Get IP matches with banned users
      var events_with_ip = await Event.find({content: {contains: ipAddress}, user: {not: req.user.name}});
      var matching_alt_usernames = _.uniq(_.map(events_with_ip, 'user'));
      var matching_banned_users = await User.find({name: matching_alt_usernames, banned: true});
      var banned_alts = _.map(matching_banned_users, 'name');

      // Get friend codes that are similar (have a low edit distance) to banned friend codes
      var similar_banned_fcs = _.flatten(await* flairs.fcs.map(Flairs.getSimilarBannedFCs));
      // Get friend codes that are identical to banned users' friend codes
      var identical_banned_fcs = _.intersection(flairs.fcs, similar_banned_fcs);

      var friend_codes = _.union(flairs.fcs, req.user.loggedFriendCodes);

      var newPFlair = _.get(req, "user.flair.ptrades.flair_css_class") || "default";
      var newsvFlair = _.get(req, "user.flair.svex.flair_css_class") || "";
      newsvFlair = newsvFlair.replace(/2/, "");
      var promises = [];
      var extraFlair = req.allParams().extraFlair;
      if (extraFlair && _.includes(Flairs.extraFlair, extraFlair)) {
        newPFlair = Flairs.makeNewCSSClass(newPFlair, extraFlair, "PokemonTrades");
      } else if (extraFlair) {
        return res.status(400).json({error: "Unexpected extra flair."});
      }
      promises.push(Reddit.setUserFlair(refreshToken, req.user.name, newPFlair, flairs.ptrades, "PokemonTrades"));
      promises.push(Reddit.setUserFlair(refreshToken, req.user.name, newsvFlair, flairs.svex, "SVExchange"));
      promises.push(User.update({name: req.user.name}, {loggedFriendCodes: friend_codes}));

      if (!blockReport && (identical_banned_fcs.length || banned_alts.length || flagged.length)) {
        var message = 'The user /u/' + req.user.name + ' set the following flairs:\n\n' + flairs.ptrades + '\n\n' + flairs.svex + '\n\n';
        if (identical_banned_fcs.length) {
          message += '**This flair contains a banned friend code: ' + identical_banned_fcs + '**\n\n';
        } else if (flagged.length && similar_banned_fcs.length) {
          message += '**This flair contains a friend code similar to the following banned friend code'  + (similar_banned_fcs.length > 1 ? 's: ' : ': ') +
            similar_banned_fcs.join(', ') + '**\n\n';
        }
        if (banned_alts.length) {
          message += '**This user may be an alt of the banned user' + (banned_alts.length === 1 ? '' : 's') + ' /u/' + banned_alts.join(', /u/') + '.**\n\n';
        }
        if (flagged.length) {
          message += 'The friend code' + (flagged.length === 1 ? ' ' + flagged + ' is' : 's ' + flagged.join(', ') + ' are') + ' invalid.\n\n';
          var formattedNote = "Invalid friend code" + (flagged.length == 1 ? "" : "s") + ": " + flagged.join(', ');
          promises.push(Usernotes.addUsernote(refreshToken, 'FlairHQ', 'pokemontrades', req.user.name, formattedNote, 'spamwarn', ''));
        }
        message = message.slice(0,-2);
        promises.push(Reddit.sendPrivateMessage(refreshToken, "FlairHQ notification", message, "/r/pokemontrades"));
      }
      Promise.all(promises).then(function () {
        Event.create([{
          type: "flairTextChange",
          user: req.user.name,
          content: "Changed PokemonTrades flair text to: " + req.allParams().ptrades + ". IP: " + ipAddress
        }, {
          type: "flairTextChange",
          user: req.user.name,
          content: "Changed SVExchange flair text to: " + req.allParams().svex + ". IP: " + ipAddress
        }]).exec(function () {});
        return res.ok();
      });
    } catch (err) {
      return res.serverError(err);
    }
  },

  getApps: async function (req, res) {
    try {
      return res.ok(await Flairs.getApps());
    } catch (err) {
      return res.serverError(err);
    }
  },

  refreshClaim: async function (req, res) {
    try {
      await Flairs.refreshAppClaim(req.allParams(), req.user.name);
      return res.ok();
    } catch (err) {
      return res.serverError(err);
    }
  }
};
