var fs = require("fs");
var hawk = require("hawk");
var _  = require("lodash");
var x509 = require('x509');
var async = require("async");
var crypto = require("crypto");
var uuid = require("node-uuid");
var qs = require("querystring");
var request = require("request");
var validUrl = require("valid-url");
var fp = require("ssh-fingerprint");
var spawn = require("child_process").spawn;
var xz = require("xz-pipe");
var formData = require("form-data");

var nodeStates = {
  REQUESTED : "requested",
  CONNECTED : "connected",
  DISABLED : "disabled"
};

var collections = [
  "user",
  "disposition",
  "letter",
  "calendar",
  "contacts",
  "deputy",
  "jobTitle",
  "organization",
  "notification",
  "timeline"
];

/**
 * Nodes manager
 * @param {Object} app root object of this express app 
 */
var Node = function Node(app){
  if (!(this instanceof Node)) return new Node(app);
  if (!app) throw new TypeError("settings required");
  this.app = app;
  this.db = app.db;
  this.ObjectID = app.ObjectID;

  this.Nodes = this.db("node");
  this.Keys = this.db("nodeRequestKey");
  this.NodeSync = this.db("nodeSync");
  this.NodeLocalSync = this.db("nodeLocalSync");
  this.Log = this.db("nodeConnectionLog");
  this.LocalNodes = this.db("nodeLocalNode");
  this.NodeRequests = this.db("nodeRequest");
  this.Users = this.db("user");
  this.Letter = this.db("letter");

}

/**
 * Verifies that the end node is really what it claims to be
 */
Node.prototype.checkNodeCredentials = function(options, fn) {
  var self = this;
  var id = options.installationId;  
  var credentials = options.credentials;
  var digest = options.digest;
  var certFile = "/tmp/cert-" + id + ".pem"; 
  var publicKeyFile = "/tmp/key-" + id + ".pem"; 
  var signatureFile = "/tmp/signature-" +  id + "-" + (new self.ObjectID()) + ".data";

  // Extract public key from certificate
  var preparePublicKey = function(cb) {
    var exec = require("child_process").exec;
    var child = exec("openssl x509 -pubkey -noout -in " + certFile + " > " + publicKeyFile, function(error, stdout, stderr) {
      cb(error);
    });
  }

  var writeSignatureFile = function(cb) {
  // Create signature file
    var writeStream = fs.createWriteStream(signatureFile);
    writeStream.write(new Buffer(digest, "base64"), function() {
      writeStream.end();
      writeStream.close();
      cb();
    });
  }

  var writeCertFile = function(certContents, cb) {
    var writeStream = fs.createWriteStream(certFile);
    writeStream.write(certContents, function() {
      writeStream.end();
      writeStream.close();
      cb();
    });
  }

  var verifyCredentials = function(data, cb) {
    var result = "";
    var ssl = spawn("/bin/sh", ["-c", "openssl dgst -md5 -verify " + publicKeyFile + " -signature " + signatureFile ]);

    var done = function(success) {
      try {
        fs.unlinkSync(signatureFile);
        fs.unlinkSync(certFile);
      } catch(e) {
      }
      cb(null, success);
    }
    ssl.on("error", function() {
      done(false);
    });

    ssl.on("close", function() {
      done(result.indexOf("OK") > 0);
    });

    ssl.stderr.on("data", function(data) {
      console.log("OpenSSL Error", data.toString());
    });

    ssl.stdout.on("data", function(data) {
      result += data.toString();
    });

    ssl.stdin.write(data);
    ssl.stdin.end();
  }

  var _id;
  var error = null;
  try {
    var c = JSON.parse(credentials);
    _id = c._id;
  } catch (e) {
    error = new Error("Malformed credentials");
  }

  if (error) return fn(error);

  self.Nodes.findOne({installationId: id}, function(err, result) {
    if (err) return fn(err);
    if (!result) return fn(new Error("Installation Id is not found"));
    if (!result.publicCert) return fn(new Error("Certificate is not found"));

    writeCertFile(result.publicCert, function(err) {
      preparePublicKey(function(err) {
        if (err) return fn(err);

        writeSignatureFile(function() {
          verifyCredentials(credentials, function(err, result) {
            fn(err, result);
          });
        });
      });
    });
  });
}

/**
 * Wraps request() call
 */
Node.prototype.callMaster = function(options, fn, onData) {
  var self = this;

  var prepareDigest = function(data, cert, cb) {
    var ssl = spawn("/bin/sh", ["-c", "openssl dgst -md5 -sign " + self.app.simaya.privateCertFile ]);
    var digest = new Buffer("");

    ssl.on("error", function() {
      cb("");
    });

    ssl.on("close", function() {
      cb(digest.toString("base64"));
    });

    ssl.stderr.on("data", function(data) {
      console.log("OpenSSL Error", data.toString());
    });

    ssl.stdout.on("data", function(data) {
      digest = Buffer.concat([digest, data]);
    });

    ssl.stdin.write(data);
    ssl.stdin.end();
  }

  if (options && options.headers && options.headers["X-Installation-Id"]) {
    var id = options.headers["X-Installation-Id"];  

    self.LocalNodes.findOne({installationId: id}, function(err, result) {
      if (err) return fn(err);
      if (!result) return fn(new Error("Installation Id is not found"));
      if (!result.cert) return fn(new Error("Certificate is not found"));

      var data = {
        _id: result._id,
        date: new Date
      }
      var data = JSON.stringify(data);
      prepareDigest(data, result.cert, function(digest) {
        options.headers["X-Credentials"] = data;
        options.headers["X-Credentials-Digest"] = digest;
        var r = request(options, fn);
        if (onData) {
          r.on("data", onData);
        }
      });
    });
  } else {
    var r = request(options, fn);
    if (onData) {
      r.on("data", onData);
    }
  }
}

/**
 * Request key for initiating a local node connection
 * @param  {Object}   options [description]
 * @param  {Function} fn      callback
 */
Node.prototype.requestKey = function (options, fn){
  if (!options) throw new TypeError ("settings required");

  var keyHash = new Buffer(uuid.v4()).toString("base64");
  var secretHash = new Buffer(uuid.v4()).toString("base64");

  var secret = "";
  for (var i = 0; i < 10; i++){
    var idx = Math.floor(Math.random() * secretHash.length);
    secret += secretHash[idx];
  }

  var nonce = "";
  for (var i = 0; i < 5; i++){
    var idx = Math.floor(Math.random() * secretHash.length);
    nonce += secretHash[idx];
  }

  var key = {
    key : keyHash,
    secret : secret,
    nonce : nonce,
    date : new Date(),
    administrator : options.administrator
  };

  this.Keys.insert(key, function(err, saved){
    if (err) return fn(err);
    if (saved && Array.isArray(saved)){
      return fn (null, saved[0]);
    }
    fn(null, saved);
  });
}

/**
 * Get request key for attempting a request to `S`
 * @param  {[type]}   options [description]
 * @param  {Function} fn      [description]
 * @return {[type]}           [description]
 */
Node.prototype.getRequestKey = function (options, fn){
  if (!options) throw new TypeError ("settings required");
  var query = {};
  for (var k in options){
    query[k] = options[k];
  }
  this.Keys.findOne({ $query : query, $orderby : {_id : -1} }, fn);
}

