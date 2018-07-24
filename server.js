const dotenv = require('dotenv').config();
const express = require('express');
const net = require('net');
const cp = require('child_process');
const mkdirp = require('mkdirp');
const fs = require('fs');
const RequestDigest = require('request-digest');

const adminUser = process.env.USER || 'opencast_system_account';
const adminPass = process.env.PASSWORD || 'CHANGE_ME';
const hostname = process.env.HOST || 'octestallinone.virtuos.uos.de';
const protocol = process.env.PROTOCOL || 'https';
const host = `${protocol}://${hostname}`;
const baseDir = process.env.SAVE_PATH || '/opt/recordings';
const pollingTime = +(process.env.POLLING_TIME || 15) * 60 * 1000;
const pollingRange = +(process.env.POLLING_RANGE || 20) * 60 * 1000;
const dc = RequestDigest(adminUser, adminPass);

const startBuffer = +(process.env.ocStartBuffer || 30); //number of seconds to wait for actual CA to start capturing

let queue = {};
let recorders = {};
let users = {};

let ocRequest = (url, opts) => {
  opts = opts || {};
  return new Promise((resolve, reject) => {
    dc.requestAsync({
      host: host,
      path: url,
      port: 443,
      method: 'GET',
      headers: {
        "User-Agent": "Node fallback CA",
        "X-Requested-Auth": 'Digest'
      }
    })
    .then(res => {
      try {
        return resolve(JSON.parse(res.body));
      } catch(e) {
        return resolve(res.body);
      }
      resolve(res.body);
    })
    .catch(err => {console.log('failed response to', url); reject()});
  });
};

const app = express();
const server = require('http').Server(app);
const io = require('socket.io')(server);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(express.static('public'));

io.on('connection', socket => {
  users[socket.id] = {socket: socket};

  socket.emit('queue', Object.keys(queue).map(schedule => queue[schedule].details));
  socket.emit('recorders', Object.keys(recorders));

  socket.on('recording-query', mpId => {
    if (!recorders[mpId]) {
      return;
    }

    socket.join(`recording-${mpId}`, () => {
      recorders[mpId].send({event: 'details.request'});
    });
  });

  for (let key in recorders) {
    recorders[key].send({event: 'notify.start'});
  }

  socket.on('disconnect', () => {
    if (users[socket.id]) {
      delete users[socket.id];
    }
    if (!Object.keys(users)) {
      for (let key in recorders) {
        recorders[key].fork.send({event: 'notify.stop'});
      }
    }
  });
});

setInterval(() => {
  getSchedule();
}, pollingTime);

function getSchedule() {
  let getScheduled = `/admin-ng/event/events.json/?filter=status:EVENTS.EVENTS.STATUS.SCHEDULED,startDate:${encodeURIComponent(getCurrentDateTimeRange())}`;
  ocRequest(getScheduled, {})
    .then(res => {
      let agents = res.results
                     .filter(event => event.agent_id && !queue[event.id]);
      let getInfoArr = [];
      agents.forEach(agent => getInfoArr.push(getAgentInfo(agent)));
      Promise.all(getInfoArr)
        .then(values => {
           values
             .filter(agent => !!agent)
             .forEach(async (agent) => {
               if (!queue[agent.mediapackage]) {
                 let agentAudio = agent.stream ? await hasAudio(agent) : false;
                 if (agentAudio) {
                   let buffer = isUpdateLate(agent) ? 1 : (
                                  !isAgentHealthy(agent) ? startBuffer : 0
                                );
                   if (buffer) {
                     console.log(`Queuing check for mediapackage ${agent.mediapackage} at ${agent.start}`);
                     let interval = getSecondsToStart(agent.start) + buffer * 1000;
                     queue[agent.mediapackage] = {
                       timer: setTimeout(() => {
                                recordIfNotUp(agent);
                              }, interval),
                       attempts: 0,
                       details: agent
                     };
                   }

                   for (let key in users) {
                     users[key].socket.emit('queue-item', agent);
                   }
                 }
                 else {
                   console.log(`${agent.stream} does not have an audio stream attached. Skipping recording/checking...`);
                 }
               }
           });
         })
        .catch(err => console.log('all error', err));
    })
    .catch(err => console.log('error', err));
}

function getCurrentDateTimeRange() {
  let now = new Date();
  let later = new Date(now.getTime() + pollingRange);
  return ISO8601(now) + '/' + ISO8601(later);
}

function isAgentHealthy(agent) {
  return agent.state == 'idle' || agent.state == 'capturing';
}

function hasAudio(agent) {
  return new Promise(resolve => {
    if (!agent.stream) {
      console.log(`${agent.name} has no stream property`);
      return resolve(false);
    }
    if (agent.stream.indexOf('rtsp') === -1) {
      agent.stream = `rtsp://${agent.name}-cam01.uct.ac.za/axis-media/media.amp`;
    }
    cp.exec(`ffprobe -loglevel quiet -show_streams ${agent.stream} | grep codec_type=audio`, (err, res) => {
      if (err) {
        return resolve(false);
      }

      if (res) {
        return resolve(true);
      }

      resolve(false);
    });
  });
}

