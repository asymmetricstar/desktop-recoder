'use strict';

const api = window.recorder;

const params = new URLSearchParams(location.search);
const displayId = params.get('displayId');

const box = document.getElementById('box');
const sizeLabel = document.getElementById('size');
const hint = document.getElementById('hint');
const guideV = document.getElementById('guide-v');
const guideH = document.getElementById('guide-h');

let origin = null;
let rect = null;

function showGuides(x, y) {
  guideV.style.left = `${x}px`;
  guideH.style.top = `${y}px`;
}

document.addEventListener('mousedown', (event) => {
  if (event.button !== 0) return;
  origin = { x: event.clientX, y: event.clientY };
  rect = { x: origin.x, y: origin.y, width: 0, height: 0 };
  box.hidden = false;
  box.style.left = `${origin.x}px`;
  box.style.top = `${origin.y}px`;
  box.style.width = '0px';
  box.style.height = '0px';
  sizeLabel.textContent = '0 × 0';
  hint.style.opacity = '0';
  document.body.classList.add('dragging');
  event.preventDefault();
});

document.addEventListener('mousemove', (event) => {
  showGuides(event.clientX, event.clientY);
  if (!origin) return;

  const x = Math.min(origin.x, event.clientX);
  const y = Math.min(origin.y, event.clientY);
  const width = Math.abs(event.clientX - origin.x);
  const height = Math.abs(event.clientY - origin.y);

  rect = { x, y, width, height };
  box.style.left = `${x}px`;
  box.style.top = `${y}px`;
  box.style.width = `${width}px`;
  box.style.height = `${height}px`;
  sizeLabel.textContent = `${Math.round(width)} × ${Math.round(height)}`;
});

document.addEventListener('mouseup', (event) => {
  if (event.button !== 0 || !origin) return;
  document.body.classList.remove('dragging');
  origin = null;

  if (!rect || rect.width < 12 || rect.height < 12) {
    api.send('region:cancel');
    return;
  }

  api.send('region:selected', {
    displayId,
    rect: {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height)
    }
  });
});

document.addEventListener('contextmenu', (event) => {
  event.preventDefault();
  api.send('region:cancel');
});

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') api.send('region:cancel');
  if (event.key === 'Enter' && rect && rect.width >= 12 && rect.height >= 12) {
    api.send('region:selected', {
      displayId,
      rect: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      }
    });
  }
});

window.focus();