/**
 * At local node, create a request to siMAYA to register a node using a certificate
 * @param  {Object}   options: key (required), secret (required)
 */
Node.prototype.request = function(options, fn){

  if (!options) return fn (new Error("settings required"));
  if (!options.name) return fn (new Error("node name is required"));
  if (!validUrl.isUri(options.url)) return fn (new Error("a valid url is required"));

  options.host = options.url.replace(/\/$/, "");
  if (options.url.lastIndexOf("/") == options.url.length - 1){
    options.url += "l/nodes";
  } else {
    options.url += "/l/nodes";
  }

  var self = this;

  fs.readFile(options.file, function(err, content){
    if (err) return fn(err);

    // just in case we have a big file, do it async
    fs.unlink(options.file, function(){

      var certInfo;

      try {
        content = content.toString("utf8");
      } catch(err){
        content = "";
      }

      try {
        certInfo = x509.parseCert(content);  
      } catch(ex){
        certInfo = {};
      }

      if (!certInfo.subject){
        return fn(new Error("no subject"));
      }

      var subjectIdentifier = "";
      if (certInfo.subject){
        for (var k in certInfo.subject){
          subjectIdentifier += certInfo.subject[k] + ";";
        }
      }

      var fingerprint;
      try{
        fingerprint = fp(content);
      } catch (ex){
        fingerprint = "";
      }

      // at local node, it is not allowed to have nodes with a same cert
      self.LocalNodes.findOne({ fingerprint : fingerprint }, function(err, node){
        if (err) return fn(err);
        if (node) return fn(new Error("certificate exists"));

        // do request using hawk header
        var credentials = {
          id : options.key, // this is from the provider
          key : options.secret, // this is from the provider
          algorithm : "sha256"
        };

        var payload = JSON.stringify({
          installationId : self.app.simaya.installationId,
          cert : content, 
          name : options.name 
        });
        var nodeRequestOption = {
          uri : options.url,
          method : "POST",
          headers: {
            "Content-Type" : "application/json"
          },
          body : payload,
          json : true
        }

        var header = hawk.client.header(
        nodeRequestOption.uri, 
        nodeRequestOption.method, 
        { 
          credentials: credentials, 
          ext: "simaya-l",
          timestamp: Date.now(),
          nonce: Date.now().valueOf(),
          app: credentials.id,
          dlg: "simaya-l-registration",
          contentType : "application/json",
          hash : crypto.createHash("sha256").update(payload).digest("base64"),
          payload : payload
        });

        nodeRequestOption.headers.Authorization = header.field;

        self.callMaster(nodeRequestOption, function(err, res, body){
          if (err) return fn(err);
          // error message: body.output.payload.message
          if (res.statusCode != 200 && res.statusCode != 201) return fn(new Error("request failed"));

          // todo: validate the reply from server
          // if (valid){}
          var localNode = {
            installationId : self.app.simaya.installationId,
            uri: options.host,
            name : options.name,
            administrator : body.administrator,
            cert : content,
            fingerprint : fingerprint,
            requestDate : new Date(),
            state : nodeStates.REQUESTED
          };

          self.LocalNodes.insert(localNode, function(err){
            fn (err, localNode);
          });
        });
      });
    });
  });
} 

Node.prototype.processRequest = function(options, fn){
  
  var self = this;
  var credentials = options.credentials || {};
  var payload = options.payload || {};
  
  
  // check the certificate
  try {
    certInfo = x509.parseCert(payload.cert);  
  } catch(ex){
    certInfo = {};
  }

  if (!certInfo.issuer){
    return fn(new Error("no issuer"));
  }

  if (!certInfo.subject){
    return fn(new Error("no subject"));
  }

  var issuerIdentifier = "";
  if (certInfo.issuer){
    for (var k in certInfo.issuer){
      issuerIdentifier += certInfo.issuer[k] + ";";
    }
  }

  var subjectIdentifier = "";
  if (certInfo.subject){
    for (var k in certInfo.subject){
      subjectIdentifier += certInfo.subject[k] + ";";
    }
  }

  var fingerprint;
  try{
    fingerprint = fp(payload.cert);
  } catch (ex){
    fingerprint = "";
  }

  // todo: if subjectIdentifier == identifier in provider's settings (it should be sync fn?)
  this.Nodes.findOne({fingerprint : fingerprint, subject : subjectIdentifier}, function(err, cert){
    if (err) return fn(err);
    if (cert) return fn(new Error("cert is registered for a node")); // todo check it status

    self.NodeRequests.findOne({fingerprint : fingerprint, subject : subjectIdentifier}, function(err, cert){
      if (err) return fn(err);
      if (cert) return fn(new Error("cert is in use for a node request"));

      self.Users.findOne({username : credentials.user}, function(err, administrator){
        if (err) return fn(err);

        if (!administrator) return fn(new Error("administrator not found"));
        if (!administrator.active) return fn(new Error("administrator inactive"));
        if (!administrator.profile.organization) return fn(new Error("administrator organization is not set"));
        if (administrator.roleList.indexOf("localadmin") < 0) return fn(new Error("administrator invalid"));
        
        var nodeRequest = {
          installationId : payload.installationId,
          name : payload.name,
          administrator : credentials.user,
          organization : administrator.profile.organization,
          publicCert : payload.cert,
          fingerprint : fingerprint,
          subject : subjectIdentifier,
          issuer : issuerIdentifier,
          date : new Date()
        };

        self.NodeRequests.insert(nodeRequest, function(err, request){
          if (err) return fn(err);
          if (request && Array.isArray(request)){
            return fn(null, request[0]);
          }
          fn(null, request);
        });

      });
    });
  });
}

/**
 * Get requests list or a request by _id
 * @param  {Object}   options [description]
 * @param  {Function} fn      callback
 */
Node.prototype.localNodes = function(options, fn){
  var self = this;
  if (typeof options == "function"){
    fn = options;
    options = {};
  }
  if (Object.keys(options).indexOf("_id") >= 0){
      return self.LocalNodes.findOne({_id : this.ObjectID(options._id)}, fn);  
  }

  if (Object.keys(options).indexOf("installationId") >= 0){
    var done = function() {
      return self.LocalNodes.findOne({installationId : options.installationId}, fn);  
    }
    self.LocalNodes.findOne({installationId : options.installationId }, function(err, node){
      if (err) return fn(err);
      if (!node) return fn(new Error("Node not found"));

      var requestOptions = {
        uri: (node.uri.replace(/\/$/, "") + "/nodes/check/" + options.installationId),
        headers: {
          "X-Installation-Id": options.installationId 
        }
      }

      self.callMaster(requestOptions, function(err, res, body) {
        if (err) return fn(err);
        if (res.statusCode != 200 && res.statusCode != 201) return fn(new Error("request failed"));

        var result = JSON.parse(body);
        if (result.state != node.state) {
          self.LocalNodes.update({ installationId : options.installationId}, 
              {
                $set: { state: result.state }
              },
              function(err, node){
                if (err) return fn(err);
                done(result);
              });
        } else {
          done(node);
        }
      });
    });

  }
  self.LocalNodes.findArray(options, {sort : {requestDate : -1} }, fn);
} 

/**
 * Get requests list or a request by _id
 * @param  {Object}   options [description]
 * @param  {Function} fn      callback
 */
