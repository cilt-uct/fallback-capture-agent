const cp = require('child_process');
const mkdirp = require('mkdirp');

function RecorderService(opts) {
  opts = opts || {};

  if (!opts.mediapackage) {
    throw new Error('no mediapackage defined');
  }

  if (!opts.stream) {
    throw new Error('no stream defined');
  }

  this.mediapackage = opts.mediapackage;
  this.stream = opts.stream;
  this.title = opts.title;
  this.agent = opts.name;
  this.directory = `/opts/fallback_recordings/${this.agent}/`;
  this.recorder = cp.fork('./record.js');

  let _listeners = {};
  Object.defineProperty(this, 'listener', {
    get: function() {
      return _listeners;
    }
  });
}

RecorderService.prototype = {
  constructor: RecorderService,
  on: function(ev, fnObj) {
    if (!this.listeners[ev]) {
      this.listeners[ev]
    }

    let token = null;
    do {
      token = (Math.random() + 1).toString(36).substring(2, 10);
    } while (Object.keys(this.listeners[ev]).indexOf(token) > -1);

    fnObj = typeof fnObj == 'function' ? {fn: fnObj, scope: null} : fnObj;

    this.listeners[ev][token] = {
      scope: fnObj.scope,
         fn: fnObj.fn
    }

    return token;
  },
  emit: function() {
    let args = Array.prototype.slice.call(arguments);
    let ev = args[0];
    params = args.slice(1);

    for (let key in this.listeners[ev]) {
      let fn = this.listeners[ev][key].fn;
      let scope = this.listeners[ev][key].scope;
      fn.apply(scope, params);
    }
  },
  forkEvents: function() {
    this.recorder.on('message', msg => {
      if (msg.event) {
        switch(msg.event) {
          case 'started':
          break;

          case 'record.ready':
            fork.send({event: 'record.start'});
            if (Object.keys(users).length) {
              fork.send({event: 'notify.start'});
            }
            break; 

          case 'record.fail':
            console.log(msg.error, msg.payload);
            break;

          case 'record.complete':
            fork.kill();
            let mpId = msg.payload.mediapackage;
            console.log(mpId, 'recording completed');
            if (queue[mpId]) {
              clearTimeout(queue[mpId].timer);
              delete queue[mpId];
            }
            if (recorders[mpId]) {
              delete recorders[mpId];
            }
            break;

          case 'notify':
            io.emit('progress', msg.payload);
            break;

          case 'state':
            io.emit('state', msg.payload);
            break;

          case 'details.response':
            let id = msg.payload.mediapackage;
            let awaitingUsers = {...(io.sockets.adapter.rooms['recording-' + id] || {sockets: {}}).sockets};
            for (let key in awaitingUsers) {
              users[key].socket.emit('recorder-item', msg.payload);
              users[key].socket.leave(id);
            }
          
            break;
        }
      }
    });
  }
}

module.exports = RecorderService;
