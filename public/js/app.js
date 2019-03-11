let recordings = {};
let queues = {};
let completed = {};
let recordingTimes = {};

let socket = io();

document.getElementById('caCheck').addEventListener('click', checkCAs, false);
document.getElementById('recCheck').addEventListener('click', checkRecordings, false);
document.getElementById('adhocStart').addEventListener('click', adhocRecordingModal, false);

socket.on('queue', queue => {
  let queueList = document.querySelector('#queue .list');
  queue.forEach(item => {
    if (!queueList.querySelector(`#queue-${item.mediapackage}`)) {
      queueList.appendChild(createDetailedElement('queue', item));
    }
    queues[item.mediapackage] = item;
  });
  updateQueueNumber();
});

socket.on('recorders', recorders => {
  recorders.forEach(recorder => socket.emit('recording-query', recorder));
});

socket.on('history', recordings => {
  displayCompletedRecordings(recordings);
});

function displayCompletedRecordings(recordings) {
  completed = Object.keys(recordings)
                .map(id => recordings[id])
                .reduce((all, rec) => {
                  all[rec.id] = rec;
                  return all;
                }, {});

  let recList = document.querySelector('#completed .list');
  recordings.forEach(rec => {
    if (!recList.querySelector(`#completed-${rec.id}`)) {
      let displayElement = createDetailedElement('completed', rec);
      displayElement.classList.add('eventDetails');
      let moreToggle = createElement('input', {class: 'hidden', id: `togglecompleted-${rec.id}`, attributes: {type: 'checkbox'}});
      recList.appendChild(displayElement);
      recList.insertBefore(moreToggle, displayElement);
      setActionForCompleted(rec);
    }
  });
  [...document.querySelectorAll('#completed .list > li')]
    .map(el => el.getAttribute('data-id'))
    .filter(id => !!id)
    .forEach(id => {
      if (!completed[id]) {
        document.getElementById(`completed-${id}`).remove();
      }
    });
  updateCompletedNumber();
}

function removeQueueItem(mpId) {
  [...document.querySelectorAll(`[id="queue-${mpId}"]`)]
    .forEach(element => {
      element.parentNode.removeChild(element);
    });

  if (queues[mpId]) {
    delete queues[mpId];
    updateQueueNumber();
  }
}

socket.on('queue-item', item => {
  if (!document.getElementById(`queue-${item.mediapackage}`)) {
    document.querySelector('#queue .list')
      .appendChild(createDetailedElement('queue', item));
  }
  if (!queues[item.mediapackage]) {
    queues[item.mediapackage] = item;
    updateQueueNumber();
  }
});

socket.on('queue-remove', item => {
  removeQueueItem(item.remove);
});

socket.on('recorder-item', item => {
  let recItem = document.getElementById(`recording-${item.mediapackage}`);
  if (!recItem) {
    //Item doesn't exist. Add it to the recording list view
    document.querySelector('#recording .list')
      .appendChild(createDetailedElement('recording', item));
  }
  else if (!recItem.getAttribute('data-id')) {
    //Item exists already (probably because a progress event was intercepted for it).
    //Add event details to existing element
    recItem.setAttribute('data-id', item.mediapackage);
    let textNode = null;    //this text node has the mpId for the event. Remove it/replace it with the event title
    let timeDisplay = null; //keep a reference to the timer, so that event detail elements are inserted before it (i.e. timer must be the last element)
    recItem.childNodes
      .forEach(node => {
        if (node.nodeType === Node.TEXT_NODE) {
          textNode = node;
        }
        else {
          timeDisplay = node;
        }
      });
    textNode.remove();

    let clone = createDetailedElement('recording', item);
    [...clone.querySelectorAll('span:not(:last-child)')]
      .forEach(child => {
        if (child.textContent) {
          recItem.insertBefore(child.cloneNode(true), timeDisplay);
        }
      });
  }
  if (!recordings[item.mediapackage]) {
    recordings[item.mediapackage] = item;
    updateRecordingNumber();
  }

  removeQueueItem(item.mediapackage);
});

socket.on('recorder-complete', mpId => {
  if (recordings[mpId]) {
    delete recordings[mpId];
    updateRecordingNumber();
  }
  if (loops[mpId]) {
    delete loops[mpId];
  }
  getCompletedRecordings();
});