Node.prototype.nodes = function(options, fn){
  var self = this;
  if (typeof options == "function"){
    fn = options;
    options = {};
  }
  if (Object.keys(options).indexOf("_id") >= 0){
    return self.Nodes.findOne({_id : this.ObjectID(options._id)}, fn);  
  }
  self.Nodes.findArray(options, fn);
} 

/**
 * Get requests list or a request by _id
 * @param  {Object}   options [description]
 * @param  {Function} fn      callback
 */
Node.prototype.nodeRequests = function(options, fn){
  var self = this;
  if (typeof options == "function"){
    fn = options;
    options = {};
  }
  if (Object.keys(options).indexOf("_id") >= 0){
    return self.NodeRequests.findOne(options, fn);  
  }
  self.NodeRequests.findArray(options, fn);
} 


/**
 * Save file certificate
 * @param  {Object}   options [description]
 */
Node.prototype.saveFile = function(options, fn){
  var fileId = new this.ObjectID();
  var store = this.app.store(fileId, options.originalFilename || "certificate", "w");
  store.open(function(err, gridStore){
    if (err) return fn(err);
    gridStore.writeFile(options.path, function(err, written){
      if (err) return fn(err);

      fs.readFile(options.path, function(err, content){
        if (err) return fn(err);
        fs.unlink(options.path, function(err){
          if (err) return fn(err);
          var fingerprint;
          try{
            fingerprint = fp(content.toString());
          } catch(err){
            return fn(err);
          }
          written.fingerprint = fingerprint;
          fn(null, written);
        });
      });
    });
  });
}

Node.prototype.loadFile = function(options, fn){
  var store = this.app.store(this.ObjectID(options.fileId), "", "r");
  store.open(function(err, gridStore){
    if (err && fn) return fn(err);

    var buffer = "";
    
    var gridStream = gridStore.stream(true);

    gridStream.on("data", function(chunk) {
      buffer += chunk;
    });
    
    gridStream.on("error", function(error) {
      if (fn) return fn(error);
    });

    gridStream.on("end", function() {
      if (fn) fn(null, buffer);
    });

    var filename = gridStore.filename || "file.pub";
    filename = filename.substr(0, filename.lastIndexOf("."));
    filename += "_" + options.fileId;
    if (options.stream && options.stream.header){
      options.stream.header("Content-Disposition", "attachment; filename='" + filename + ".pub'");
    }

    if (options.stream){
      gridStream.pipe(options.stream);  
    }

  });
}

/**
 * Set a node to be connected
 * @param  {[type]}   options [description]
 * @param  {Function} fn      [description]
 */
Node.prototype.connect = function(options, fn){
  var self = this;
  var Nodes = this.db("node");
  var NodeRequests = this.db("nodeRequest");
  var NodeLog = this.db("nodeConnectionLog");

  NodeRequests.findOne({_id : this.ObjectID(options._id) }, function(err, node){
    if (err) return fn(err);
    
    if (!node){
      return self.connectFromDisabled(options, fn);
    }

    var connectedNode = {
      installationId : node.installationId,
      name : node.name,
      subject : node.subject,
      issuer : node.issuer,
      administrator : node.administrator,
      organization : node.organization,
      fingerprint : node.fingerprint,
      publicCert : node.publicCert,
      date : options.date || new Date(),
      state : nodeStates.CONNECTED
    }

    Nodes.save(connectedNode, function(err, savedConnectedNode){
      if (err) return fn(err);
      NodeRequests.remove({_id : node._id}, function(err){
        if (err) return fn(err);
        var log = {
          date : new Date(),
          connectionId : savedConnectedNode._id,
          stateFrom : savedConnectedNode.state || nodeStates.REQUESTED,
          stateTo : nodeStates.CONNECTED
        };

        NodeLog.save(log, function(err){
          if (err) return fn(err);
          fn(null, savedConnectedNode);
        });
      });
    });
  });
}

/**
 * Disable node
 * @param  {[type]}   options [description]
 * @param  {Function} fn      [description]
 */
Node.prototype.disable = function(options, fn){
  var Nodes = this.db("node");
  var NodeLog = this.db("nodeConnectionLog");

  Nodes.findOne({_id : this.ObjectID(options._id) }, function(err, node){
    if (err) return fn(err);
    node.state = nodeStates.DISABLED;

    var log = {
      date : new Date(),
      connectionId : node._id,
      stateFrom : nodeStates.CONNECTED,
      stateTo : nodeStates.DISABLED
    };

    NodeLog.save(log, function(err){
      if (err) return fn(err);
      Nodes.save(node, fn);
    });
  });
}

/**
 * Set disabled node to be connected again
 * @param  {[type]}   options [description]
 * @param  {Function} fn      [description]
 * @return {[type]}           [description]
 */
Node.prototype.connectFromDisabled = function(options, fn){

  var Nodes = this.db("node");
  var NodeLog = this.db("nodeConnectionLog");

  Nodes.findOne({_id : this.ObjectID(options._id) }, function(err, node){
    if (err) return fn(err);
    node.state = nodeStates.CONNECTED;

    var log = {
      date : new Date(),
      connectionId : node._id,
      stateFrom : nodeStates.DISABLED,
      stateTo : nodeStates.CONNECTED
    };

    NodeLog.save(log, function(err){
      if (err) return fn(err);
      Nodes.save(node, fn);
    });
  });
}

/**
 * Validate admin
 * @param  {Object}   options [description]
 */
Node.prototype.validAdmin = function(options, fn){
  if (!options) return fn (new Error("user required"));
  var User = this.db("user");
  User.findOne({ username : options.administrator}, function(err, admin){
    if (err) return fn(err);
    if (!admin) return fn(new Error("invalid administrator"));
    if (!admin.active) return fn(new Error("invalid administrator"));
    if (admin.roleList.indexOf("localadmin") < 0) return fn (new Error("invalid administrator"));
    return fn(null, admin);
  });
}

Node.prototype.fillUser = function (options, fn){
  options = options || {};
  var ctx = options.context || this;
  var Users = ctx.Users;
  var username = options.username;
  Users.findOne({username : username}, function(err, user){
    if (err){
      return fn(err);
    }

    var obj = {
      username : user.username,
      profile : user.profile
    }

    fn(null, obj);
  });
}

Node.prototype.group = function(options, fn){

  if (!options) return fn(new Error("requests required"));
  if (!Array.isArray(options)) return fn(new Error("requests should be an array"));

  var self = this;

  var grouped = _.groupBy(options, function(req){
    return req.administrator.username || req.administrator;
  });

  var admins = Object.keys(grouped);
  var users = [];
  for (var i = 0; i < admins.length; i++){
    users.push({ username : admins[i], context : self});
  }

  async.mapSeries(users, self.fillUser, function(err, filled){

    if (err) return fn(err);

    var obj = {};

    for (var i = 0; i < filled.length; i++){
      var admin = filled[i];
      obj[admin.username] = {
        info : filled[i],
        data : _.sortBy(grouped[admin.username], function(group){ return new Date(group.date).valueOf() * -1 })
      }
    }
    fn(null, obj);
  });
}

/**
 * Remove a node
 * @param  {[type]}   options [description]
 * @param  {Function} fn      [description]
 * @return {[type]}           [description]
 */
