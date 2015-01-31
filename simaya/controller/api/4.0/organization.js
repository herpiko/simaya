module.exports = function(app){
  var utils = require("../../../../sinergis/controller/utils.js")(app)
  var user = require("../../../../sinergis/models/user.js")(app)
  var org = require("../../../models/organization.js")(app)

  /**
   * @api {get} /organization/first-level/
   */
  var list = function(req, res) {
    var obj = {
      meta : { code : 200 },
    }
    var myOrganization = req.session.currentUserProfile.organization;
    var onlyFirstLevel = {path: {$regex: "^[^;]*$"}}
    var search = undefined;

    if (req.query.exclude) {
      search = {path: {$ne: myOrganization}};
    } else if (req.query.prefix) {
      search = {path: {$regex: "^" + req.query.prefix}};
    } else if (req.query.onlyFirstLevel) {
      search = onlyFirstLevel;
      if (app.simaya.installationId && req.query.organizationView) {
        search.origin = app.simaya.installationId;
      } else if (!app.simaya.installationId && req.query.organizationView) {
        search.origin = { $exists : false }
      }
    }

    org.list(search, function(r) {
      obj.data = r;
      res.send(obj);
    });
  }
  
  var people = function(req, res){
    var obj = {
      meta : { code : 200 },
    }
    var exclude = [];
    var me = req.session.currentUser;
    exclude.push(me);
    console.log(exclude);
    console.log(req.query.path);
    user.people(exclude,req.query.path, function(err, result){
      if (err) {
        obj.meta.code = 404;
        res.send(obj);
      }
      obj.data = result;
      res.send(obj);
    });
  }

  return {
    list : list,
    people : people
  }
}
