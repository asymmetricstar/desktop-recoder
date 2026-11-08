'use strict';

const api = window.recorder;

const settingsView = document.getElementById('settings-view');
const screenshotView = document.getElementById('screenshot-view');
const savedView = document.getElementById('saved-view');
const chips = document.getElementById('chips');
const pathEl = document.getElementById('path');
const savedName = document.getElementById('saved-name');
const savedSize = document.getElementById('saved-size');

let currentFile = null;

function showView(name) {
  settingsView.hidden = name !== 'settings';
  screenshotView.hidden = name !== 'screenshot';
  savedView.hidden = name !== 'saved';
}

api.on('panel:view', (payload) => {
  if (!payload) return;

  if (payload.view === 'settings') {
    showView('settings');
    pathEl.textContent = payload.settings.outputDir || '—';
    pathEl.title = payload.settings.outputDir || '';

    const active = String(payload.settings.countdown);
    chips.querySelectorAll('.chip').forEach((chip) => {
      chip.classList.toggle('active', chip.dataset.value === active);
    });
    return;
  }

  if (payload.view === 'screenshot') {
    showView('screenshot');
    return;
  }

  if (payload.view === 'saved') {
    showView('saved');
    currentFile = payload.file;
    savedName.textContent = payload.name;
    savedName.title = payload.name;
    savedSize.textContent = payload.size;
  }
});

chips.querySelectorAll('.chip').forEach((chip) => {
  chip.addEventListener('click', () => {
    api.send('settings:set-countdown', Number(chip.dataset.value));
  });
});

document.querySelectorAll('[data-shot]').forEach((btn) => {
  btn.addEventListener('click', () => api.send('screenshot:mode', btn.dataset.shot));
});

document.getElementById('btn-change').addEventListener('click', () => api.send('settings:choose-dir'));
document.getElementById('btn-open').addEventListener('click', () => api.send('settings:open-dir'));
document.getElementById('btn-reveal').addEventListener('click', () => api.send('saved:reveal', currentFile));
document.getElementById('btn-play').addEventListener('click', () => api.send('saved:open', currentFile));

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') api.send('panel:close');
});
