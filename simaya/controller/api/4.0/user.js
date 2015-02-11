module.exports = function(app){
  var atok = require("../../../models/oauth2/accessToken")(app);
  var user = require('../../../../sinergis/models/user')(app);
  var profileWeb = require('../../profile.js')(app);
  var ObjectID = app.ObjectID;

  function isValidObjectID(str) {
    str = str + '';
    var len = str.length, valid = false;
    if (len == 12 || len == 24) {
      valid = /^[0-9a-fA-F]+$/.test(str);
    }
    return valid;
  }

  /**
   * @api {get} /users/self Current User 
   * @apiVersion 4.0.0
   * @apiName GetBasicInformationAboutCurrentUser
   * @apiGroup Users
   * @apiPermission token
   *
   * @apiDescription Get basic information about current user
   * 
   * @apiParam {String} access_token The access token
   *
   * @apiExample URL Structure:
   * // DEVELOPMENT
   * http://ayam.vps1.kodekreatif.co.id/users/self
   * 
   * @apiExample Example usage:
   * curl http://ayam.vps1.kodekreatif.co.id/users/self?access_token=f3fyGRRoKZ...
   *
   */
  var self = function(req, res){

    var obj = {
      meta : { code : 200 },
    }

    if (!req.session.currentUserProfile) {
      obj.meta.code = 404;
      obj.meta.errorMessage = "User Not Found";

      return res.send(obj.meta.code, obj);
    }

    obj.data = req.session.currentUserProfile;
    res.send(obj);
  }
  

  /**
   * @api {get} /users/:id User Information
   * @apiVersion 4.0.0
   * @apiName GetBasicInformationAboutAUser
   * @apiGroup Users
   * @apiPermission token
   *
   * @apiDescription Get basic information about a user
   * 
   * @apiParam {String} access_token The access token
   * @apiParam {String} id Possible values: <code>id</code> (a valid string of <a href="http://docs.mongodb.org/manual/reference/object-id/" target="_blank">MongoDB <code>ObjectID</code></a>) or <code>username</code>
   *
   * @apiExample URL Structure:
   * // DEVELOPMENT
   * http://ayam.vps1.kodekreatif.co.id/users/:id
   * 
   * @apiExample Example usage:
   * curl http://ayam.vps1.kodekreatif.co.id/users/joko.susanto?access_token=f3fyGRRoKZ...
   * curl http://ayam.vps1.kodekreatif.co.id/users/50593effd9eb2fdc4e000123?access_token=f3fyGRRoKZ...
   */
  var info = function (req, res) {

    var obj = {
      meta : { code : 200 },
    }

    var query = {};

    if (isValidObjectID(req.params.id)){
      query._id = ObjectID(req.params.id);
    } else {
      query.username = req.params.id;
    }

    user.list({ search: query }, function(r) {

      if (!r || r.length == 0) {
        obj.meta.code = 404;
        obj.meta.errorMessage = "User Not Found";
        return res.send(obj.meta.code, obj);
      }

      var user = r[0].profile;
      user.id = r[0]._id;
      user.username = r[0].username;

      obj.data = user;
      res.send(obj);
      
    });
  }
  
  /**
   * @api {get} /users/logout/:id Removing Token
   * @apiVersion 4.0.0
   * @apiName RemoveToken
   * @apiGroup Users
   * @apiPermission token
   *
   * @apiDescription Get basic information about a user
   * 
   * @apiParam {String} access_token The access token
   * @apiParam {String} id Possible values: <code>username</code>
   *
   * @apiExample URL Structure:
   * // DEVELOPMENT
   * http://ayam.vps1.kodekreatif.co.id/users/logout/:id
   * 
   * @apiExample Example usage:
   * curl http://ayam.vps1.kodekreatif.co.id/users/logout/joko.susanto?access_token=f3fyGRRoKZ...
   */
  var logout = function (req, res) {
    var obj = {
      meta : { code : 200 },
    }
    var query = {};
    if (isValidObjectID(req.params.id)){
      query.username = req.params.id;
    }
    user.list({ search: query }, function(r) {
      if (!r || r.length == 0) {
        obj.meta.code = 404;
        obj.meta.errorMessage = "User Not Found";
        return res.send(obj.meta.code, obj);
      }
      var q = {
        user : req.params.id,
        accessToken : req.header("Authorization").split(" ")[1]
      }
      console.log("removing " + req.header("Authorization").split(" ")[1]);
      atok.del(q, function(err, result){
        if (err) {
          obj.meta.code = 404;
          obj.meta.errorMessage = "Failed to remove the token.";
          return res.send(obj.meta.code, obj);
        }
        obj.data = "Token removed";
        return res.send(obj);
      });
    });
  }
  var getAvatar = function(req, res) {
    req.query = {
      username : req.params.id
    }
    profileWeb.getAvatarStream(req, res);
  }
  var getAvatarBase64 = function(req, res) {
    req.query = {
      username : req.params.id
    }
    profileWeb.getAvatarBase64Stream(req, res);
  }

  return {
    self : self,
    info : info,
    logout : logout,
    getAvatar : getAvatar,
    getAvatarBase64 : getAvatarBase64
  }
}