socket.on('progress', recording => {
  let el = document.getElementById(`recording-${recording.mediapackage}`);
  if (!el) {
    el = createItem('recording', recording.mediapackage);
    document.querySelector('#recording .list').appendChild(el);
    el.appendChild(document.createElement('span'));
  }

  if (!loops[recording.mediapackage]) {
    let timerDisplay = el.querySelector('span:last-child');
    loops[recording.mediapackage] = {
      timeStamp: determineRecordingStartTime(recording.time),
      adjustTimestampBuffer: false,
      fn: ts => {
        if (!loops[recording.mediapackage].adjustTimestampBuffer) {
          loops[recording.mediapackage].adjustTimestampBuffer = true;
          loops[recording.mediapackage].timeStamp += ts;
        }
        loops[recording.mediapackage].timeStamp = loops[recording.mediapackage].timeStamp || ts;
        timerDisplay.textContent = displayDuration((ts - loops[recording.mediapackage].timeStamp) >> 0);
      }
    };
  }
});

function determineRecordingStartTime(timeStr) {
  let durationMillis = timeStr.split(':')
                         .map(unit => +unit)
                         .reduce((acc, unit, i) => acc += unit * (60 ** (2 - i)), 0) * 1000;
  return -durationMillis;
}

function displayDuration(elapsedMs) {
  let ms = (elapsedMs % 1000) || 1;
  let elapsedSeconds = (elapsedMs / 1000) >> 0;
  let seconds = elapsedSeconds % 60;
  let mins = (elapsedSeconds - seconds) / 60 >> 0;
  let hours = elapsedSeconds / 3600 >> 0;
  return `${hours < 10 ? '0' : ''}${hours}:${mins < 10 ? '0' : ''}${mins}:${seconds < 10 ? '0' : ''}${seconds}.${ms < 10 ? '00' : (ms < 100 ? '0' : '')}${ms}`;
}

function updateQueueNumber() {
  if (document.querySelector('label[data-name=upcoming]')) {
    document.querySelector('label[data-name=upcoming]').setAttribute('data-total', Object.keys(queues).length);
  }
}

function updateRecordingNumber() {
  if (document.querySelector('label[data-name=recordings]')) {
    document.querySelector('label[data-name=recordings]').setAttribute('data-total', Object.keys(recordings).length);
  }
}

function updateCompletedNumber() {
  if (document.querySelector('label[data-name=completed]')) {
    document.querySelector('label[data-name=completed]').setAttribute('data-total', Object.keys(completed).length);
  }
}

function setActionForCompleted(details) {
  let element = document.getElementById(`completed-${details.id}`);
  if (!element) {
    return console.log('no element');
  }
  element.setAttribute('data-state', details.state);
  element.querySelector('span:first-child')
    .title = getTitleTextForState(details.state);
  element.querySelector('span:last-child')
    .appendChild(createElement('label', { attributes: {for: `togglecompleted-${details.id}`} }));

  let detailsList = createElement('ul');
  let mpInfo = createElement('li');
  let mpField = createElement('span', 'Mediapackage');
  let mpValue = createElement('span', details.id);
  mpInfo.appendChild(mpField);
  mpInfo.appendChild(mpValue);
  detailsList.appendChild(mpInfo);

  for (let key in details.probe) {
    let probeInfo = createElement('li');
    let probeField = createElement('span', key);
    let probeValue = createElement('span', details.probe[key], { attributes: {title: details.probe[key] } });
    probeInfo.appendChild(probeField);
    probeInfo.appendChild(probeValue);
    detailsList.appendChild(probeInfo);
    if (key === 'duration') {
      probeValue.textContent += ` (${(details.size / 1024 / 1024).toFixed(2)} MB)`
    }
  }
  element.appendChild(detailsList);

  let actions = createElement('li');
  let actionsContainer = createElement('span');
  actions.appendChild(actionsContainer);

  let ingestBtn = document.createElement('button');
  ingestBtn.disabled = true;
  if (!details.ingestDate) {
    ingestBtn.addEventListener('click', ingestCompleted, false);
    ingestBtn.removeAttribute('disabled');
    let ingestProgress = createElement('progress');
    ingestProgress.min = 0;
    ingestProgress.max = 100;
    ingestBtn.appendChild(ingestProgress);
  }
  actionsContainer.appendChild(ingestBtn);

  detailsList.appendChild(actions);
}

