module.exports = register;
function userCategory(app) {
  if (!(this instanceof AuditTrail)) return new AuditTrail(app);
  this.db = app.db('userCategory');

  this.db.validate = function(document, update, callback) {
    var validator = app.validator(document, update);
    
    validator.validateRegex({
      idLength: [/^[0-9]{1,10}$/, 'Invalid Id Length'],
    });
    
    if (validator.isInserting()) {
      validator.validateQuery({
        categoryName: [db, {categoryName: update.categoryName}, false, 'There is already a category with this name']
      }, function () {
        callback(null, validator);
      });
    } else {
      callback(null, validator);
    }
  }
}
userCategory.prototype.insert = function (data, callback) {
  var self = this;
  self.db.getCollection(function (error, collection) {
    data._id = collection.pkFactory.createPk();
    self.db.validateAndInsert(data, function (error, validator) {
      callback(validator);
    }); 
  });
}
userCategory.prototype.edit = function(oldCategoryName, data, callback) {
  var self = this;
  self.db.findOne({categoryName: oldCategoryName}, function(err, item) {
    if (err == null && item != null) {
      self.db.validateAndUpdate({
        _id: item._id
      }, {
        '$set': data
      }, function(err, validator) {
        callback(validator);
      });
    } else {
      var doc = data; 
      var validator = app.validator(doc, doc);
      validator.addError('categoryName', 'Non-existant category');
      callback(validator);
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
