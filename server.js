const dotenv = require('dotenv').config();
const express = require('express');
const net = require('net');
const cp = require('child_process');
const mkdirp = require('mkdirp');
const fs = require('fs');
const RequestDigest = require('request-digest');
const parseString = require('xml2js').parseString;
const xml = require('xml');
const archiver = require('archiver');

const adminUser = process.env.USERNAME || 'opencast_system_account';
const adminPass = process.env.PASSWORD || 'CHANGE_ME';
const hostname = process.env.HOST || 'octestallinone.virtuos.uos.de';
const protocol = process.env.PROTOCOL || 'https';
const protoPort = protocol === 'https' ? 443 : 80;
const host = `${protocol}://${hostname}`;
const baseDir = process.env.SAVE_PATH || '/opt/recordings';
const pollingTime = +(process.env.POLLING_TIME || 15) * 60 * 1000;
const pollingRange = +(process.env.POLLING_RANGE || 20) * 60 * 1000;
const dc = RequestDigest(adminUser, adminPass);

const startBuffer = +(process.env.ocStartBuffer || 30); //number of seconds to wait for actual CA to start capturing

let queue = {};
let recorders = {};
let users = {};
let ingestQueue = [];

let ocRequest = (url, opts) => {
  opts = opts || {};
  return new Promise((resolve, reject) => {
    let connOptions = {
      host: host,
      path: url,
      port: protoPort,
      method: opts.method || 'GET',
      headers: {
        "User-Agent": "Node fallback CA",
        "X-Requested-Auth": 'Digest'
      }
    }

    if (opts.form) {
      connOptions.formData = opts.form;
    }

    let req = dc.requestAsync(connOptions)
               .then(res => {
                 try {
                   return resolve(JSON.parse(res.body));
                 } catch(e) {
                   return resolve(res.body);
                 }
                 resolve(res.body);
               })
               .catch(err => {
                 reject(err)
               });
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

  getAllRecordings()
    .then(recordings => socket.emit('history', recordings.filter(recording => Object.keys(recorders).indexOf(recording.id) === -1)))
    .catch();

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
  io.emit('agent-check-start');
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
                 let agentAudio = await hasAudio(agent);
                 if (agentAudio) {
                   let buffer = isUpdateLate(agent) ? 1 : (
                                  !isAgentHealthy(agent) ? startBuffer : 0
                                );
                   if (buffer && !queue[agent.mediapackage]) {
                     console.log(`Queuing check for mediapackage ${agent.mediapackage} at ${agent.start}`);
                     let interval = getSecondsToStart(agent.start) + buffer * 1000;
                     queue[agent.mediapackage] = {
                       timer: setTimeout(() => {
                                recordIfNotUp(agent);
                              }, interval),
                       attempts: 0,
                       details: agent
                     };

                     for (let key in users) {
                       users[key].socket.emit('queue-item', agent);
                     }
                   }
                 }
               }
             });
             io.emit('agent-check-end');
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
  return agent.state == 'idle' || agent.state == 'capturing' || agent.state == 'ingesting';
}

