'use strict';

/**
 * Hidden renderer that owns the capture stream and the RecordRTC recorder.
 * - type "screen"  : records the selected display stream as is
 * - type "window"  : records the selected window stream as is
 * - type "region"  : crops the display stream to the selected rectangle on a canvas
 */

const api = window.recorder;

let current = null;

function pickMimeType() {
  const candidates = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
  for (const type of candidates) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(type)) return type;
  }
  return 'video/webm';
}

function waitFor(predicate, timeout) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeout) return reject(new Error('Capture stream did not become ready (timeout).'));
      setTimeout(tick, 40);
    };
    tick();
  });
}

api.on('capture:start', (payload) => {
  start(payload).catch((err) => {
    console.error('[capture] could not start', err);
    api.send('capture:error', String((err && err.message) || err));
    teardown(current);
    current = null;
  });
});

api.on('capture:stop', () => {
  stop();
});

api.on('capture:snapshot', (payload) => {
  snapshot(payload).catch((err) => {
    console.error('[capture] screenshot failed', err);
    api.send('capture:error', String((err && err.message) || err));
  });
});

async function snapshot(payload) {
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: { frameRate: { ideal: 1 } },
    audio: false
  });

  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;
  await video.play();
  await waitFor(() => video.videoWidth > 0 && video.videoHeight > 0, 4000);
  // Give the compositor a moment so we never grab an empty first frame.
  await new Promise((resolve) => setTimeout(resolve, 140));

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { alpha: false });

  if (payload.rect) {
    const bounds = payload.displayBounds || { width: video.videoWidth, height: video.videoHeight };
    const scaleX = video.videoWidth / bounds.width;
    const scaleY = video.videoHeight / bounds.height;
    const sx = Math.round(payload.rect.x * scaleX);
    const sy = Math.round(payload.rect.y * scaleY);
    const sw = Math.max(2, Math.round(payload.rect.width * scaleX));
    const sh = Math.max(2, Math.round(payload.rect.height * scaleY));
    canvas.width = sw;
    canvas.height = sh;
    ctx.drawImage(video, sx, sy, sw, sh, 0, 0, sw, sh);
  } else {
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  }

  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  const buffer = await blob.arrayBuffer();

  for (const track of stream.getTracks()) {
    try {
      track.stop();
    } catch {
      /* ignore */
    }
  }
  video.srcObject = null;

  console.log(`[capture] screenshot ${canvas.width}x${canvas.height}`);
  api.send('capture:snapshot-data', { data: buffer, width: canvas.width, height: canvas.height });
}

async function start(payload) {
  if (current) return;

  const fps = payload.fps || 30;
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: { frameRate: { ideal: fps, max: fps } },
    audio: false
  });

  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;
  await video.play();
  await waitFor(() => video.videoWidth > 0 && video.videoHeight > 0, 4000);

  let canvas = null;
  let drawTimer = null;
  let recordStream = stream;

  if (payload.rect) {
    const bounds = payload.displayBounds || { width: video.videoWidth, height: video.videoHeight };
    const scaleX = video.videoWidth / bounds.width;
    const scaleY = video.videoHeight / bounds.height;

    let width = Math.round(payload.rect.width * scaleX);
    let height = Math.round(payload.rect.height * scaleY);
    width -= width % 2;
    height -= height % 2;
    width = Math.max(2, width);
    height = Math.max(2, height);

    const sx = Math.round(payload.rect.x * scaleX);
    const sy = Math.round(payload.rect.y * scaleY);

    canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { alpha: false });

    const draw = () => {
      try {
        ctx.drawImage(video, sx, sy, width, height, 0, 0, width, height);
      } catch {
        /* frame not ready yet */
      }
    };

    draw();
    drawTimer = setInterval(draw, Math.max(5, Math.round(1000 / fps)));
    recordStream = canvas.captureStream(fps);
  }

  const settings = canvas
    ? { width: canvas.width, height: canvas.height }
    : stream.getVideoTracks()[0].getSettings();
  const width = settings.width || 1920;
  const height = settings.height || 1080;

  const bitrate = Math.min(16_000_000, Math.max(2_500_000, Math.round(width * height * fps * 0.1)));
  const mimeType = pickMimeType();

  const recorder = new RecordRTC(recordStream, {
    type: 'video',
    mimeType,
    videoBitsPerSecond: bitrate,
    disableLogs: true
  });

  current = { stream, recordStream, recorder, video, canvas, drawTimer, mimeType };

  recorder.startRecording();
  api.send('capture:started', { startedAt: Date.now(), width, height, mimeType });
  console.log(`[capture] recording ${width}x${height} @${fps}fps ${mimeType} ${bitrate}bps`);

  if (payload.selftest) {
    setTimeout(() => sampleFrame(current), 1500);
  }
}

function sampleFrame(ctx) {
  if (!ctx) return;
  try {
    const source = ctx.canvas || ctx.video;
    const sw = ctx.canvas ? ctx.canvas.width : ctx.video.videoWidth;
    const sh = ctx.canvas ? ctx.canvas.height : ctx.video.videoHeight;
    if (!sw || !sh) throw new Error('no frame available');

    const out = document.createElement('canvas');
    out.width = 480;
    out.height = Math.max(2, Math.round((sh / sw) * 480));
    out.getContext('2d').drawImage(source, 0, 0, out.width, out.height);
    api.send('capture:frame', out.toDataURL('image/png'));
    console.log('[capture] self-test frame captured');
  } catch (err) {
    api.send('capture:frame-error', String((err && err.message) || err));
  }
}

function teardown(ctx) {
  if (!ctx) return;
  if (ctx.drawTimer) clearInterval(ctx.drawTimer);
  try {
    if (ctx.recorder && typeof ctx.recorder.destroy === 'function') ctx.recorder.destroy();
  } catch {
    /* ignore */
  }
  try {
    if (ctx.video) ctx.video.srcObject = null;
  } catch {
    /* ignore */
  }
  const streams = new Set([ctx.stream, ctx.recordStream]);
  for (const stream of streams) {
    if (!stream) continue;
    for (const track of stream.getTracks()) {
      try {
        track.stop();
      } catch {
        /* ignore */
      }
    }
  }
}

function stop() {
  if (!current) return;
  const ctx = current;
  current = null;

  try {
    ctx.recorder.stopRecording(async () => {
      try {
        const blob = ctx.recorder.getBlob();
        const buffer = await blob.arrayBuffer();
        teardown(ctx);
        api.send('capture:data', { data: buffer, mimeType: ctx.mimeType });
      } catch (err) {
        api.send('capture:error', String((err && err.message) || err));
      }
    });
  } catch (err) {
    teardown(ctx);
    api.send('capture:error', String((err && err.message) || err));
  }
}