function getTitleTextForState(state) {
  let stateTitles = {
    ingestable: 'This recording may be ingested',
      unneeded: 'This recording may be ignored',
      unusable: 'Failed backup',
      ingested: 'Recording has already been ingested'
  }
  return stateTitles[state] || 'Unknown state';
}

function setupDeletion(e) {
  let deleteModal = document.getElementById('deleteRecordingModal');
  deleteModal.removeAttribute('data-id');
  deleteModal.querySelector('#deleteEventName').textContent = '';

  let parentEl = getEventElement(this);

  if (!parentEl || !parentEl.getAttribute('data-id')) {
    return;
  }

  let id = parentEl.getAttribute('data-id');
  if (!completed[id]) {
    return;
  }

  deleteModal.setAttribute('data-id', id);
  deleteModal.querySelector('#deleteEventName').textContent = completed[id].title;
}

function deleteRecording(e) {
  let id = document.getElementById('deleteRecordingModal').getAttribute('data-id');
  if (!id || !completed[id]) {
    document.getElementById('deleteRecordingToggle').checked = false;
    return;
  }

  let rec = completed[id];
  fetch(`/agent/${rec.agent}/rec/${rec.id}`, {
    method: 'DELETE'
  }).then(res => res.text())
  .then(res => {
    let delModal = document.getElementById('deleteRecordingModal');
    let delCheckbox = document.getElementById('deleteRecordingToggle');
    if (delCheckbox.checked && delModal.getAttribute('data-id') === id) {
      delCheckbox.checked = false;
    }
  })
  .catch(err => console.log('err', err))
  .then(() => getCompletedRecordings());
}

function getCompletedRecordings() {
  fetch('/rec')
    .then(res => res.json())
    .then(recs => displayCompletedRecordings(recs) )
    .catch(err => console.log('err', err))
}

function ingestCompleted(e) {
  let parentEl = getEventElement(this);

  if (!parentEl || !parentEl.getAttribute('data-id')) {
    return;
  }

  let id = parentEl.getAttribute('data-id');
  fetch(`/rec/${id}/ingest`, {
    method: 'POST'
  }).then(res => res.text())
  .then(res => {
    parentEl.classList.add('ingesting');
  })
  .catch(err => console.log('err', err));
}

function getEventElement(el) {
  if (!el) {
    return null;
  }

  let parentEl = el.parentNode;
  while (parentEl && !parentEl.classList.contains('eventDetails')) {
    parentEl = parentEl.parentNode;
  }

  return parentEl;
}

function adhocRecordingModal(e) {
  document.getElementById('adhocRecordingToggle').checked = true;
}

function createItem(listType, id) {
  return createElement('li', id, {id: `${listType}-${id}`});
}

function createElement(type, text, opts) {
  if (!type || typeof type !== 'string') {
    return document.createElement('p');
  }

  let el = document.createElement(type);
  if (typeof text == 'string') {
    el.textContent = text;
  }
  else if (typeof text == 'object') {
    opts = text;
  }

  opts = opts || {};

  if (opts.id) el.id = opts.id;
  if (opts.class) el.className = opts.class;
  if (opts.value) el.value = opts.value;
  if (opts.properties) {
    for (let key in opts.properties) {
      el[key] = opts.properties[key];
    }
  }
  if (opts.attributes) {
    for (let key in opts.attributes) {
      el.setAttribute(key, opts.attributes[key]);
    }
  }
  if (opts.data) {
    for (let key in opts.data) {
      el.setAttribute(`data-${key}`, opts.data[key]);
    }
  }

  return el;
}

function getStartDate(dateString) {
  try {
    let d = new Date(dateString);
    let hours = (d.getHours() < 10 ? '0' : '') + d.getHours();
    let mins = (d.getMinutes() < 10 ? '0' : '') + d.getMinutes();
    let day = d.getDate();
    let month = monthName(d.getMonth());
    let year = d.getFullYear();
    return `${hours}:${mins}, ${day} ${month} ${year}`;
  } catch(e) {
    console.log(e);
    return '';
  }
}

function monthName(num) {
  let months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return months[num%12];
}