Node.prototype.remove = function(options, fn){
  var self = this;
  var NodeRequest = this.db(options.collection || "node");
  NodeRequest.findOne({_id : this.ObjectID(options._id)}, function(err, node){
    if (err) return fn(err);
    if (!node) return fn(new Error("not found"));
    NodeRequest.remove({_id : node._id}, fn);
  });
}

/**
 * Save a local node
 * @param  {[type]}   options [description]
 * @param  {Function} fn      [description]
 */
Node.prototype.save = function(options, fn){
  var node = this.db("localNode");
  options.requestDate = options.requestDate || new Date();
  node.update(
    {administrator : options.administrator}, 
    options, 
    {upsert : true}, 
    fn);
}

// a slave registers a sync request to the master
// the master would reply a sync id
Node.prototype.requestSync = function(options, fn) {
  var self = this;
  var installationId = options.installationId;

  self.Nodes.findOne({installationId: installationId}, function(err, result) {
    if (err) return fn(err);
    if (!result) return fn(new Error("Installation ID is not found"));
    self.NodeSync.findOne({installationId: installationId, stage : {$ne: "completed"}}, function(err, sync) {
      if (err) return fn(err);
      
      if (sync && sync.stage != "completed") {
        return fn(null, sync);
      } else {
        var _id = new self.ObjectID();
        var data = {
          _id: _id,
          installationId: options.installationId,
          startDate: new Date(),
          stage: "init",
          manifest: [],
        };
        self.NodeSync.insert(data, function(err, result) {
          fn(null, data);
        });
      }
    });
  });
}

Node.prototype.dump = function(options, fn) {
  var self = this;
  var query = JSON.stringify(options.query).replace(/"ISODate\(([0-9-]+)\)DateISO"/g, "new Date($1)");
  var serverConfig = self.app.dbClient.serverConfig;
  var args = [];
  args.push("-h");
  args.push(serverConfig.host);
  args.push("--port");
  args.push(serverConfig.port);
  args.push("-d" );
  args.push(self.app.dbClient.databaseName);
  args.push("-c" );
  args.push(options.collection);
  if (options.fields) {
    args.push("-f" );
    args.push(options.fields);
  }
  args.push("-q" );
  args.push(query); 

  console.log(args);
  var filename = options.syncId + ":" + options.collection;
  var id = new self.app.ObjectID();
  var data = {
    _id: id,
    filename: filename,
    j: true,
    metadata: {
      type: "sync-collection",
      collection: options.collection,
      syncId: options.syncId
    }
  }
  var writeStream = self.app.grid.createWriteStream(data);
  var child = spawn("mongoexport",args);

  child.stdout.pipe(xz.z()).pipe(writeStream);
  child.stderr.on("data", function(err) {
    console.log(err.toString());
  });
  child.on("close", function(code) {
    fn(data);
  });
}

Node.prototype.restore = function(options, fn) {
  var self = this;
  var isMaster = (options.isMaster == true);
  var syncId = options.syncId;
  var serverConfig = self.app.dbClient.serverConfig;
  var args = [];
  var tmpCollection, targetCollection;

  var findNode = function(installationId, cb) {
    var f = self.Nodes;
    if (options.isMaster == false) f = self.LocalNodes;
    f.findOne({installationId: installationId}, function(err, result) {
      if (result) {
        cb(null, result);
      } else {
        return fn(new Error("Installation Id is not found:", options.installationId));
      }
    });
  }

  var findSync = function(fn) {
    var q = {_id: syncId};
    var f = self.NodeSync;
    if (options.isMaster == false) f = self.NodeLocalSync;
    f.findOne(q, function(err, result) {
      if (result) {
        fn(null, result);
      } else {
        return fn(new Error("Sync Id is not found:" + syncId));
      }
    });
  }

  if (isMaster) {
    tmpCollection = options.collection + syncId; 
    targetCollection = options.collection;
  } else {
    tmpCollection = options.collection;
    targetCollection = tmpCollection;
  }

  args.push("-h");
  args.push(serverConfig.host);
  args.push("--port");
  args.push(serverConfig.port);
  args.push("-d" );
  args.push(self.app.dbClient.databaseName);
  args.push("-c" );
  args.push(tmpCollection);
  args.push("--upsert" );

  console.log(args);
  var data = {
    _id: self.ObjectID(options.id),
  }

  var simpleMove = function(cb) {
    var numRecords = 0;
    var processedRecords = 0;
    var move = function(cursor, mcb) {

      cursor.nextObject(function(err, item) {
        if (err) return fn(err);
        if (!item) return mcb(null);

        var id = item._id;
        delete(item._id);
        destination.update({ _id: id }, { $set: item }, {upsert:1}, function(err) {
          processedRecords ++;
          process.stdout.write("Importing data " + processedRecords + "/" + numRecords + "\r");
          if (err) return fn(err);
          move(cursor, mcb);
        });
      });
    }

    var source = self.db(tmpCollection);
    var destination = self.db(targetCollection);
    source.find({}, function(err, cursor) {
      if (err) return fn(err);
      if (!cursor) return cb(null);
      cursor.count(function(err, count) {
        numRecords = count;
        move(cursor, function() {
          console.log("");
          source.drop(function() {
            // XXX 
            cb(null);
          });
        }); 
      });
    });
  }

  var checks = {};

  checks.restore_organization = function(cb) {
    findSync(function(err, result) {
      if (err) return cb(err);
      findNode(result.installationId, function(err, node) {
        if (err) return cb(err);
        var notLocalOrg = { $regex: "^(?!" + node.organization+ ")\\w+" };
        console.log(notLocalOrg);
        var source = self.db(tmpCollection);
        source.remove({ path: notLocalOrg }, function(err, result) {
          if (err) return cb(err);
          simpleMove(cb);
        });
      });
    });
  }

  var checkData = function() {
    var f = checks["restore_" + targetCollection];
    if (f && typeof(f) === "function") {
      f.call(self, fn);
    } else {
      simpleMove(fn);
    }
  }

  var readStream = self.app.grid.createReadStream(data);
  var child = spawn("mongoimport",args);

  child.stderr.on("data", function(data) {
    console.log("er", data.toString());
  });
  child.stdout.on("data", function(data) {
    console.log("ou",data.toString());
  });

  child.on("exit", function(code, signal) {
    if (code != 0) {
      console.log("Error while importing");
      fn(new Error());
    } else {
      if (isMaster == false) {
        // in local node, trust everything comes from the server
        console.log(">imported");
        fn(null, data);
      } else {
        // in master node, check everything comes from the slave
        console.log(">checking data");
        checkData();
      }
    }
  });
  try {
    readStream.pipe(xz.d()).pipe(child.stdin);
  } catch(e) {
    console.log("Error while importing");
    fn(e);
  }
}


