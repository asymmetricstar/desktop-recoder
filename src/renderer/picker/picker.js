'use strict';

const api = window.recorder;
const grid = document.getElementById('grid');
const empty = document.getElementById('empty');

api.on('picker:sources', ({ sources }) => {
  grid.innerHTML = '';

  if (!sources || !sources.length) {
    empty.textContent = 'No windows found';
    return;
  }

  empty.textContent = `${sources.length} window${sources.length === 1 ? '' : 's'}`;

  for (const source of sources) {
    const card = document.createElement('button');
    card.className = 'card';
    card.type = 'button';

    const thumb = document.createElement('div');
    thumb.className = 'thumb';
    thumb.style.backgroundImage = `url("${source.thumbnail}")`;

    const meta = document.createElement('div');
    meta.className = 'meta';

    if (source.icon) {
      const icon = document.createElement('img');
      icon.src = source.icon;
      icon.alt = '';
      meta.appendChild(icon);
    }

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = source.name;
    name.title = source.name;
    meta.appendChild(name);

    card.appendChild(thumb);
    card.appendChild(meta);
    card.addEventListener('click', () => api.send('picker:selected', { id: source.id }));
    grid.appendChild(card);
  }
});

document.getElementById('btn-close').addEventListener('click', () => api.send('picker:cancel'));

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') api.send('picker:cancel');
});

window.focus();
