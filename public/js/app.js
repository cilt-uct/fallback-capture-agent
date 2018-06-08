let socket = io();

socket.on('queue', queue => {
  let queueList = document.querySelector('#queue .list');
  queue.forEach(item => {
    if (!queueList.querySelector(`#queue-${item.mediapackage}`)) {
      queueList.appendChild(createDetailedElement('queue', item));
    }
  });
});

socket.on('recorders', recorders => {
  recorders.forEach(recorder => socket.emit('recording-query', recorder));
});

socket.on('queue-item', item => {
  if (!document.getElementById(`queue-${item.mediapackage}`)) {
    document.querySelector('#queue .list')
      .appendChild(createDetailedElement('queue', item));
  }
});

socket.on('recorder-item', item => {
  if (!document.getElementById(`recording-${item.mediapackage}`)) {
    document.querySelector('#recording .list')
      .appendChild(createDetailedElement('recording', item));
  }
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

function createDetailedElement(elType, details) {
  let uiElement = document.getElementById(`${elType}-${details.mediapackage}`);
  if (!uiElement) {
    uiElement = createElement('li', {id: `${elType}-${details.mediapackage}`});
//    document.getElementById(`#${elType} .list`).appendChild(uiElement);
  }

  let title = createElement('span', details.title);
  let agent = createElement('span', details.name);
  let start = createElement('span', details.start);
  let current = createElement('span');

  uiElement.appendChild(title);
  uiElement.appendChild(agent);
  uiElement.appendChild(start);
  uiElement.appendChild(current);
  return uiElement;
}
