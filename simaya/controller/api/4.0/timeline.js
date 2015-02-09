module.exports = function(app){

  /* var letterAPI = require("../1.0/letter")(app); */
  var timelineWeb = require("../../timeline.js")(app);
  var timeline = require("../../../models/timeline.js")(app);
  var cUtils = require("../../utils.js")(app);
  var orgWeb = require("../../organization.js")(app);
  var moment = require("moment");
  var user = require("../../../../sinergis/models/user.js")(app);

  var timeline = function(req, res) {
    req.api = true;
    timelineWeb.list(req, function(result){
      var obj = {
        meta : {
          code : 200
        }
      }
      if (result == null) {
        obj.meta.code = 404;
        obj.meta.errorMessage = "Timeline is Empty";
        return res.send(obj.meta.code, obj);
      }
      obj.data = result;
      res.send(obj);
    })
  }


  return {
    timeline : timeline
  }
}
