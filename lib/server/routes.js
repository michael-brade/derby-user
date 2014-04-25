var credential = require('credential')
  , moment = require('moment')
  , passport = require('passport');

module.exports = function (app, options) {
  options.tokenDuration = options.tokenDuration || 86400000;

  return function () {
    app.post('/user/checkPassword', function (req, res, next) {
      var model = req.getModel()
        , userId = req.body.userId
        , usernameOrEmail = (req.body.usernameOrEmail || '').trim()
        , $query = !~usernameOrEmail.indexOf('@')
            ? model.query('usersPublic', {'local.username': usernameOrEmail})
            : model.query('usersPrivate', {'local.emails.0.value': usernameOrEmail});

      if (userId) return next();
      if (!usernameOrEmail) return res.json(400, {error: 'missing username or email'});

      $query.fetch(function (err) {
        if (err) return res.send(500, {error: err});
        var user = $query.get()[0];
        if (!user) return res.send({error: 'not found'});
        req.body.userId = user.id;
        next();
      });
    });

    app.post('/user/checkPassword', function (req, res) {
      var model = req.getModel()
        , password = req.body.password
        , userId = req.body.userId
        , $private = model.at('usersPrivate.' + userId);

      if (!userId) return res.json(400, {error: 'missing user id'});
      if (!password) return res.json(400, {error: 'missing password'});

      $private.fetch(function (err) {
        if (err) return res.send(500, {error: err});
        var hashedPassword = $private.get('local.password.hash');
        credential.verify(hashedPassword, password, function (err, valid) {
          if (err) return res.json({error: err});
          if (!valid) return res.json({error: 'invalid password'});
          res.send();
        });
      });
    });

    app.post('/user/changeEmail', function (req, res) {
      var model = req.getModel()
        , email = (req.body.email || '').trim()
        , userId = model.get('_session.user.id')
        , $query = model.query('usersReserved', {'local.email': email})
        , $private = model.at('usersPrivate.' + userId)

      if (!userId) return res.send(400, {error: 'not signed in'});
      if (!email) return res.send(400, {error: 'missing email'});

      model.fetch($private, $query, function (err) {
        if (err) return res.send(500, {error: err});
        var reserved = $query.get()[0];
        if (reserved) return res.send(400, {error: 'email in use'});
        var token = model.id();
        credential.hash(token, function (err, hashedToken) {
          if (err) return res.send(500, {error: err});
          var oldEmail = $private.get('local.emails.0.value');
          $private.set('local.emails.0.token.date', new Date());
          $private.set('local.emails.0.token.hash', hashedToken);
          $private.set('local.emails.0.value', email);
          $private.set('local.emails.0.verified', false, function () {
            app.emit('user.changeEmail', {token: token, userId: userId});
          });
          if (!oldEmail) return res.send();
          $query = model.query('usersReserved', {'local.email': oldEmail});
          $query.fetch(function (err) {
            if (err) return res.data(500, {error: err});
            reserved = $query.get()[0];
            if (!reserved) return res.send();
            var $reserved = model.at('usersReserved.' + reserved.id);
            $reserved.fetch(function (err) {
              if (err) return res.send(500, {error: err});
              $reserved.set('local.email', email);
            });
          });
        });
      });
    });

    app.post('/user/changePassword', function (req, res) {
      var model = req.getModel()
        , currentPassword = req.body.currentPassword
        , password = req.body.password
        , userId = model.get('_session.user.id')
        , $private = model.at('usersPrivate.' + userId);

      if (!userId) return res.send(400, {error: 'not signed in'});
      if (!currentPassword) return res.send(400, {error: 'missing current password'});
      if (!password) return res.send(400, {error: 'missing password'});

      $private.fetch(function (err) {
        if (err) return res.send(500, {error: err});
        var hashedPassword = $private.get('local.password.hash');
        credential.verify(hashedPassword, password, function (err, valid) {
          if (err) return done(err);
          if (!valid) return done(null, false, {error: 'invalid current password'});
          credential.hash(password, function (err, hashedPassword) {
            if (err) return res.send(500, {error: err});
            $private.set('local.password.hash', hashedPassword, function () {
              res.send();
            });
          });
        });
      });
    });

    app.post('/user/changeUsername', function (req, res) {
      var model = req.getModel()
        , username = (req.body.username || '').trim()
        , userId = model.get('_session.user.id')
        , $query = model.query('usersPublic', {id: {$ne: userId}, 'local.username': username})
        , $public = model.at('usersPublic.' + userId);

      if (!userId) return res.send(400, {error: 'not signed in'});
      if (!username) return res.send(400, {error: 'missing username'});

      model.fetch($public, $query, function (err) {
        if (err) return res.send(500, {error: err});
        var user = $query.get()[0];
        if (user) return res.send(400, {error: 'username in use'});
        $public.set('local.username', username, function () {
          res.send();
        });
      });
    });

    app.get('/user/:id/confirmEmail/:token', function (req, res, next) {
      var model = req.getModel()
        , token = req.params.token
        , userId = req.params.id
        , $private = model.at('usersPrivate.' + userId);

      if (!userId) return next('not signed in');
      if (!token) return next('missing token');

      $private.fetch(function (err) {
        if (err) return next(err);
        var elapsed = moment().diff($private.get('local.emails.0.token.date'));
        if (elapsed > options.tokenDuration) return next('token expired');
        var hashedToken = $private.get('local.emails.0.token.hash');
        credential.verify(hashedToken, token, function (err, valid) {
          if (err) return next(err);
          if (!valid) return next('invalid token');
          $private.del('local.emails.0.token');
          $private.set('local.emails.0.verified', true, function () {
            res.redirect('/user/confirmedEmail');
          });
        });
      });
    });

    app.get('/user/confirmedEmail', function (req, res) {
      res.redirect('/');
    });

    app.post('/user/confirmEmail', function (req, res) {
      var model = req.getModel()
        , token = req.body.token
        , userId = model.get('_session.user.id')
        , $private = model.at('usersPrivate.' + userId);

      if (!userId) return res.send(400, {error: 'not signed in'});
      if (!token) return res.send(400, {error: 'missing token'});

      $private.fetch(function (err) {
        if (err) return res.send(500, {error: err});
        var elapsed = moment().diff($private.get('local.emails.0.token.date'));
        if (elapsed > options.tokenDuration) return res.send(400, {error: 'token expired'});
        var hashedToken = $private.get('local.emails.0.token.hash');
        credential.verify(hashedToken, token, function (err, valid) {
          if (err) return res.send(500, {error: err});
          $private.del('local.emails.0.token');
          $private.set('local.emails.0.verified', true, function () {
            res.send();
          });
        });
      });
    });

    app.post('/user/forgotPassword', function (req, res) {
      var model = req.getModel()
        , usernameOrEmail = (req.body.usernameOrEmail || '').trim()
        , $query = !~usernameOrEmail.indexOf('@')
            ? model.query('usersPublic', {'local.username': usernameOrEmail})
            : model.query('usersPrivate', {'local.emails.0.value': usernameOrEmail});

      if (!usernameOrEmail) return res.send(400, {error: 'missing username or email'});

      $query.fetch(function (err) {
        if (err) return res.send(500, {error: err});
        var user = $query.get()[0];
        if (!user) return res.send(400, {error: 'not found'});
        var $private = model.at('usersPrivate.' + user.id);
        $private.fetch(function (err) {
          if (err) return res.send(500, {error: err});
          var token = model.id();
          credential.hash(token, function (err, hashedToken) {
            if (err) return res.send(500, {error: err});
            $private.set('local.password.token.date', new Date());
            $private.set('local.password.token.hash', hashedToken, function () {
              app.emit('user.forgotPassword', {token: token, userId: user.id});
              res.send();
            });
          });
        });
      });
    });

    app.post('/user/resetPassword', function (req, res, next) {
      var model = req.getModel()
        , password = req.body.password
        , token = req.body.token
        , userId = req.body.userId
        , $private = model.at('usersPrivate.' + userId);

      if (!userId) return res.send(400, {error: 'missing user id'});
      if (!password) return res.send(400, {error: 'missing password'});

      $private.fetch(function (err) {
        if (err) return res.send(500, {error: err});
        var elapsed = moment().diff($private.get('local.password.token.date'));
        if (elapsed > options.tokenDuration) return next('token expired');
        var hashedToken = $private.get('local.password.token.hash');
        credential.verify(hashedToken, token, function (err, valid) {
          if (err) return res.send(500, {error: err});
          if (!valid) return res.send(400, {error: 'invalid token'});
          credential.hash(password, function (err, hashedPassword) {
            if (err) return res.send(500, {error: err});
            $private.del('local.password.token');
            $private.set('local.password.hash', hashedPassword, function () {
              res.send();
            });
          });
        });
      });
    });

    app.post('/user/sessionize', function (req, res) {
      var model = req.getModel();

      if (req.isAuthenticated()) {
        model.set('_session.user.id', req.user.id);
        return res.send({user: req.user});
      }

      var user = {id: model.id()};
      req.login(user, function (err) {
        if (err) return next(err);
        model.add('usersPrivate', {id: user.id});
        model.add('usersPublic', {id: user.id, created: new Date(), isRegistered: false});
        model.set('_session.user.id', user.id);
        res.send({user: user});
      });
    });

    app.post('/user/signin', function (req, res, next) {
      passport.authenticate('local', function (err, user, info) {
        if (err) return res.send(500, {error: err});
        if (info) return res.send(400, info);
        if (!user) return res.send(404, {error: 'not found'});
        req.logIn(user, function(err) {
          if (err) return res.send(500, {error: 'failed'});
          res.send({user: user});
        });
      })(req, res, next);
    });

    app.post('/user/signout', function (req, res) {
      var model = req.getModel()
        , userId = model.get('_session.user.id')
        , $public = model.at('usersPublic.' + userId);

      $public.fetch(function (err) {
        if (err) return res.send(500, {error: err});
        if (!$public.get('isRegistered')) return res.send(400, {error: 'not signed in'});
        var user = {id: model.id()};
        req.logout();
        req.login(user, function (err) {
          if (err) return res.send(500, {error: 'failed'});
          model.add('usersPrivate', {id: user.id});
          model.add('usersPublic', {id: user.id, created: new Date(), isRegistered: false});
          model.set('_session.user.id', user.id);
          res.send({user: user});
        });
      });
    });

    app.post('/user/signup', function (req, res) {
      var model = req.getModel()
        , email = (req.body.email || '').trim()
        , password = req.body.password || ''
        , username = (req.body.username || '').trim()
        , userId = model.get('_session.user.id')
        , $public = model.at('usersPublic.' + userId)
        , $private = model.at('usersPrivate.' + userId)
        , $query1 = model.query('usersPublic', {'local.username': username})
        , $query2 = model.query('usersPrivate', {'local.emails.value': email});

      if (!email) return res.send(400, {error: 'missing email'});
      if (!password) return res.send(400, {error: 'missing password'});
      if (!username) return res.send(400, {error: 'missing username'});

      model.fetch($query1, $query2, $public, $private,
        function (err) {
          if (err) return res.send(500, {error: err});
          if ($query1.get()[0] || $query2.get()[0]) return res.send(400, {error: 'user exists'});
          if ($public.get('isRegistered')) return res.send(400, {error: 'already registered'});
          var token = model.id();
          credential.hash(token, function (err, hashedToken) {
            if (err) return res.send(500, {error: err});
            credential.hash(password, function (err, hashedPassword) {
              if (err) return res.send(500, {error: err});
              $public.set('isRegistered', true);
              $public.set('joined', new Date());
              $public.set('local.username', username);
              $private.set('local.emails.0.token.date', new Date());
              $private.set('local.emails.0.token.hash', hashedToken);
              $private.set('local.emails.0.value', email);
              $private.set('local.emails.0.verified', false);
              $private.set('local.password.hash', hashedPassword);
              model.add('usersReserved', {local: {email: email}}, function () {
                app.emit('user.signup', {req: req, token: token, userId: userId});
                res.send();
              });
            });
          });
        }
      );
    });

    app.post('/user/verifyEmail', function (req, res) {
      var model = req.getModel()
        , email = (req.body.email || '').trim()
        , userId = model.get('_session.user.id')
        , $query = model.query('usersPrivate', {id: {$ne: userId}, 'local.emails.value': email})
        , $private = model.at('usersPrivate.' + userId);

      if (!userId) return res.send(400, {error: 'not signed in'});

      model.fetch($private, $query, function (err) {
        if (err) return res.send(500, {error: err});
        var user = $query.get()[0];
        if (user) return res.send(400, {error: 'email in use'});
        if (email) $private.set('local.emails.0.value', email);
        var token = model.id();
        credential.hash(token, function (err, hashedToken) {
          if (err) return res.send(500, {error: err});
          $private.set('local.emails.0.token.date', new Date());
          $private.set('local.emails.0.token.hash', hashedToken, function () {
            app.emit('user.verifyEmail', {token: token, userId: userId});
            res.send();
          });
        });
      });
    });

    return function (req, res, next) {
      next();
    };
  };
};