// the master prepares the sync
Node.prototype.prepareSync = function(options, fn) {
  var self = this;
  var funcs = [];
  var lastSyncDate = new Date();
  var lastKnownSyncDate = new Date(-1);
  var installationId;
  var syncId = self.ObjectID(options.syncId + "");

  var done = function(err, result) {
    var f = self.Nodes;
    if (options.isMaster == false) f = self.LocalNodes;
    f.update({
      installationId: installationId,
    }, {
      $set: {
        lastSyncDate: lastSyncDate
      }
    }, function(err, result) {
      fn(err, result);
    });
  }
  var updateSync = function(err, result) {
    var fs = self.db("fs.files");
    var ids = [];
    _.each(result, function(item) {
      if (_.isArray(item)) {
        _.each(item, function(i) {
          ids.push(self.ObjectID(i._id + ""));
        });
      } else {
        ids.push(self.ObjectID(item._id + ""));
      }
    });
    fs.find({ _id: { $in: ids }}, function(err, result) {
      if (err) return done(err, result);
      result.toArray(function(err, manifest) {
        if (err) return done(err, manifest);
        var f = self.NodeSync;
        var data = {
          manifest:manifest,
          stage: "manifest",
        }

        if (options.isMaster == false) {
          var data = {
            localManifest:manifest,
            stage: "local-manifest",
          }

          f = self.NodeLocalSync;
        };
        f.update({
          _id: options.syncId 
        }, {
          $set: data
          }, function(err, updateResult) {
          done(err, updateResult);
        });
      });
    })
  }

  var start = function(startDate, endDate) {
    options.startDate = startDate;
    options.endDate = endDate;
    options.installationId = installationId;
    _.each(collections, function(item) {
      var f = self["prepareSync_" + item];
      if (f && typeof(f) === "function") {
        funcs.push(function(cb) {
          f.call(self, options, cb);
        });
      }
    });
    console.log("Running preparation");
    async.parallel(funcs, function(err, result) {
      console.log("done dumping");
      setTimeout(function() {
        updateSync(err, result);
      }, 5000);
    });
  }

  var findNode = function(installationId) {
    var f = self.Nodes;
    if (options.isMaster == false) f = self.LocalNodes;
    f.findOne({installationId: installationId}, function(err, result) {
      if (result) {
        if (result.lastSyncDate) {
          lastKnownSyncDate = result.lastSyncDate;
        }
        lastKnownSyncDate = new Date(-1);
        var startDate = lastKnownSyncDate;
        var endDate = lastSyncDate;
        start(startDate, endDate);
      } else {
        return fn(new Error("Sync Id is not found:", options.syncId));
      }
    });
  }

  var findSync = function(fn) {
    var q = {_id: syncId};
    var f = self.NodeSync;
    if (options.isMaster == false) f = self.NodeLocalSync;
    f.findOne(q, function(err, result) {
      if (result) {
        fn(null, result);
      } else {
        return fn(new Error("Sync Id is not found:" + syncId));
      }
    });
  }

  findSync(function(err, result) {
    if (err) return done(err);
    if ((options.isMaster && result.stage == "init") ||
      (options.isMaster == false && result.stage == "download")) {
      installationId = result.installationId;
      findNode(result.installationId);
    } else {
      console.log("Stage is not for prepareSync", result.stage);
      fn(err, result);
    }
  });
}

var ISODate = function(date) {
  return "ISODate(" + date.valueOf() + ")DateISO";
}

Node.prototype.prepareSync_notification = function(options, fn) {
  var self = this;
  var startDate = options.startDate;
  var endDate = options.endDate;
  var localId = { $regex: "^u" + options.installationId + ":" };
  var notLocalId = { $regex: "^(?!u" + options.installationId + ":)\\w+" };
  var query = {
    username: localId,
    created_at: { $gte: startDate, $lt: endDate }
  }
  if (options.isMaster == false) {
    query.username = notLocalId;
    query.sender = localId;
  }
  console.log(query);
  queryImport = _.clone(query);
  queryImport.created_at = { $gte: ISODate(startDate), $lt: ISODate(endDate) };

  options.collection = "notification";
  options.query = queryImport;
  this.dump(options, function(data) {
    console.log("Done dumping notification");
    fn(null, data);
  });
}

Node.prototype.prepareSync_letter = function(options, fn) {
  var self = this;
  var startDate = options.startDate;
  var endDate = options.endDate;
  var localId = { $regex: "^u" + options.installationId + ":" };
  var query = {
    $or: [
    { originator: localId },
    { sender: localId },
    { recipients: localId },
    { ccList: localId },
    { reviewers: localId },
    ],
    status: 5,
    modifiedDate: { $gte: startDate, $lt: endDate }
  }
  queryImport = _.clone(query);
  queryImport.modifiedDate = { $gte: ISODate(startDate), $lt: ISODate(endDate) };

  var findContentsAndAttachments = function(query, cb) {

    self.Letter.findArray(query, function(err, result) {
      var files = [];
      _.each(result, function(item) {
        _.each(item.fileAttachments, function(f) {
          files.push({_id: f.path});
        });

        if (item.content && item.content.length > 0) {
          var l = item.content.length;
          files.push({_id: item.content[l-1].file._id});
        }
      });
      cb(files);
    });
  }

  options.collection = "letter";
  options.query = queryImport;
  this.dump(options, function(data) {
    console.log("Done dumping letter");
    findContentsAndAttachments(query, function(result) {
      result.push(data);
      fn(null, result);
    });
  });
}

Node.prototype.prepareSync_user = function(options, fn) {
  var startDate = options.startDate;
  var endDate = options.endDate;
  options.collection = "user";
  options.query = {
    modifiedDate: { $gte: ISODate(startDate), $lt: ISODate(endDate) }
  };
  var notAdmin = { $regex: "^(?!admin)\\w+" };
  var localId = { $regex: "^u" + options.installationId + ":|" + notAdmin };
  if (options.isMaster == false) {
    options.query.username = localId;
  } else {
    options.query.username = notAdmin 
  }
  var opts = _.clone(options);
  opts.fields = "username,profile,active,emailList,roleList,lastLogin,modifiedDate,updated_at,_id";

  this.dump(opts, function(data) {
    console.log("Done dumping user");
    fn(null, data);
  });
}

Node.prototype.prepareSync_organization = function(options, fn) {
  var startDate = options.startDate;
  var endDate = options.endDate;
  options.collection = "organization";
  options.query = {
    modifiedDate: { $gte: ISODate(startDate), $lt: ISODate(endDate) }
  };

  this.dump(options, function(data) {
    console.log("Done dumping organization");
    fn(null, data);
  });
}

Node.prototype.manifestUpdate = function(options, fn) {
  var self = this;
  var syncId = options.syncId;
  var manifest = options.manifest;

  if (manifest && syncId) {
    _.each(manifest, function(item) {
      item._id = self.ObjectID(item._id + "");
    });

    var data = {
      manifest: manifest
    }
    if (options.isMaster == false) {
      data = {
        localManifest: manifest
      }
    }

    self.NodeSync.update({_id: self.ObjectID(syncId + "")}, 
    { $set: data },
    function(err, result) {
      if (err) return fn(err);
      fn(null);
    });
  } else {
    fn(new Error("Invalid arguments"));
  }
}