function createDetailedElement(elType, details) {
  //Crap code
  let uiElement = null;//document.getElementById(`${elType}-${details.mediapackage || details.id}`);
//  if (!uiElement) {
    uiElement = createElement('li', {id: `${elType}-${details.mediapackage || details.id}`, data: {id: details.id}});
//  }

  let titleSpan = createElement('span');
  let titleLink = createElement('a', details.title, {
    properties: {
      target: '_blank',
       title: '',
        href: `https://media.uct.ac.za/admin-ng/index.html#/events/events?modal=event-details&tab=metadata&resourceId=${details.id}`
    }
  });
  titleSpan.appendChild(titleLink);
  let agent = createElement('span', details.name || details.agent);
  let start = createElement('span', getStartDate(details.start || details.startDate));
  let current = createElement('span');

  uiElement.appendChild(titleSpan);
  uiElement.appendChild(agent);
  uiElement.appendChild(start);
  uiElement.appendChild(current);
  return uiElement;
}

function checkCAs(e) {
  fetch('/agent', {
    method: 'PUT'
  });
}

function checkRecordings(e) {
  fetch('/rec', {
    method: 'PUT'
  });
}

function logSupportedVenues(venues) {
  let venueSelect = document.querySelector('#adhocRecordingModal select');
  let venueList = [...venueSelect.querySelectorAll('option')].map(option => option.value);
  venues
    .filter(venue => !!venue.name)
    .forEach(venue => {
      if (venueList.indexOf(venue.name) === -1) {
        let venueOption = document.createElement('option');
        venueOption.value = venue.name;
        venueOption.textContent = venue.readableName;
        venueSelect.appendChild(venueOption);
      }
    });
}

function getSupportedVenues() {
  return new Promise(resolve => {
    fetch('/agent')
      .then(res => res.json())
      .then(venues => resolve(venues) )
      .catch(err => {console.log('err', err); resolve([]);})
  });
}

async function listSupportedVenues() {
  let supportedVenues = await getSupportedVenues();
  logSupportedVenues(supportedVenues);
}

socket.on('agent-check-start', () => {
  let caCheckBtn = document.getElementById('caCheck');
  caCheckBtn.disabled = true;
});

socket.on('agent-check-end', () => {
  setTimeout(() => {
    let caCheckBtn = document.getElementById('caCheck');
    caCheckBtn.disabled = '';
  }, 1000);
});

socket.on('agent-supported', supportedVenues => {
  logSupportedVenues(supportedVenues);
});

socket.on('rec-check-start', () => {
  let recCheckBtn = document.getElementById('recCheck');
  recCheckBtn.disabled = true;
});

socket.on('rec-check-end', () => {
  setTimeout(() => {
    let recCheckBtn = document.getElementById('recCheck');
    recCheckBtn.disabled = '';
  }, 1000);
});

socket.on('ingest-failed', details => {
  let completedEl = document.getElementById(`completed-${details.id}`);
  if (completedEl) {
    completedEl.className = 'eventDetails';
  }
});

socket.on('ingest-initiated', mpId => {
  console.log('ingested', mpId);
  let completedEl = document.getElementById(`completed-${mpId}`);
  if (completedEl) {
    completedEl.className = 'eventDetails preparing';
    let ingestBtn = completedEl.querySelector('button:last-of-type');
    ingestBtn.disabled = true;
    ingestBtn.removeEventListener('click', ingestCompleted, false);
  }
});

socket.on('ingest-state', details => {
  let completedEl = document.getElementById(`completed-${details.id}`);
  if (completedEl) {
    completedEl.setAttribute('data-state', details.state);
    completedEl.className = 'eventDetails';
  }
});

socket.on('ingest-progress', details => {
  let completedEl = document.getElementById(`completed-${details.id}`);
  if (!completedEl) {
    return;
  }
  if (!completedEl.classList.contains('uploading')) {
    completedEl.className = 'eventDetails uploading';
  }

  completedEl.querySelector('progress').value = details.progress;
});


function rafLoop(timestamp) {
  for (let key in loops) {
    loops[key].fn(timestamp);
  }
  requestAnimationFrame(rafLoop);
}

let loops = {};
requestAnimationFrame(rafLoop);

listSupportedVenues();