function hasAudio(agent) {
  return new Promise(resolve => {
    if (!agent.stream || agent.stream.indexOf('rtsp') === -1) {
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
          stream: (agentState.capabilities.item || [])
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
          io.emit('queue-remove', {remove: info.id, current: Object.keys(queue)});
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
          io.emit('recorder-complete', mpId);
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
  ocRequest(`/assets/episode/${mpId}`, {})
    .then(res => {
      fs.writeFile(`${dir}/baseManifest.xml`, res, err => {
        if (err) {
          return console.log('could not save baseManifest.xml for', mpId);
        }

        parseString(res, (fe, obj) => {
          try {
            ocRequest(obj.mediapackage.metadata[0].catalog[0].url[0].replace('http://localhost:8080', '').replace('http://media.uct.ac.za', ''))
              .then(ep => {
                fs.writeFile(`${dir}/episode.xml`, ep, eerr => {
                  if (eerr) {
                    console.log(eerr);
                  }
                });

                parseString(ep, (se, epMetadata) => {
                  if (epMetadata.dublincore['dcterms:isPartOf']) {
                    let seriesId = epMetadata.dublincore['dcterms:isPartOf'][0];
                    ocRequest(`/series/${seriesId}.xml`)
                      .then(seriesXml => {
                        fs.writeFile(`${dir}/series.xml`, seriesXml, () => {});
                      })
                  }
                });
              })
              .catch(ee => console.log('episode.xml fail', ee));
           
          } catch(e) {
            console.log('problem getting metadata');
          }
        });
      });
    })
    .catch(err => console.log('error mp saving', err));
}

app.get('/rec', async (req, res, next) => {
  try {
    let recs = await getAllRecordings();
    res.json(recs);
  } catch(e) {
    res.status(500).send(e);
  }
});

app.delete('/rec/:id', (req, res) => {
  //TODO: add auth before finishing this
});

app.delete('/agent/:agent/rec/:id', (req, res) => {
  let agent = req.params.agent;
  let id = req.params.id;
  try {
    fs.access(`${baseDir}/${agent}/${id}`, fs.constants.F_OK | fs.constants.W_OK, err => {
      if (err) {
        if (err.code === 'ENOENT') {
          return res.status(404).send('recording does not exist on disk');
        }
        else {
          return res.status(401).send('server is not authorized to delete the event');
        }
      }

      fs.readdir(`${baseDir}/${agent}/${id}`, (err, files) => {
        if (err) {
          return res.status(500).send('Cannot get directory contents');
        }

        const delProms = files.map(file => {
          return new Promise((resolve, reject) => {
            fs.unlink(`${baseDir}/${agent}/${id}/${file}`, fileErr => {
              if (fileErr) {
                return reject(fileErr);
              }

              resolve();
            });
          });
        });

        Promise.all(delProms)
          .then(() => {
            fs.rmdir(`${baseDir}/${agent}/${id}`, dirErr => {
              if (dirErr) {
                return res.status(500).send(dirErr);
              }

              res.status(205).send();

              try {
                getAllRecordings()
                 .then(recordings => {
                   for (let key in users) {
                     users[key].socket.emit('history', recordings);
                   }
                  })
                 .catch(emitErr => console.log('got this emit error', emitErr));
              } catch(e) {
                console.log('get all recordings delete error', e);
              }
            });
          })
          .catch(promErr => res.status(500).send(promErr));
      });
    });
  } catch(e) {
    res.status(500).send();
  }
  //TODO: add auth before finishing this
});

app.put('/agent', (req, res) => {
  res.send();
  getSchedule();
});

app.put('/rec', async (req, res) => {
  res.send();
  io.emit('rec-check-start');
  const recs = await getAllRecordings();
  const proms = recs.map(async rec => {
    try {
      let recordingDir = `${baseDir}/${rec.agent}/${rec.id}`;
      saveMediapackage(rec.id, recordingDir);
      return {id: rec.id, agent: rec.agent, details: await getEventDetailsOnServer(rec.id)};
    } catch (err) {
      if (err.statusCode && err.statusCode === 404) {
        return {id: rec.id, agent: rec.agent, details: ''};
      }
      return {id: rec.id, agent: rec.agent, details: null};
    }
  })
  Promise.all(proms)
    .then(results => {
      results.forEach(result => confirmState(result));
      io.emit('rec-check-end');
    })
    .catch(err => console.log(err));
});

app.post('/rec/:id/ingest', async (req, res) => {
  try {
    let mpId = req.params.id;
    let mp = await getRecordingDetailsById(mpId);
    if (!mp) {
      return res.status(404).send();
    }

    if (!(await isIngestAllowed(mpId))) {
      return res.status(409).send();
    }

    io.emit('ingest-initiated', mpId);
    ingestRecording(mp);
    res.status(202).send();
  } catch(e) {
    console.log(e);
    res.status(500).send();
  }
});

async function confirmState(mp) {
  let state = '';
  let isSameState = false;
  let dirPath =`${baseDir}/${mp.agent}/${mp.id}`; 
  let details = await getRecordingDetails(mp);
//TODO: consider more cases, e.g. backup recorder KNOWS that a saved recording is a failure
  if (!mp.details && typeof mp.details == 'string') {
    state = '.ingestable';
  }
  else if (mp.details.processing_state == 'SUCCEEDED') {
    if (details.files.indexOf('.ingested') > -1) {
      state = '.ingested';
    }
    else {
      state = '.unneeded';
    }
  }
  else if (mp.details.processing_state == 'FAILED') {
    if (details.files.indexOf('.ingested') > -1 || details.files.indexOf('.unusable') > -1) {
      state = '.unusable';
    }
    else {
      state = '.backup';
    }
  }
  details.files
    .filter(file => {
      if (file === state) {
        isSameState = true;
        return false;
      }

      return file.charAt(0) === '.';
    })
    .forEach(file => {
      fs.unlink(`${dirPath}/${file}`, err => {});
    })

  return (isSameState ? null :
     fs.writeFile(`${dirPath}/${state}`, '', err => {
      io.emit('ingest-state', {id: mp.id, state: state.substring(1)});
    })
  );
}

function getAllRecordings() {
  return new Promise(async (resolve, reject) => {
    try {
      const agentDirs = await getAgentDirectories();
      const recMpIds = await getAgentsRecordings(agentDirs);
      const recDetails = await getRecordingDetailsByArray(recMpIds);
      resolve(recDetails);
    } catch(e) {
      reject(e);
    }
  });
}

function getAgentDirectories() {
  return new Promise((resolve, reject) => {
    fs.readdir(baseDir, (e, dirs) => {
      if (e) {
        return reject(e);
      }

      resolve(dirs);
    });
  });
}

function getAgentRecordings(agent) {
  return new Promise((resolve, reject) => {
    fs.readdir(`${baseDir}/${agent}`, (e, recs) => {
      if (e) {
        return reject(e);
      }

      resolve(recs.map(rec => { return {id: rec, agent: agent} }));
    });
  });
}

function getAgentsRecordings(agentArr) {
  return new Promise((resolve, reject) => {
    const proms = agentArr.map(async (agent) => {
      let recs = await getAgentRecordings(agent);
      return recs;
    });

    Promise.all(proms)
      .then(results => {
        results = results
                    .filter(result => result.length)
                    .reduce((all, result) => {
                      return all.concat(result);
                    });
        resolve(results);
      })
      .catch( err => reject(err) );
  });
}

function getRecordingDetails(info) {
  return new Promise((resolve, reject) => {
    let filesDir = `${baseDir}/${info.agent}/${info.id}`;
    fs.readdir(filesDir, async (e, files) => {
      if (e) {
        return reject(e);
      }

      info.files = files;

      let details = await getEventInformation(files, filesDir);
      for (let key in details) {
        info[key] = details[key];
      }

      resolve(info);
    });
  });
}

function getRecordingDetailsByArray(infos) {
  return new Promise((resolve, reject) => {
    const proms = infos.map(async (info) => await getRecordingDetails(info));
    Promise.all(proms)
      .then(results => resolve(results))
      .catch(e => reject(e));
  });
}

function getRecordingDetailsById(id) {
  return new Promise(async (resolve, reject) => {
    if (!id) {
      return reject('no id given');
    }

    let allRecordings = await getAllRecordings();
    resolve(allRecordings
             .filter(rec => rec.id === id)
             .reduce((all, rec) => rec, null));
  });
}

function getEventInformation(files, fileDir) {
  return new Promise(async (resolve, reject) => {
    if (files.indexOf('baseManifest.xml') === -1 && files.indexOf('presenter.mp4') === -1) {
      return reject('no files');
    }

    let info = {};

    info.ingestDate = await new Promise(r => {
      if (files.indexOf('.ingested') === -1) {
        return r(null);
      }

      fs.stat(`${fileDir}/.ingested`, (e, stats) => {
        if (e) {
          return r(null);
        }

        r(stats.mtime);
      });
    });

    info.state = files.filter(file => file.charAt(0) === '.').reduce((res, file) => file.substring(1), null);

    info.startDate = await new Promise(r => {
      let episodeInfo = files.indexOf('baseManifest.xml') === -1 ? 'episode.xml' : 'baseManifest.xml';

      if (files.indexOf(episodeInfo) === -1) {
        return r(null);
      }

      fs.stat(`${fileDir}/${episodeInfo}`, (e, stats) => {
        if (e) {
          return r(null);
        }

        r(stats.birthtime);
      });
    });

    info.endDate = await new Promise(r => {
      if (files.indexOf('presenter.mp4') === -1) {
        return r(null);
      }

      fs.stat(`${fileDir}/presenter.mp4`, (e, stats) => {
        if (e) {
          return r(null);
        }

        r(stats.mtime);
      });
    });

    info.size = await new Promise(r => {
      if (files.indexOf('presenter.mp4') === -1) {
        return r(0);
      }

      fs.stat(`${fileDir}/presenter.mp4`, (e, stats) => {
        if (e) {
          return r(0);
        }

        r(stats.size);
      });
    });

    info.probe = await probeMedia(`${fileDir}/presenter.mp4`);

    let details = await new Promise(r => {
      let episodeInfo = files.indexOf('baseManifest.xml') === -1 ? 'episode.xml' : 'baseManifest.xml';
      if (files.indexOf(episodeInfo) === -1) {
        return r({});
      }

      fs.readFile(`${fileDir}/${episodeInfo}`, (e, data) => {
        if (e) {
          return r({});
        }

        parseString(data, (err, json) => {
          if (err) {
            return r({});
          }

          r({
                  title: json.mediapackage.title[0],
            seriesTitle: (json.mediapackage.seriestitle || [''])[0]
          });
        });
      });
    });

    for (let key in details) {
      info[key] = details[key];
    }

    resolve(info);
  });
}

function probeMedia(filepath) {
  return new Promise((resolve, reject) => {
    cp.exec(`ffprobe ${filepath}`, (e, stdout, stderr) => {
      if (e) {
        return resolve(null);
      }

      let details = stderr.split("\n")
                      .filter(line => {
                        return line.indexOf('Duration') > -1 || (line.indexOf('Stream') > -1 && (line.indexOf('Video') > -1 || line.indexOf('Audio') > -1));
                      })
                      .reduce((all, line) => {
                        if (line.indexOf('Duration:') > -1) {
                          all.duration = ((line.split('Duration: '))[1]).split(',')[0];
                        }
                        if (line.indexOf('Video:') > -1) {
                          all.video = (line.split('Video: '))[1];
                        }
                        if (line.indexOf('Audio:') > -1) {
                          all.audio = (line.split('Audio: '))[1];
                        }
                        return all;
                      }, {});
      resolve(details);
    });
  });
}

function isIngestAllowed(id) {
  return new Promise((resolve, reject) => {
    getEventDetailsOnServer(id)
      .then(currentMp => {
        if (!currentMp.processing_state) {
          return resolve(true);
        }

        resolve(false);
      })
      .catch(err => {
        console.log('got this error', err.statusCode);
        switch(err.statusCode) {
          case 404:
            resolve(true);
            break;

          default:
            resolve(false);
        }
      });
  });
}

function getEventDetailsOnServer(id) {
  return new Promise((resolve, reject) => {
    ocRequest(`/api/events/${id}`)
      .then(mp => resolve(mp))
      .catch(errCode => reject(errCode));
  });
}

async function ingestRecording(mp) {
  try {
    let ingestAttempt = await ingestZippedMediapackage(mp);
    console.log('ingest complete, workflow started', ingestAttempt);
  } catch(e) {
    console.log('caught error at ingestRecording', e);
    io.emit('ingest-failed', {id: mp.id, err: e});
  }
/*
  try {
    let remoteDetails = await getEventDetailsOnServer(mp.id);
    try {
      let trackifiedMp = await addTrack(mp);
      console.log('trackified mp', trackifiedMp);

      let wfOpts = {
        method: 'POST',
          form: {
                  mediaPackage: trackifiedMp,
                }
      }
      let ingest = await ocRequest('/ingest/ingest', wfOpts);
      console.log('ingest complete, workflow started', ingest);
    } catch(trackErr) {
      console.log(trackErr);
    }
  } catch(e) {
    switch (e.statusCode) {
      case 404:
        ingestZippedMediapackage(mp);
        break;

      default:
        io.emit('ingest-failed', {id: mp.id, err: e});
      }
  }
*/
}

async function getManifest(mp) {
  let manifestPath = `${baseDir}/${mp.agent}/${mp.id}/baseManifest.xml`;
  return new Promise((resolve, reject) => {
    fs.readFile(manifestPath, (e, data) => {
      if (e) {
        return reject(e);
      }

      resolve(data)
    });
  });
}

async function addTrack(mp) {
  
  console.log('about to add track');
  try {
    let manifest = await getManifest(mp);

    let opts = {
      method: 'POST',
        form: {
                      flavor: 'presenter/source',
                mediaPackage: manifest.toString(),
                        BODY: fs.createReadStream(`${baseDir}/${mp.agent}/${mp.id}/presenter.mp4`)
              }
    };
    return await ocRequest('/ingest/addTrack', opts);
  } catch(e) {
    console.log(e);
    throw new Error(e);
  }
}

function ingestZippedMediapackage(mp) {
  let duration = mp.probe.duration.split(':')
                   .map(unit => +unit)
                   .reduce((sum, unit, i) => sum + unit * Math.pow(60, 2 - i), 0) * 1000;

  let jsonManifest = {
    mediapackage: [
      {
        _attr: {
          duration: duration,
                id: mp.id,
             xmlns: 'https://mediapackage.opencastproject.org'
        }
      },
      {
        media: [
          {
            track: [
              {
                  _attr: {
                    id: 'track-0',
                  type: 'presenter/source'
                }
              },
              {
                tags: [
                  {tag: 'archive'}
                ]
              },
              {
                mimetype: 'video/mp4'
              },
              {
                url: 'presenter.mp4'
              },
              {
                duration: duration
              }
            ]
          }
        ]
      },
      {
        metadata: [
          {
            catalog: [
              {
                _attr: {
                    id: 'catalog-0',
                  type: 'dublincore/episode'
                }
              },
              {
                tags: [
                  { tag: 'engage' }
                ]
              },
              {
                mimetype: 'text/xml'
              },
              {
                url: 'episode.xml'
              }
            ],
          }
        ]
      }
    ]
  };

  if (mp.seriesTitle) {
    jsonManifest.mediapackage[2].metadata.push(
      {
        catalog: [
          {
            _attr: {
                id: 'catalog-1',
              type: 'dublincore/series'
            }
          },
          {
            tags: [
              { tag: 'engage' }
            ]
          },
          {
            mimetype: 'text/xml'
          },
          {
            url: 'series.xml'
          }
        ],
      }
    );
  }

  let manifest = xml(jsonManifest, {declaration: true });

  return new Promise((resolve, reject) => {
    fs.writeFile(`${baseDir}/${mp.agent}/${mp.id}/manifest.xml`, manifest, async err => {
      if (err) {
        reject(err);
        return console.log("zipped writing error", err);
      }

      // Manifest was written, add it to list of files for mediapackage
      mp.files.push('manifest.xml');

      let zipFilePath = `/tmp/${Math.random().toString(36).substring(2, 8)}.zip`;

      let zippedMp = fs.createWriteStream(zipFilePath);
      let newArchive = archiver('zip');
      zippedMp.on('close', () => {
        let size = fs.lstatSync(zipFilePath).size;
        let bytes = 0;
        console.log('uploading', size);
        let opts = {
          method: 'POST',
            form: {
                          BODY: fs.createReadStream(zipFilePath).on('data', chunk => {
                                  bytes += chunk.length;
                                  io.emit('ingest-progress', {id: mp.id, progress: (bytes/size) * 100 >> 0});
                                })
                  }
        };
        ocRequest('/ingest/addZippedMediaPackage', opts)
          .then(() => {
            console.log('done ingesting zipped mp', mp.id);
            fs.writeFile(`${baseDir}/${mp.agent}/${mp.id}/.ingested`, '', err => {
            });
            io.emit('ingest-state', {id: mp.id, state: 'ingested'});
            fs.unlink(zipFilePath, err => {});
            resolve();
          })
          .catch(err => {
            fs.writeFile(`${baseDir}/${mp.agent}/${mp.id}/.unusable`, '', err => {
            });
            mp.files.filter(file => file.charAt(0) === '.' && file !== '.unusable')
              .forEach(file => fs.unlink(`${baseDir}/${mp.agent}/${mp.id}/${file}`, err => {}));
            io.emit('ingest-state', {id: mp.id, state: 'unusable'});
            console.log('got error', err);
            reject();
          });
      });
      zippedMp.on('end', () => {
        console.log('done receiving data');
      });
      newArchive.on('warning', err => {
        console.log('warning', err);
      });
      newArchive.on('error', err => {
        console.log('error', err);
      });

      newArchive.pipe(zippedMp);

      mp.files.forEach(file => {
        if (file.indexOf('baseManifest') === -1) {
          console.log('adding', file);
          newArchive.append(fs.createReadStream(`${baseDir}/${mp.agent}/${mp.id}/${file}`), {name: file});
        }
      });

      newArchive.finalize();
    });
  });
}

server.listen(12345);

process.on('uncaughtException', e => {
  console.log(e);
  for (let key in recorders) {
    recorders[key].send({event: 'system.fail'});
  }
});

getSchedule();
