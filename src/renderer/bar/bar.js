'use strict';

const api = window.recorder;

const idleView = document.getElementById('idle-view');
const recView = document.getElementById('rec-view');
const busyView = document.getElementById('busy-view');
const busyText = document.getElementById('busy-text');
const timerLabel = document.getElementById('timer-label');
const timeLabel = document.getElementById('rec-time');
const barEl = document.getElementById('bar');

let state = { phase: 'idle', settings: { countdown: 3 } };
let clock = null;

api.on('state', (next) => {
  state = next || state;
  render();
});

document.querySelectorAll('[data-mode]').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (state.phase !== 'idle') return;
    api.send('bar:record', btn.dataset.mode);
  });
});

document.getElementById('btn-timer').addEventListener('click', () => {
  if (state.phase === 'idle') api.send('panel:toggle-settings');
});

document.getElementById('btn-shot').addEventListener('click', () => {
  if (state.phase === 'idle') api.send('panel:screenshot');
});

document.getElementById('btn-folder').addEventListener('click', () => {
  api.send('bar:open-folder');
});

document.getElementById('btn-close').addEventListener('click', () => {
  api.send('bar:close');
});

document.getElementById('btn-stop').addEventListener('click', () => {
  api.send('bar:stop');
});

document.getElementById('btn-cancel').addEventListener('click', () => {
  api.send('bar:stop');
});

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    if (state.phase === 'selecting' || state.phase === 'picking') api.send('region:cancel');
    else if (state.phase === 'counting') api.send('bar:stop');
  }
});

function formatElapsed(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

function busyLabel(phase) {
  const shot = state.action === 'screenshot';
  if (phase === 'selecting') return shot ? 'Screenshot · select area · Esc' : 'Select an area · Esc';
  if (phase === 'picking') return shot ? 'Screenshot · select window · Esc' : 'Select a window · Esc';
  if (phase === 'counting') return `${state.countdownLeft ?? 0}s`;
  if (phase === 'capturing') return 'Capturing screenshot';
  return 'Starting recording';
}

function render() {
  const phase = state.phase || 'idle';
  const recording = phase === 'recording' || phase === 'stopping';
  const busy =
    phase === 'selecting' ||
    phase === 'picking' ||
    phase === 'counting' ||
    phase === 'starting' ||
    phase === 'capturing';

  idleView.hidden = recording || busy;
  recView.hidden = !recording;
  busyView.hidden = !busy;
  barEl.classList.toggle('is-busy', busy);

  const countdown = Number(state.settings && state.settings.countdown);
  timerLabel.textContent = countdown > 0 ? `${countdown}s` : 'Off';

  if (busy) busyText.textContent = busyLabel(phase);

  if (recording) {
    startClock();
  } else {
    stopClock();
  }
}

function startClock() {
  if (clock) return;
  updateClock();
  clock = setInterval(updateClock, 250);
}

function stopClock() {
  if (clock) {
    clearInterval(clock);
    clock = null;
  }
  timeLabel.textContent = '00:00';
}

function updateClock() {
  const startedAt = state.startedAt || Date.now();
  timeLabel.textContent = formatElapsed(Date.now() - startedAt);
}

render();
