var config = {
  filename: __filename,
  ns: 'user',
  scripts: {
    forgot: require('./forgot'),
    signin: require('./signin'),
    signout: require('./signout'),
    signup: require('./signup')
  }
};

module.exports = function (app, options) {
  app.createLibrary(config, options);
};