'use strict';

const api = window.recorder;
const numberEl = document.getElementById('number');
const progressEl = document.getElementById('progress');

const CIRCUMFERENCE = 2 * Math.PI * 45;

api.on('countdown:tick', ({ left, total }) => {
  const value = Math.max(0, Number(left) || 0);
  numberEl.textContent = String(value);

  // Animate the number each tick.
  numberEl.style.animation = 'none';
  void numberEl.offsetWidth;
  numberEl.style.animation = 'pop 900ms ease-out';

  const ratio = total > 0 ? Math.min(1, Math.max(0, value / total)) : 0;
  progressEl.style.strokeDasharray = String(CIRCUMFERENCE);
  progressEl.style.strokeDashoffset = String(CIRCUMFERENCE * (1 - ratio));
});