function getAgentInfo(info) {
  return new Promise(resolve => {
    ocRequest(`/capture-admin/agents/${info.agent_id}.json`)
      .then(res => {
        let agentState = res['agent-state-update'];
        resolve({
          mediapackage: info.id,
          start: info.technical_start,
          end: info.technical_end,
          title: info.title,
          name: agentState.name,
          state: agentState.state,
          ip: agentState.url,
          lastUpdate: agentState['time-since-last-update'],
          stream: agentState.capabilities.item
                    .filter(item => item.key == 'capture.device.presenter.src')
                    .map(item => item.value)
                    .reduce((collect, item) => collect = item, null)
        });
      })
      .catch(err => resolve(null));
  });
}

function isUpdateLate(info) {
  return info.lastUpdate > 5 * 60 * 1000;
}

function ISO8601(dateObj) {
  let year = dateObj.getUTCFullYear();
  let month = dateObj.getUTCMonth() + 1;
  let day = dateObj.getUTCDate();
  let hours = dateObj.getUTCHours();
  let minutes = dateObj.getUTCMinutes();
  let seconds = dateObj.getUTCSeconds();
  return `${year}-${(month < 10 ? '0' : '') + month}-${(day < 10 ? '0' : '') + day}T` +
         `${(hours < 10 ? '0' : '') + hours}:${(minutes < 10 ? '0' : '') + minutes}:${(seconds < 10 ? '0' : '') + seconds}.000Z`;
}

function checkIsUp(agent) {
  let client = new net.Socket();
  return new Promise((resolve, reject) => {
    try {
      client.connect(22, agent.ip, () => {
        client.destroy();
        agent.isUp = true;
        resolve(agent);
      });
    } catch(e) {
      agent.isUp = false;
      resolve(agent);
    }
  });
}

function checkAgentState(agent) {
  return new Promise((resolve, reject) => {
    agent.isOnline = agent.state !== 'offline';
    agent.isCapturing = agent.state == 'capturing';
    resolve(agent);
  });
}

function getSecondsToStart(dateString) {
  let now = new Date();
  let start = new Date(dateString);
  return start.getTime() - now.getTime();
}

function recordIfNotUp(info) {
  console.log('starting CA check...');
  if (!recorders[info.id]) {
    checkAgentState(info)
      .then(agent => {
        if (!agent.isOnline && !recorders[agent.mediapackage]) {
          console.log('CA', agent.name, 'is not up');
          recorders[agent.mediapackage] = cp.fork('./record.js');
          recorders[agent.mediapackage].on('message', msg => {
            if (msg === 'started') {
              if (!agent.duration) {
                agent.duration = getDuration(agent);
              }
              recorders[agent.mediapackage].send({event: 'state', payload: agent});
            }
          });
          attachEvents(recorders[agent.mediapackage]);

          let recordingDir = `${baseDir}/${agent.name}/${agent.mediapackage}`;
          mkdirp(recordingDir, err => {
            if (err) {
              return console.log(err);
            }

            recorders[agent.mediapackage].send({event: 'directory', payload: {value: recordingDir}});
            saveMediapackage(agent.mediapackage, recordingDir);
          });
          for (let key in users) {
            users[key].socket.emit('recorder-item', agent);
          }
        }
        else {
          io.emit('queue.remove', {remove: info.id, current: Object.keys(queue)});
          if (!queue[info.id]) {
            return;
          }

          clearTimeout(queue[info.id].timer);
          delete queue[info.id];
        }
      });
  }
}

function attachEvents(fork) {
  fork.on('message', msg => {
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

function getDuration(info) {
  let start = new Date(info.start);
  let end = new Date(info.end);
  let durationSecs = parseInt((end.getTime() - start.getTime())/1000);
  let durationArr = [parseInt(durationSecs/3600), parseInt((durationSecs%3600)/60), parseInt(durationSecs%60)];
  return durationArr
           .map(unit => (unit < 10 ? '0' : '') + unit)
           .join(':');
}

function saveMediapackage(mpId, dir) {
  console.log('Saving mediapackage', mpId);
  ocRequest(`/assets/episode/${mpId}`)
    .then(res => {
      fs.writeFile(`${dir}/episode.xml`, res, err => {
        if (err) {
          return console.log('could not save episode.xml for', mpId);
        }
      });
    })
    .catch(err => console.log('error mp saving', err));
}

server.listen(12345);

process.on('uncaughtException', e => {
  console.log(e);
  for (let key in recorders) {
    recorders[key].send({event: 'system.fail'});
  }
});

getSchedule();
