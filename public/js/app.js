let recordings = {};
let queues = {};
let completed = {};

let socket = io();

document.getElementById('caCheck').addEventListener('click', checkCAs, false);
document.getElementById('recCheck').addEventListener('click', checkRecordings, false);

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
  console.log('removing', item);
  [...document.querySelectorAll(`[id$="${item.remove}"]`)]
    .forEach(element => {
      console.log(element);
      element.parentNode.removeChild(element);
    });

  if (queue[item.remove]) {
    delete queue[item.remove];
    updateQueueNumber();
  }
});

socket.on('recorder-item', item => {
  console.log(item);
  if (!document.getElementById(`recording-${item.mediapackage}`)) {
    document.querySelector('#recording .list')
      .appendChild(createDetailedElement('recording', item));
  }
  if (!recordings[item.mediapackage]) {
    recordings[item.mediapackage] = item;
    updateRecordingNumber();
  }
});

socket.on('recorder-complete', mpId => {
  if (recordings[mpId]) {
    delete recordings[mpId];
    updateRecordingNumber();
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

  el.querySelector('span:last-child').textContent = recording.time;
});

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

function createItem(listType, id) {
  console.log(listType, id);
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
  let uiElement = document.getElementById(`${elType}-${details.mediapackage || details.id}`);
  if (!uiElement) {
    uiElement = createElement('li', {id: `${elType}-${details.mediapackage || details.id}`, data: {id: details.id}});
  }

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

socket.on('ingest-initiated', mpId => {
  console.log('ingesting', mpId);
  let completedEl = document.getElementById(`completed-${mpId}`);
  if (completedEl) {
    completedEl.classList.add('ingesting');
  }
});

socket.on('ingest-failed', details => {
  let completedEl = document.getElementById(`completed-${details.id}`);
  if (completedEl) {
    completedEl.classList.remove('ingesting');
  }
});

socket.on('ingest-initiated', mpId => {
  console.log('ingested', mpId);
  let completedEl = document.getElementById(`completed-${mpId}`);
  if (completedEl) {
    completedEl.classList.remove('ingesting');
    let ingestBtn = completedEl.querySelector('button:last-of-type');
    ingestBtn.disabled = true;
    ingestBtn.removeEventListener('click', ingestCompleted, false);
  }
});

socket.on('ingest-state', details => {
  let completedEl = document.getElementById(`completed-${details.id}`);
  if (completedEl) {
    completedEl.setAttribute('data-state', details.state);
    completedEl.classList.remove('ingesting');
  }
});


