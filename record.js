const cp = require('child_process');
let state = {};
let ffmpeg = null;
let notify = false;

process.on('message', msg => {
  if (msg.event) {
    switch (msg.event) {
      case 'ping':
        process.send({event: 'pong'});
        break;

      case 'state':
        let dir = state.directory;
        state = msg.payload;
        if (dir) {
          state.directory = dir;
        }
        notifyIfReady();
        break;

      case 'record.start':
        if (!state.duration || !state.directory || !state.stream) {
          return process.send({event: 'record.fail', error: 'something is missing', payload: state});
        }

        startRecording();
        break;

      case 'directory':
        state.directory = msg.payload.value;
        notifyIfReady();
        break;

      case 'notify.start':
        notify = true;
        break;

      case 'notify.stop':
        notify = false;
        break;

      case 'details.request':
        process.send({event: 'details.response', payload: state});
        break;
    }
  }
});

function notifyIfReady() {
  console.log('my state is', state);
  if (state.duration && state.directory && state.stream) {
    process.send({event: 'record.ready'});
  }
}

function startRecording() {
  let args = ['-y', '-rtsp_transport', 'tcp', '-i', state.stream,
              '-t', state.duration, '-pix_fmt', 'yuv420p', '-flags',
              '+global_header',  '-c', 'copy', `${state.directory}/presenter.mp4`];

  let recording = cp.spawn('ffmpeg', args);

//  recording.stdout.on('data', data => console.log(data));
  process.send('record.start');
  recording.stderr.on('data', data => {
    let progress = data.toString();
    if (progress.substring(0, 6) == 'frame=') {
      if (notify) {
        let ffRegex = /size=[\s]*([a-z0-9A-Z]*)\stime=([0-9:.]*)/gmi;
        let matched = ffRegex.exec(progress);
        process.send({event: 'notify', payload: {size: matched[1], time: matched[2], mediapackage: state.mediapackage}});
      }
    }
    else {
      process.send({event: 'record.fail', error: progress});
    }
  });

  recording.on('close', code => {
    recording.kill();
    process.send({event: 'record.complete', payload: {exit: code, mediapackage: state.mediapackage}});
    setTimeout(() => {
      process.exit(0);
    }, 5000);
  });
}

process.send('started');