Node.prototype.manifestReceiveContent = function(options, fn) {
  var self = this;
  var fileId = options.fileId;
  var syncId = options.syncId;
  var file = options.file;

  if (fileId && syncId && file) {
    self.NodeSync.findOne({_id: self.ObjectID(syncId + "")}, function(err, result) {
      if (err) return fn(err);
      if (!result) return fn(new Error("SyncId is not found"));

      var upload = function(item) {
        console.log("upload start", item, file);
        var writeStream = self.app.grid.createWriteStream({
          mode: "w",
          _id: self.ObjectID(item._id + ""),
          filename: "local:" + item.filename ,
          metadata: item.metadata
        });

        var readStream = fs.createReadStream(file.path);
        readStream.on("end", function() {
          writeStream.end();
          console.log("upload done", item);
            fn(null);
          setTimeout(function() {
            // delay the removal
            fs.unlinkSync(file.path);
          }, 5000);
        });
        readStream.on("error", function(error) {
          console.log("Upload error", error);
          fn(new Error(error));
        });

        readStream.pipe(writeStream);
      }

      var found = false;
      var item;
      _.each(result.localManifest, function(i) {
        if (found == false && i._id.toString() == fileId) {
          found = true;
          item = i;
        }
      });
      if (found && item) {
        upload(item);
      } else 
        return fn(new Error("Manifest item is not found"));
    });
  } else {
    fn(new Error("Invalid arguments"));
  }
}

Node.prototype.manifestContent = function(options, fn) {
  var self = this;
  var fileId = options.fileId;
  var syncId = options.syncId;
  var stream = options.stream;

  if (fileId && syncId && stream) {
    self.NodeSync.findOne({_id: self.ObjectID(syncId + "")}, function(err, result) {
      if (!result) return fn(new Error("SyncId is not found"));

      var download = function(id) {
        var readStream = self.app.grid.createReadStream({
          _id: id
        });
        readStream.on("end", function() {
          fn(null);
        });
        readStream.on("error", function(err) {
          fn(new Error(err));
        });
        readStream.pipe(stream);
      }

      var found = false;
      _.each(result.manifest, function(item) {
        if (item._id.toString() == fileId) {
          found = true;
          download(item._id);
        }
      });

      if (!found) return fn(new Error("Manifest item is not found"));
    });
  } else {
    fn(new Error("Invalid arguments"));
  }
}

Node.prototype.checkNode = function(options, fn) {
  var self = this;
  var installationId = options.installationId;

  var findNode = function(cb) {
    self.Nodes.findOne({ installationId : installationId}, 
        {state:1,_id:1},
        function(err, node){
      if (err) return cb(err);
      if (!node) return cb(new Error("Node is not found"));
      cb(null, node);
    });
  }

  if (installationId) {
    findNode(function(err, node) {
      if (err) return fn(err);
      return fn(err, node);
    });
  } else {
    fn(new Error("Invalid argument"));
  }
}


Node.prototype.localCheckNode = function(options, fn) {
  var self = this;
  var installationId = options.installationId;

  var findNode = function(cb) {
    self.LocalNodes.findOne({ installationId : installationId}, function(err, node){
      if (err) return cb(err);
      if (!node) return cb(new Error("Node is not found"));
      cb(null, node);
    });
  }

  var done = function(node) {
    fn(null, {
      _id: node._id,
      state: node.state,
    });
  }

  if (installationId) {
    findNode(function(err, node) {
      if (err) return fn(err);

      var requestOptions = {
        uri: (node.uri.replace(/\/$/, "") + "/nodes/check/" + installationId),
        headers: {
          "X-Installation-Id": installationId 
        }
      }

      self.callMaster(requestOptions, function(err, res, body) {
        if (err) return fn(err);
        if (res.statusCode != 200 && res.statusCode != 201) return fn(new Error("request failed"));

        var result = JSON.parse(body);
        if (result.state != node.state) {
          self.LocalNodes.update({ installationId : installationId}, 
              {
                $set: { state: result.state }
              },
              function(err, node){
            if (err) return fn(err);
            done(result);
          });
        } else {
          done(node);
        }
      });
    });
  } else {
    fn(new Error("Invalid argument"));
  }
}


Node.prototype.sendLocalManifest = function(options, fn) {
  var self = this;
  var syncId = self.ObjectID(options.syncId + "");

  var findNode = function(installationId, cb) {
    self.LocalNodes.findOne({ installationId : installationId}, function(err, node){
      if (err) return cb(err);
      if (!node) return cb(new Error("Node is not found"));
      cb(null, node);
    });
  }

  var findLocalSync = function(cb) {
    self.NodeLocalSync.findOne({ _id: syncId}, function(err, node){
      if (err) return cb(err);
      cb(null, node);
    });
  }

  var send = function(node, sync) {
    var url = (node.uri.replace(/\/$/, "") + "/nodes/sync/manifest/" + syncId.toString());

    var data = {
      url: url,
      method: "POST",
      form: {
        manifest: JSON.stringify(sync.localManifest)
      },
      headers: {
        "X-Installation-Id": sync.installationId 
      }
    };
    self.callMaster(data, function(err, res, body) {
      if (res.statusCode != 200 && res.statusCode != 201) return fn(new Error("request failed"));
      fn(null);
    });
  }

  findLocalSync(function(err, sync) {
    if (err) return fn(err);
    findNode(sync.installationId, function(err, node) {
      if (err) return fn(err);
      send(node, sync);
    });
  });

}
Node.prototype.localSyncNode = function(options, fn) {
  var self = this;
  var installationId = options.installationId;

  var findNode = function(cb) {
    self.LocalNodes.findOne({ installationId : installationId}, function(err, node){
      if (err) return cb(err);
      if (!node) return cb(new Error("Node is not found"));
      cb(null, node);
    });
  }

  var findLocalSync = function(cb) {
    self.NodeLocalSync.findOne({ installationId : installationId, stage: { $ne: "completed"}}, function(err, node){
      if (err) return cb(err);
      cb(null, node);
    });
  }

  var done = function(node) {
    if (!node) return fn(null);
    fn(null, {
      _id: node._id,
      stage: node.stage,
    });
  }

  var insertLocal = function(data, cb) {
    data._id = self.ObjectID(data._id + "");
    data.startDate = new Date(data.startDate);
    data.created_at = new Date(data.created_at);
    self.NodeLocalSync.insert(data,
        function(err, node){
          if (err) return fn(err);
          cb(node);
        });
  }

  var updateLocal = function(data, cb) {
    data.date = new Date();
    delete(data._id);
    self.NodeLocalSync.update({ installationId : installationId}, 
        {
          $set: data
        }, 
        function(err, node){
          if (err) return fn(err);
          cb(node);
        });
  }

  var dispatch = function(localData, remoteData, cb) {
    console.log("dispatch");
    if (!options.disableAutoStart && localData == null && remoteData && remoteData.stage != "completed") {
      console.log("New local sync");
      insertLocal(remoteData, cb);
    } else if ((!localData && remoteData) ||
      (localData && remoteData 
      && localData._id.toString() == remoteData._id.toString() 
      && localData.stage != remoteData.stage)) {
      if (localData)
      console.log("Update sync", localData.stage, remoteData.stage);
      var id = remoteData._id;
      updateLocal(remoteData, function(node) {
        remoteData._id = id;
        cb(remoteData);
      });
    } else {
      console.log("Continue sync");
      cb(localData);
    }
  }

  if (installationId) {
    findNode(function(err, node) {
      if (err) return fn(err);

      var requestOptions = {
        uri: (node.uri.replace(/\/$/, "") + "/nodes/sync/request/" + installationId),
        headers: {
          "X-Installation-Id": installationId 
        }
      }

      self.callMaster(requestOptions, function(err, res, body) {
        if (err) return fn(err);
        if (res.statusCode != 200 && res.statusCode != 201) return fn(new Error("request failed"));

        var remoteData = JSON.parse(body);
        findLocalSync(function(err, localData) {
          dispatch(localData, remoteData, done);
        });
      });
    });
  } else {
    fn(new Error("Invalid argument"));
  }
}

