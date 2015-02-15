module.exports = function(app){

  /* var letterAPI = require("../1.0/letter")(app); */
  var timelineWeb = require("../../timeline.js")(app);
  var timelineModel = require("../../../models/timeline.js")(app);
  var moment = require("moment");
  var user = require("../../../../sinergis/models/user.js")(app);
  var ob = require("../../../../ob/file.js")(app);

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
        result.reverse().splice(10);
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
            loves : item.loves,
          } 
          obj.data.push(data);
        });
      }
      res.send(obj);
    })
  }
 
  timelineUpload = function(req, res){
    // cordovaFileTransfer are using file instead of upload
    req.files.upload = req.files.file;
    var fileType = req.files.upload.name.split(".")[req.files.upload.name.split(".").length-1];
    var acceptFileTypes = /^(jpe?g|png)$/i;
    if (typeof(fileType) != undefined && acceptFileTypes.test(fileType)) {
      ob.simplePublicUpload(req.files.upload, "/timeline/status", function(e, r) {
        var image = "/ob/get/" + r._id;
        res.send({path: image})
      });
    } else {
      res.send({error: "invalid-file-type"})
    }
    
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
            loves : item.loves,
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

  var post = function(req, res) {
    var obj = {
      meta : {
        code : 200
      },
      data : [],
    }
    if (req.body.text) {
      var data = {
        date : new Date(),
        text : req.body.text,
        user : req.session.currentUser,
      }
      if (req.body.attachment) {
        data.attachment = req.body.attachment;
      }
      timelineModel.insert(data, function(err, id) {
        if (err) {
          obj.meta.code = 404;
          obj.meta.errorMessage = JSON.stringify(err);
          res.send(obj.meta.code, obj);
        } else {
          obj.data = id;
          res.send(obj);
        }
      });
    } else {
      obj.meta.code = 404;
      obj.meta.errorMessage = "Status text must not empty.";
      res.send(obj.meta.code, obj);
    }
  }

  var postComment = function(req, res) {
    var obj = {
      meta : {
        code : 200
      },
      data : [],
    }
    if (req.body.text) {
      var data = {
        date : new Date(),
        text : req.body.text,
        id : req.body.id,
        user : req.session.currentUser,
      }
      if (req.body.attachment) {
        data.attachment = req.body.attachment;
      }
      timelineModel.comment(data, function(result) {
        if (result == null) {
          obj.meta.code = 404;
          obj.meta.errorMessage = JSON.stringify(err);
          res.send(obj.meta.code, obj);
        } else {
          obj.data = result;
          res.send(obj);
        }
      });
    } else {
      obj.meta.code = 404;
      obj.meta.errorMessage = "Comment must not empty.";
      res.send(obj.meta.code, obj);
    }
  }
  var love = function(req, res) {
    var obj = {
      meta : {
        code : 200
      },
      data : [],
    }
    if (req.body.id) {
      var data = {
        id : req.body.id,
        user : req.session.currentUser,
      }
      timelineModel.love(data, function(result) {
        if (!result) {
          obj.meta.code = 404;
          obj.meta.errorMessage = JSON.stringify(err);
          res.send(obj.meta.code, obj);
        } else {
          obj.data = result;
          res.send(obj);
        }
      });
    } else {
      obj.meta.code = 404;
      obj.meta.errorMessage = "Comment must not empty.";
      res.send(obj.meta.code, obj);
    }
  }
  var unlove = function(req, res) {
    var obj = {
      meta : {
        code : 200
      },
      data : [],
    }
    if (req.body.id) {
      var data = {
        id : req.body.id,
        user : req.session.currentUser,
      }
      timelineModel.love(data, function(result) {
        if (!result) {
          obj.meta.code = 404;
          obj.meta.errorMessage = JSON.stringify(err);
          res.send(obj.meta.code, obj);
        } else {
          obj.data = result;
          res.send(obj);
        }
      });
    } else {
      obj.meta.code = 404;
      obj.meta.errorMessage = "Comment must not empty.";
      res.send(obj.meta.code, obj);
    }
  }
  return {
    timeline : timeline,
    view : view,
    post : post,
    postComment : postComment,
    love : love,
    unlove : unlove,
    timelineUpload : timelineUpload
  }
}
