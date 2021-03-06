var engine = require('engine.io');
var EventEmitter = require('events').EventEmitter;
var Socket = engine.Socket;
var formatter = require('./formatter');

var Response = function (socket, id) {
  this.socket = socket;
  this.id = id;
  this.sent = false;
};

Response.prototype._respond = function (responseData) {
  if (this.sent) {
    throw new Error('Response ' + this.id + ' has already been sent');
  } else {
    this.sent = true;
    this.socket.send(formatter.stringify(responseData));
  }
};

Response.prototype.end = function (data) {
  if (this.id) {
    var responseData = {
      cid: this.id
    };
    if (data !== undefined) {
      responseData.data = data;
    }
    
    this._respond(responseData);
  }
};

Response.prototype.error = function (error, data) {
  if (this.id) {
    var err;
    if (error instanceof Error) {
      err = {name: error.name, message: error.message, stack: error.stack};      
    } else {
      err = error;
    }
    
    var responseData = {
      cid: this.id,
      error: err
    };
    if (data !== undefined) {
      responseData.data = data;
    }
    
    this._respond(responseData);
  }
};

Response.prototype.callback = function (error, data) {
  if (error) {
    this.error(error, data);
  } else {
    this.end(data);
  }
};

var SCSocket = function (id, server, transport, req, authData) {
  var self = this;
  
  this._localEvents = {
    'open': 1,
    'error': 1,
    'packet': 1,
    'heartbeat': 1,
    'data': 1,
    'raw': 1,
    'message': 1,
    'upgrade': 1,
    'close': 1,
    'packetCreate': 1,
    'flush': 1,
    'drain': 1,
    'disconnect': 1
  };
  
  this._autoAckEvents = {
    'ready': 1,
    'publish': 1
  };
  
  Socket.call(this, id, server, transport, req);
  
  this._cid = 1;
  this._callbackMap = {};
  this._messageHandlers = [];
  this._closeHandlers = [];
  
  this._authToken = authData.token || null;
  
  this.addMessageHandler(function (message) {
    var e = formatter.parse(message);
    
    if (e.event) {
      if (self._localEvents[e.event] == null) {
        var response = new Response(self, e.cid);
        server.verifyEvent(self, e.event, e.data, function (err) {
          if (err) {
            response.error(err);
          } else {
            if (self._autoAckEvents[e.event]) {
              response.end();
              EventEmitter.prototype.emit.call(self, e.event, e.data);
            } else {
              EventEmitter.prototype.emit.call(self, e.event, e.data, function (error, data) {
                response.callback(error, data);
              });
            }
          }
        });
      }
    } else if (e.cid == null) {
      EventEmitter.prototype.emit.call(self, 'raw', message);
    } else if (e != null) {
      var ret = self._callbackMap[e.cid];
      if (ret) {
        clearTimeout(ret.timeout);
        delete self._callbackMap[e.cid];
        ret.callback(e.error, e.data);
      }
    } else {
      var err = new Error('Received empty message');
      EventEmitter.prototype.emit.call(self, 'error', err);
    }
  });
  
  // Emit initial status to client
  this.emit('ready', {
    id: id,
    isAuthenticated: !!this._authToken,
    authError: authData.error
  });
  
  this._readyStateMap = {
    'opening': this.CONNECTING,
    'open': this.OPEN,
    'closing': this.CLOSING,
    'closed': this.CLOSED
  };
};

SCSocket.prototype = Object.create(Socket.prototype);

SCSocket.CONNECTING = SCSocket.prototype.CONNECTING = 'connecting';
SCSocket.OPEN = SCSocket.prototype.OPEN = 'open';
SCSocket.CLOSING = SCSocket.prototype.CLOSING = 'closing';
SCSocket.CLOSED = SCSocket.prototype.CLOSED = 'closed';

SCSocket.prototype._nextCallId = function () {
  return this._cid++;
};

SCSocket.prototype.getState = function () {
  var state = this._readyStateMap[this.readyState];
  if (state == null) {
    return this.CLOSED;
  }
  return state;
};

SCSocket.prototype._onMessage = function (message) {
  for (var i in this._messageHandlers) {
    this._messageHandlers[i](message);
  }
};

SCSocket.prototype.onClose = function (reason) {
  if (reason == 'ping timeout') {
    this.emit('pingTimeout');
  }
  if (this.readyState != this.CLOSED) {
    for (var i in this._closeHandlers) {
      this._closeHandlers[i].apply(this, arguments);
    }
  }
  Socket.prototype.onClose.apply(this, arguments);
};

SCSocket.prototype.disconnect = function () {
  return Socket.prototype.close.apply(this);
};

SCSocket.prototype.addMessageHandler = function (callback) {
  this._messageHandlers.push(callback);
};

SCSocket.prototype.addCloseHandler = function (callback) {
  this._closeHandlers.push(callback);
};

SCSocket.prototype.sendObject = function (object) {
  Socket.prototype.send.call(this, formatter.stringify(object));
};

SCSocket.prototype.emit = function (event, data, callback) {
  var self = this;
  
  if (this._localEvents[event] == null) {
    var eventObject = {
      event: event
    };
    if (data !== undefined) {
      eventObject.data = data;
    }
    eventObject.cid = this._nextCallId();
    
    if (callback) {
      var timeout = setTimeout(function () {
        var error = new Error("Event response for '" + event + "' timed out");
        delete self._callbackMap[eventObject.cid];
        callback(error, eventObject);
      }, this.server.ackTimeout);
      
      this._callbackMap[eventObject.cid] = {callback: callback, timeout: timeout};
    }
    this.sendObject(eventObject);
  } else {
    if (event == 'message') {
      this._onMessage(data);
    }
    EventEmitter.prototype.emit.call(this, event, data);
  }
};

SCSocket.prototype.setAuthToken = function (data, options, callback) {
  this._authToken = data;
  var signedToken = this.server.auth.signToken(data, options);
  this.emit('setAuthToken', signedToken, callback);
};

SCSocket.prototype.getAuthToken = function () {
  return this._authToken;
};

SCSocket.prototype.removeAuthToken = function (callback) {
  this._authToken = null;
  this.emit('removeAuthToken', null, callback);
};

module.exports = SCSocket;