Node.prototype.checkSync = function(options, fn) {
  var self = this;
  var installationId = options.installationId;
  var f = self.NodeSync.findOne;
  if (options.local) {
    f = self.NodeLocalSync.findOne;
  }

  var findNode = function(cb) {
    f({ installationId: installationId, stage: {$ne: "completed" } }, 
        function(err, node){
      if (err) return cb(err);
      if (!node) return cb(null, {});
      cb(null, node);
    });
  }

  if (installationId) {
    findNode(function(err, node) {
      if (err) return fn(err);
      return fn(err, node);
    });
  } else {
    fn(new Error("Invalid argument"));
  }
}

Node.prototype.localUpload = function(options, fn) {
  var self = this;
  var syncId = self.ObjectID(options.syncId + "");
  var fileId = options._id;
  var uri;
  var installationId;

  var findNode = function(cb) {
    self.LocalNodes.findOne({ installationId: installationId }, 
        function(err, node){
      if (err) return cb(err);
      if (!node) return cb(new Error("Node is not found. This site is misconfigured.", installationId));
      uri = node.uri;
      cb(null, node);
    });
  }

  var findLocalSync = function(cb) {
    self.NodeLocalSync.findOne({ _id: syncId}, function(err, node){
      if (err) return cb(err);
      cb(null, node);
    });
  }

  var updateLocal = function(data, cb) {
    self.NodeLocalSync.update({ _id: syncId }, 
      {
        $set: { upload : data }
      }, 
      function(err, node){
        console.log(">", node);
        if (err) return fn(err);
        cb(node);
      });
  }
 
  var upload = function(upload, item) {
    var data = {
      _id: self.ObjectID(item._id + "")
    }

    var url = (uri.replace(/\/$/, "") + "/nodes/sync/manifest/" + syncId.toString() + "/" + fileId);

    var startUpload = function(tmpFile) {
      var data = {
        url: url,
        formData: {
          content: fs.createReadStream(tmpFile)
        },
        headers: {
          "X-Installation-Id": installationId 
        },
        method: "POST"
      }
      var r = self.callMaster(data, function(err, res, body) {
        console.log(err);
        if (res.statusCode != 200 && res.statusCode != 201) return fn(new Error("request failed"));
        updateLocal(upload, function() {
          fn(null, item);
          setTimeout(function() {
            fs.unlinkSync(tmpFile);
          }, 5000);
        });
      });
    }

    var readStream = self.app.grid.createReadStream(data);
    var tmpFile = "/tmp/upload-" + fileId;
    var tmpStream = fs.createWriteStream(tmpFile);
    readStream.on("end", function() {
      tmpStream.end();
      startUpload(tmpFile);
    });

    tmpStream.on("error", function(err) {
      console.log(err);
    });
    readStream.pipe(tmpStream);
  }

  findLocalSync(function(err, sync) {
    if (err) return fn(err);
    if (!sync) return fn(null, {});
    installationId = sync.installationId;
    findNode(function(err) {
      if (err) return fn(err);
      var data = sync.upload || [];

      var found = false;
      var item;
      _.each(data, function(i) {
        if (found == false && fileId == i._id.toString()) {
          found = true;
          i.stage = "completed";
          i.inProgress = false;
          item = i;
        }
      });
      if (found) { 
        upload(data, item);
      } else {
        return fn(new Error("Item is not found in the manifest"));
      }
    });
  });
}

Node.prototype.updateStage = function(options, stage, fn) {
  var self = this;
  var previousStages = {
    download: "manifest",
    "local-manifest": "download",
    "upload": "local-manifest",
    "completed": "upload"
  }
  var uri;
  var installationId;
  var syncId = self.ObjectID(options.syncId + "");
  var isMaster = options.isMaster;

  var findNode = function(cb) {
    self.LocalNodes.findOne({ installationId: installationId }, 
        function(err, node){
      if (err) return cb(err);
      if (!node) return cb(new Error("Node is not found. This site is misconfigured.", installationId));
      uri = node.uri;
      cb(null, node);
    });
  }

  var findLocalSync = function(cb) {
    self.NodeLocalSync.findOne({ _id: syncId}, function(err, node){
      if (err) return cb(err);
      cb(null, node);
    });
  }

  var remoteUpdate = function(cb) {
    var data = {
      stage: stage
    }

    var requestOptions = {
      uri: (uri.replace(/\/$/, "") + "/nodes/sync/stage/" + syncId.toString()),
      headers: {
        "X-Installation-Id": installationId 
      },
      form: data,
      method: "POST"
    }

    self.callMaster(requestOptions, function(err, res, body) {
      if (res.statusCode != 200 && res.statusCode != 201) return fn(new Error("request failed: " + body));
      cb();
    });
  }
 
  var f = self.NodeSync;
  if (isMaster == false) f = self.NodeLocalSync;
  f.update({
    _id: syncId,
    stage: previousStages[stage]
  }, { 
    $set: { stage: stage }
  },
  function(err, node){
    console.log("Updating stage from", previousStages[stage], "to", stage,":", node);
    if (err) return fn(err);
    if (isMaster == false) {
      findLocalSync(function(err, sync) {
        installationId = sync.installationId;
        findNode(function(err) {
          if (err) return fn(err);

          remoteUpdate(function() {
            fn(null, node);
          });
        });
      });
    } else {
      fn(null, node);
    }
  });
}

Node.prototype.localSaveDownload = function(options, fn) {
  var self = this;
  var syncId = self.ObjectID(options.syncId + "");
  var fileId = options._id;
  var uri;
  var installationId;

  var findNode = function(cb) {
    self.LocalNodes.findOne({ installationId: installationId }, 
        function(err, node){
      if (err) return cb(err);
      if (!node) return cb(new Error("Node is not found. This site is misconfigured.", installationId));
      uri = node.uri;
      cb(null, node);
    });
  }

  var findLocalSync = function(cb) {
    self.NodeLocalSync.findOne({ _id: syncId}, function(err, node){
      if (err) return cb(err);
      cb(null, node);
    });
  }

  var updateLocal = function(data, cb) {
    self.NodeLocalSync.update({ _id: syncId}, 
      {
        $set: { download : data }
      }, 
      function(err, node){
        if (err) return fn(err);
        cb(node);
      });
  }
 
  var save = function(download, item, cb) {
    var requestOptions = {
      uri: (uri.replace(/\/$/, "") + "/nodes/sync/manifest/" + syncId.toString() + "/" + fileId),
      headers: {
        "X-Installation-Id": installationId 
      }
    }

    var data = {
      _id: self.ObjectID(item._id + ""),
      mode: "w",
      w: 1
    }
    var writeStream = self.app.grid.createWriteStream(data);
    self.callMaster(requestOptions, function(err, res, body) {
      if (res.statusCode != 200 && res.statusCode != 201) return fn(new Error("request failed"));
      writeStream.end();
      if (item.metadata && item.metadata.type == "sync-collection") {
        setTimeout(function() {
          self.restore({
            isMaster: false,
            syncId: syncId,
            id: item._id,
            collection: item.metadata.collection
          }, function(err, data) {
            if (err) return fn(err);
            updateLocal(download, function() {
              cb(null, item);
            });
          });
        }, 5000);
      } else {
        updateLocal(download, function() {
          cb(null, item);
        });
      }
    }, function(data) {
      writeStream.write(data);
    });
  }

  findLocalSync(function(err, sync) {
    if (err) return fn(err);
    if (!sync) return fn(null, {});
    installationId = sync.installationId;
    findNode(function(err) {
      if (err) return fn(err);
      var download = sync.download || [];

      var found = false;
      var item;
      _.each(download, function(i) {
        if (fileId == i._id.toString()) {
          found = true;
          i.stage = "completed";
          item = i;
        }
      });
      save(download, item, fn);
      if (!found) {
        return fn(new Error("Item is not found in the manifest"));
      }
    });
  });
}

