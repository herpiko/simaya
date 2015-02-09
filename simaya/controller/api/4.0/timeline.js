module.exports = function(app){

  /* var letterAPI = require("../1.0/letter")(app); */
  var timelineWeb = require("../../timeline.js")(app);
  var timelineModel = require("../../../models/timeline.js")(app);
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
        },
        data : [],
      }
      if (result == null) {
        obj.meta.code = 404;
        obj.meta.errorMessage = "Timeline is Empty";
        return res.send(obj.meta.code, obj);
      } else {
        result.reverse();
        result.forEach(function(item){
          console.log(item);
          // trim the objects
          data = {
            _id : item._id,
            date : moment(item.date).format("DD MMM YYYY"),
            user : item.user,
            text : item.text,
            attachment : item.attachment,
            created_at : item.created_at,
            comments : item.comments,
          } 
          obj.data.push(data);
        });
      }
      res.send(obj);
    })
  }
  
  var view = function(req, res){
    timelineModel.read(req.params.id, function(result){
      var obj = {
        meta : {
          code : 200
        },
        data : [],
      }
      if (result == null) {
        obj.meta.code = 404;
        obj.meta.errorMessage = "Timeline is Empty";
        return res.send(obj.meta.code, obj);
      } else {
        result.reverse();
        result.forEach(function(item){
          // trim the objects
          data = {
            _id : item._id,
            date : moment(item.date).format("DD MMM YYYY"),
            user : item.user,
            text : item.text,
            attachment : item.attachment,
            created_at : item.created_at,
            comments : item.comments,
          }
          if (data.comments) {
            data.comments.forEach(function(comment){
              comment.date = moment(comment.date).format("DD MMM YYYY");
            });
          }
          obj.data = data;
        });
      }
      res.send(obj);
    });  
  }

  return {
    timeline : timeline,
    view : view
  }
}
