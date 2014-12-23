module.exports = register;
function userCategory(app) {
  if (!(this instanceof userCategory)) return new userCategory(app);
  this.db = app.db('userCategory');

  /* this.db.validate = function(document, update, callback) { */
  /*   var validator = app.validator(document, update); */
    
  /*   validator.validateRegex({ */
  /*     idLength: [/^[0-9]{1,10}$/, 'Invalid Id Length'], */
  /*   }); */
    
  /*   if (validator.isInserting()) { */
  /*     validator.validateQuery({ */
  /*       categoryName: [db, {categoryName: update.categoryName}, false, 'There is already a category with this name'] */
  /*     }, function () { */
  /*       callback(null, validator); */
  /*     }); */
  /*   } else { */
  /*     callback(null, validator); */
  /*   } */
  /* } */
}
userCategory.prototype.insert = function (data, callback) {
  var self = this;
  self.db.getCollection(function (error, collection) {
    self.db.findOne({categoryName: data.categoryName}, function(err, item) {
      if (item && item != null) {
          var error = {
            categoryName : "already exist"
          }
          callback(error);
      } else if (data.categoryId && data.idLength && (parseInt(data.idLength) % 1) != 0) {
          var error = {
            idLength : "invalid idLength"
          }
          callback(error);
      } else {
        data._id = collection.pkFactory.createPk();
        self.db.insert(data, function (error, validator) {
          callback(null);
        }); 
      }
    });
  });
}
userCategory.prototype.edit = function(oldCategoryName, data, callback) {
  var self = this;
  self.db.findOne({categoryName: oldCategoryName}, function(err, item) {
    if (err == null && item != null) {
      if (data.categoryId && data.idLength && (parseInt(data.idLength) % 1) != 0) {
        var error = {
          idLength : "invalid idLength"
        }
        callback(error);
      } else {
        self.db.update({
          _id: item._id
        }, {
          '$set': data
        }, function(err) {
          callback(err);
        });
      }
    } else {
      var error = {
        categoryName : "non-existant category"
      }
      callback(error);
    }
  });
}
userCategory.prototype.remove = function (categoryName, callback) {
  var self = this;
  self.db.remove({categoryName : categoryName}, function(error){
    callback(error == null);
  });
},

userCategory.prototype.list = function (callback) {
  var self = this;
  var search = {};
  if (arguments.length == 2) {
    search = arguments[0];
    callback = arguments[1];
  }
  self.db.findArray(search, function(error, result) {
    callback(result);
  });
}


function register (app){
  return userCategory(app);
}