Node.prototype.localNextUploadSlot = function(options, fn) {
  var self = this;
  var syncId = self.ObjectID(options.syncId + "");

  var done = function(data) {
    console.log("next", data);
    fn(null, data);
  }

  var register = function(data, cb) {
    self.NodeLocalSync.update({ _id: syncId}, 
        {
          $set: data
        }, 
        function(err, node){
          if (err) return fn(err);
          cb(node);
        });
  }

  var findLocalSync = function(cb) {
    self.NodeLocalSync.findOne({ _id: syncId}, function(err, node){
      if (err) return cb(err);
      cb(null, node);
    });
  }

 findLocalSync(function(err, sync) {
    if (err) return fn(err);
    if (!sync) return fn(null, {});
    var upload = sync.upload || [];
    var localManifest = sync.localManifest || [];

    var inProgress = null;
    var uploadMap = {};
    // First check the currently uploading process
    _.each(upload, function(d) {
      uploadMap[d._id] = 1;
      if (d.stage == "started") {
        d.inProgress = true;
        inProgress = d;
      }
    });

    var shouldQuit = false;
    if (inProgress) {
      // The uploader is not us, 
      // so it must be invalidated
      shouldQuit = (inProgress.pid == process.pid);
      if (shouldQuit) {
        return done(inProgress);
      }
      delete(uploadMap[inProgress._id]);
    }

    var data = {};
    var changed = false;
    _.each(localManifest, function(m) {
      // If no upload has been started, 
      // start one
      if (!changed && !uploadMap[m._id]) {
        changed = true;
        data = {
          date: new Date,
          _id: self.ObjectID(m._id + ""),
          stage: "started",
          pid: process.pid,
          metadata: m.metadata,
        }
        upload.push(data);
      }
    });
    if (changed) {
      var savedData = {
        upload: upload 
      }

      // Record that we're uploading
      register(savedData, function() {
        data.syncId = self.ObjectID(sync._id + "");
        done(data);
      });
    } else {
      console.log("No uploadable");
      // No uploadable
      done({});
    }
  });
}

Node.prototype.localNextDownloadSlot = function(options, fn) {
  var self = this;
  var syncId = self.ObjectID(options.syncId + "");

  var done = function(data) {
    fn(null, data);
  }

  var register = function(data, cb) {
    self.NodeLocalSync.update({ _id: syncId}, 
        {
          $set: data
        }, 
        function(err, node){
          if (err) return fn(err);
          cb(node);
        });
  }

  var findLocalSync = function(cb) {
    self.NodeLocalSync.findOne({ _id: syncId}, function(err, node){
      if (err) return cb(err);
      cb(null, node);
    });
  }

 findLocalSync(function(err, sync) {
    if (err) return fn(err);
    if (!sync) return fn(null, {});
    var download = sync.download || [];
    var manifest = sync.manifest || [];

    var inProgress = null;
    var downloadMap = {};
    // First check the currently downloading process
    _.each(download, function(d) {
      downloadMap[d._id] = 1;
      if (d.stage == "started") {
        d.inProgress = true;
        inProgress = d;
      }
    });

    var shouldQuit = false;
    if (inProgress) {
      // The downloader is not us, 
      // so it must be invalidated
      shouldQuit = (inProgress.pid == process.pid);
      if (shouldQuit) {
        return done(inProgress);
      }
      delete(downloadMap[inProgress._id]);
    }

    var data = {};
    var changed = false;
    _.each(manifest, function(m) {
      // If no download has been started, 
      // start one
      if (!changed && !downloadMap[m._id]) {
        changed = true;
        data = {
          date: new Date,
          _id: self.ObjectID(m._id + ""),
          stage: "started",
          pid: process.pid,
          metadata: m.metadata,
        }
        download.push(data);
      }
    });
    if (changed) {
      var savedData = {
        download: download 
      }

      // Record that we're downloading
      register(savedData, function() {
        data.syncId = self.ObjectID(sync._id + "");
        done(data);
      });
    } else {
      console.log("No downloadable");
      // No downloadable
      done({});
    }
  });
}

Node.prototype.localFinalizeSync = function(options, fn) {
  var self = this;
  var syncId = self.ObjectID(options.syncId + "");

  var findNode = function(installationId, cb) {
    self.LocalNodes.findOne({ installationId : installationId}, function(err, node){
      if (err) return cb(err);
      if (!node) return cb(new Error("Node is not found"));
      cb(null, node);
    });
  }

  var findLocalSync = function(cb) {
    self.NodeLocalSync.findOne({ _id: syncId}, function(err, node){
      if (err) return cb(err);
      cb(null, node);
    });
  }

  var send = function(node, sync) {
    var url = (node.uri.replace(/\/$/, "") + "/nodes/sync/finalize/" + syncId.toString());

    var data = {
      url: url,
      headers: {
        "X-Installation-Id": sync.installationId 
      }
    };
    self.callMaster(data, function(err, res, body) {
      if (err) return fn(err);
      if (res.statusCode != 200 && res.statusCode != 201) return fn(new Error("request failed"));
      self.NodeLocalSync.update({ _id: syncId}, 
      { $set: {stage: "completed"} }
      , function(err, node){
        fn(null);
      });
    });
  }

  findLocalSync(function(err, sync) {
    if (err) return fn(err);
    findNode(sync.installationId, function(err, node) {
      if (err) return fn(err);
      send(node, sync);
    });
  });


};

Node.prototype.finalizeSync = function(options, fn) {
  var self = this;
  var syncId = self.ObjectID(options.syncId + "");

  var findSync = function(cb) {
    self.NodeSync.findOne({ _id: syncId}, function(err, node){
      if (err) return cb(err);
      cb(null, node);
    });
  }

  findSync(function(err, sync) {
    if (err) return fn(err);
    if (!sync) return fn(null, {});
    var manifest = sync.localManifest || [];

    var funcs = [];
    _.each(manifest, function(item) {
      if (item.metadata && item.metadata.type == "sync-collection") {
        var id = item._id;
        var collection = item.metadata.collection;
        funcs.push(function(cb) { 
          self.restore({
            isMaster: true,
            id: id,
            syncId: syncId,
            collection: collection
          }, cb);
        });
      }
    });
    async.series(funcs, function(err, result) {
      if (err){
        console.log(err);
        return fn(err);
      }
      console.log("Done extracting");
      self.updateStage(options, "completed", function(err) {
        if (err) return fn(err);
        console.log("Sync is done");
        fn(null);
      });
    });
  });
}


module.exports = function(app) { 
  return Node(app);
}
