'use strict';

const { app, BrowserWindow, ipcMain, desktopCapturer, screen, session, dialog, shell, Menu, nativeImage, Tray } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const IS_SELFTEST = Boolean(process.env.RECORDER_SELFTEST);

if (process.env.RECORDER_USERDATA) {
  try {
    app.setPath('userData', process.env.RECORDER_USERDATA);
  } catch (err) {
    console.warn('[boot] could not set userData:', err.message);
  }
}

const ROOT = path.join(__dirname, '..');
const PRELOAD = path.join(ROOT, 'preload', 'preload.js');
const RENDERER = path.join(ROOT, 'renderer');
// PNG is used for the window icon (nativeImage does not always load ICO reliably);
// the installer/exe icon is embedded from 256-icon.ico by electron-builder.
const APP_ICON_PNG = path.join(ROOT, 'assets', 'icon.png');
const TRAY_ICON = path.join(ROOT, 'assets', 'tray.png');

const FPS = 30;
// The window is larger than the visible bar: the transparent margin lets the shadow
// spread softly instead of being clipped at the window edge.
const BAR_MARGIN = 20;
const PANEL_MARGIN = 18;
const BAR_W = 312 + BAR_MARGIN * 2;
const BAR_H = 78 + BAR_MARGIN * 2;
const PANEL_W = 322 + PANEL_MARGIN * 2;
const APP_TITLE = 'Desktop Recorder';

const DEFAULT_SETTINGS = { countdown: 3, outputDir: '', barPosition: null, fps: FPS };

function selftestDir() {
  if (process.env.RECORDER_SELFTEST_DIR) return process.env.RECORDER_SELFTEST_DIR;
  // In the packaged app the code lives inside a read-only asar archive.
  return app.isPackaged
    ? path.join(app.getPath('userData'), 'selftest')
    : path.join(ROOT, '..', '.selftest');
}

let settings = { ...DEFAULT_SETTINGS };
let state = { phase: 'idle' };

let barWin = null;
let captureWin = null;
let panelWin = null;
let countdownWin = null;
let pickerWin = null;
let regionWins = [];

let pendingSource = null;
let countdownTimer = null;
let savedPanelTimer = null;
let suppressPanelBlurUntil = 0;
let pickerResolved = false;
let lastWindowSources = new Map();
let lastSavedFile = null;

let tray = null;
let isQuitting = false;
// 'record' | 'screenshot' — which action the current selection/picker serves.
let pendingAction = 'record';

// ------------------------------------------------------------------ settings

function settingsFile() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function defaultOutputDir() {
  try {
    return path.join(app.getPath('videos'), 'Desktop Recorder');
  } catch {
    return path.join(app.getPath('documents'), 'Desktop Recorder');
  }
}

function loadSettings() {
  let stored = {};
  try {
    stored = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
  } catch {
    stored = {};
  }
  settings = { ...DEFAULT_SETTINGS, ...stored };
  if (!settings.outputDir) settings.outputDir = defaultOutputDir();
}

function saveSettings() {
  try {
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
    fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2));
  } catch (err) {
    console.warn('[settings] could not save:', err.message);
  }
}

function publicSettings() {
  return { countdown: settings.countdown, outputDir: settings.outputDir };
}

// -------------------------------------------------------------------- state

function pushState(patch = {}) {
  state = { ...state, ...patch };
  if (barWin && !barWin.isDestroyed()) {
    barWin.webContents.send('state', { ...state, settings: publicSettings() });
  }
  updateTrayMenu();
}

function idle() {
  stopCountdown();
  closeCountdownWindow();
  closeRegionWindows();
  closePicker();
  pendingAction = 'record';
  pushState({ phase: 'idle', startedAt: null, countdownLeft: null, mode: null, action: null });
}

// ------------------------------------------------------------------ windows

function defaultBarPosition() {
  const { workArea } = screen.getPrimaryDisplay();
  return {
    x: Math.round(workArea.x + (workArea.width - BAR_W) / 2),
    y: Math.round(workArea.y + workArea.height - BAR_H - 8)
  };
}

function clampToWorkArea(pos) {
  const { workArea } = screen.getDisplayNearestPoint({ x: pos.x, y: pos.y });
  return {
    x: Math.min(Math.max(pos.x, workArea.x), workArea.x + workArea.width - BAR_W),
    y: Math.min(Math.max(pos.y, workArea.y), workArea.y + workArea.height - BAR_H)
  };
}

function createBarWindow() {
  const pos = clampToWorkArea(settings.barPosition || defaultBarPosition());

  barWin = new BrowserWindow({
    width: BAR_W,
    height: BAR_H,
    x: pos.x,
    y: pos.y,
    title: APP_TITLE,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    minimizable: false,
    skipTaskbar: false,
    hasShadow: false,
    alwaysOnTop: true,
    show: false,
    icon: APP_ICON_PNG,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });

  barWin.setAlwaysOnTop(true, 'floating');

  // Apply the icon at window level too (taskbar / alt-tab).
  const barIcon = nativeImage.createFromPath(APP_ICON_PNG);
  if (!barIcon.isEmpty()) barWin.setIcon(barIcon);

  // Keeps the bar out of the capture while recording (Windows 10 2004+ / WGC).
  barWin.setContentProtection(true);
  barWin.loadFile(path.join(RENDERER, 'bar', 'index.html'));
  barWin.once('ready-to-show', () => barWin.show());

  let moveTimer = null;
  barWin.on('moved', () => {
    if (!barWin || barWin.isDestroyed()) return;
    const [x, y] = barWin.getPosition();
    settings.barPosition = { x, y };
    clearTimeout(moveTimer);
    moveTimer = setTimeout(saveSettings, 400);
  });

  // Closing the bar keeps the app running in the system tray.
  barWin.on('close', (event) => {
    if (isQuitting) return;
    event.preventDefault();
    closePanel();
    barWin.hide();
  });

  barWin.on('closed', () => {
    barWin = null;
  });
}

function createCaptureWindow() {
  captureWin = new BrowserWindow({
    show: false,
    width: 640,
    height: 400,
    title: APP_TITLE,
    skipTaskbar: true,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });
  captureWin.loadFile(path.join(RENDERER, 'capture', 'index.html'));
  captureWin.on('closed', () => {
    captureWin = null;
  });
}

async function ensureCaptureWindow() {
  if (!captureWin || captureWin.isDestroyed()) {
    createCaptureWindow();
    await new Promise((resolve) => {
      const done = () => {
        if (captureWin && !captureWin.isDestroyed()) {
          captureWin.webContents.removeListener('did-finish-load', done);
        }
        resolve();
      };
      if (captureWin && !captureWin.isDestroyed()) captureWin.webContents.once('did-finish-load', done);
      setTimeout(done, 2000);
    });
  }
  return captureWin;
}

function createPanelWindow() {
  const pos = panelPosition(260);

  panelWin = new BrowserWindow({
    width: PANEL_W,
    height: 260,
    x: pos.x,
    y: pos.y,
    title: APP_TITLE,
    frame: false,
    transparent: true,
    resizable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });

  panelWin.setAlwaysOnTop(true, 'floating');
  panelWin.setContentProtection(true);
  panelWin.loadFile(path.join(RENDERER, 'panel', 'index.html'));
  panelWin.on('blur', () => {
    if (Date.now() < suppressPanelBlurUntil) return;
    closePanel();
  });
  panelWin.on('closed', () => {
    panelWin = null;
  });
}

function panelPosition(height) {
  const bar = barWin && !barWin.isDestroyed() ? barWin.getBounds() : { ...defaultBarPosition(), width: BAR_W, height: BAR_H };
  const { workArea } = screen.getDisplayNearestPoint({ x: bar.x, y: bar.y });
  const gap = 10;
  let x = Math.round(bar.x + (bar.width - PANEL_W) / 2);
  // Place it right above the bar, accounting for the visual margins.
  let y = Math.round(bar.y + BAR_MARGIN - gap - (height - PANEL_MARGIN));
  if (y < workArea.y + 4) {
    y = Math.round(bar.y + bar.height - BAR_MARGIN + gap - PANEL_MARGIN);
  }
  x = Math.min(Math.max(x, workArea.x + 8), workArea.x + workArea.width - PANEL_W - 8);
  return { x, y };
}

function showPanel(payload, height) {
  if (!panelWin || panelWin.isDestroyed()) createPanelWindow();
  const pos = panelPosition(height);
  panelWin.setBounds({ x: pos.x, y: pos.y, width: PANEL_W, height });
  panelWin.webContents.send('panel:view', payload);
  panelWin.show();
  panelWin.focus();
}

function closePanel() {
  clearTimeout(savedPanelTimer);
  if (panelWin && !panelWin.isDestroyed()) panelWin.hide();
}

function showSettingsPanel() {
  suppressPanelBlurUntil = 0;
  showPanel({ view: 'settings', settings: publicSettings() }, 268 + PANEL_MARGIN * 2);
}

function showSavedPanel(info) {
  showPanel({ view: 'saved', ...info }, 190 + PANEL_MARGIN * 2);
  clearTimeout(savedPanelTimer);
  savedPanelTimer = setTimeout(closePanel, 12000);
}

function toggleSettingsPanel() {
  if (panelWin && !panelWin.isDestroyed() && panelWin.isVisible()) closePanel();
  else showSettingsPanel();
}

// -------------------------------------------------------------- countdown UI

function targetCenter(target) {
  const bounds = target.display.bounds;
  if (target.rect) {
    return {
      x: bounds.x + target.rect.x + target.rect.width / 2,
      y: bounds.y + target.rect.y + target.rect.height / 2
    };
  }
  if (target.type === 'window') {
    const cursor = screen.getCursorScreenPoint();
    const { bounds: cb } = screen.getDisplayNearestPoint(cursor);
    return { x: cb.x + cb.width / 2, y: cb.y + cb.height / 2 };
  }
  return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
}

function showCountdownWindow(target, seconds) {
  closeCountdownWindow();
  const center = targetCenter(target);
  const size = 220;

  countdownWin = new BrowserWindow({
    width: size,
    height: size,
    x: Math.round(center.x - size / 2),
    y: Math.round(center.y - size / 2),
    title: APP_TITLE,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    focusable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });

  countdownWin.setIgnoreMouseEvents(true);
  countdownWin.setAlwaysOnTop(true, 'screen-saver');
  countdownWin.setContentProtection(true);
  countdownWin.loadFile(path.join(RENDERER, 'countdown', 'index.html'));
  countdownWin.webContents.once('did-finish-load', () => {
    if (countdownWin && !countdownWin.isDestroyed()) {
      countdownWin.webContents.send('countdown:tick', { left: seconds, total: seconds });
    }
  });
  countdownWin.showInactive();
}

function closeCountdownWindow() {
  if (countdownWin && !countdownWin.isDestroyed()) countdownWin.destroy();
  countdownWin = null;
}

function stopCountdown() {
  if (countdownTimer) {
    clearInterval(countdownTimer);
    countdownTimer = null;
  }
}

// ------------------------------------------------------------ region overlay

function closeRegionWindows() {
  for (const entry of regionWins) {
    if (entry.win && !entry.win.isDestroyed()) entry.win.destroy();
  }
  regionWins = [];
}

async function startRegionSelection() {
  closeRegionWindows();
  pushState({ phase: 'selecting', mode: 'region', action: pendingAction });

  const displays = screen.getAllDisplays();
  regionWins = displays.map((display) => {
    const win = new BrowserWindow({
      x: display.bounds.x,
      y: display.bounds.y,
      width: display.bounds.width,
      height: display.bounds.height,
      title: APP_TITLE,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hasShadow: false,
      alwaysOnTop: true,
      enableLargerThanScreen: true,
      backgroundColor: '#00000000',
      webPreferences: {
        preload: PRELOAD,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false
      }
    });

    win.setAlwaysOnTop(true, 'screen-saver');
    win.loadFile(path.join(RENDERER, 'region', 'index.html'), {
      query: { displayId: String(display.id) }
    });
    return { win, display };
  });

  const first = regionWins[0];
  if (first && !first.win.isDestroyed()) {
    first.win.once('ready-to-show', () => {
      if (first.win && !first.win.isDestroyed()) {
        first.win.show();
        first.win.focus();
      }
    });
  }
}

async function getScreenSource(display) {
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: 0, height: 0 },
    fetchWindowIcons: false
  });
  return sources.find((s) => String(s.display_id) === String(display.id)) || sources[0] || null;
}

// -------------------------------------------------------------- window picker

function closePicker() {
  if (pickerWin && !pickerWin.isDestroyed()) pickerWin.destroy();
  pickerWin = null;
}

async function openWindowPicker() {
  pushState({ phase: 'picking', mode: 'window', action: pendingAction });

  const sources = await desktopCapturer.getSources({
    types: ['window'],
    thumbnailSize: { width: 480, height: 300 },
    fetchWindowIcons: true
  });

  lastWindowSources = new Map();
  const items = [];
  for (const source of sources) {
    if (!source.name) continue;
    if (source.name.includes(APP_TITLE)) continue;
    if (source.thumbnail.isEmpty()) continue;
    lastWindowSources.set(source.id, source);
    items.push({
      id: source.id,
      name: source.name,
      thumbnail: source.thumbnail.toDataURL(),
      icon: source.appIcon && !source.appIcon.isEmpty() ? source.appIcon.toDataURL() : null
    });
  }

  if (!items.length) throw new Error('No recordable window found.');

  pickerResolved = false;
  pickerWin = new BrowserWindow({
    width: 940,
    height: 620,
    title: APP_TITLE,
    frame: false,
    transparent: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });

  pickerWin.setAlwaysOnTop(true, 'floating');
  pickerWin.setContentProtection(true);
  pickerWin.center();
  pickerWin.webContents.once('did-finish-load', () => {
    if (pickerWin && !pickerWin.isDestroyed()) {
      pickerWin.webContents.send('picker:sources', { sources: items });
    }
  });
  pickerWin.once('ready-to-show', () => {
    if (pickerWin && !pickerWin.isDestroyed()) {
      pickerWin.show();
      pickerWin.focus();
    }
  });
  pickerWin.on('closed', () => {
    pickerWin = null;
    if (!pickerResolved) {
      idle();
    }
  });
  pickerWin.loadFile(path.join(RENDERER, 'picker', 'index.html'));
}

// --------------------------------------------------------------- screenshots

async function takeSnapshot(target) {
  await ensureCaptureWindow();
  pendingSource = target.source;
  showBar();

  pushState({ phase: 'capturing', mode: target.type, action: 'screenshot' });

  captureWin.webContents.send('capture:snapshot', {
    type: target.type,
    rect: target.rect || null,
    displayBounds: target.display.bounds
  });
}

async function startScreenshot(mode) {
  if (state.phase !== 'idle') return;
  pendingAction = 'screenshot';

  try {
    if (mode === 'region') {
      await startRegionSelection();
      return;
    }
    if (mode === 'window') {
      await openWindowPicker();
      return;
    }

    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const source = await getScreenSource(display);
    if (!source) throw new Error('No screen source found.');
    await takeSnapshot({ type: 'screen', source, display });
  } catch (err) {
    failFlow(err);
  }
}

async function openRecordingsFolder() {
  try {
    await fs.promises.mkdir(settings.outputDir, { recursive: true });
    await shell.openPath(settings.outputDir);
  } catch (err) {
    dialog.showErrorBox('Could not open folder', String((err && err.message) || err));
  }
}

function showScreenshotPanel() {
  suppressPanelBlurUntil = 0;
  showPanel({ view: 'screenshot' }, 186 + PANEL_MARGIN * 2);
}

// --------------------------------------------------------------- record flow

async function startFlow(mode) {
  if (state.phase !== 'idle') return;
  pendingAction = 'record';

  try {
    if (mode === 'region') {
      await startRegionSelection();
      return;
    }
    if (mode === 'window') {
      await openWindowPicker();
      return;
    }

    const cursor = screen.getCursorScreenPoint();
    const display = screen.getDisplayNearestPoint(cursor);
    const source = await getScreenSource(display);
    if (!source) throw new Error('No screen source found.');
    await beginCountdown({ type: 'screen', source, display });
  } catch (err) {
    failFlow(err);
  }
}

async function beginCountdown(target) {
  const seconds = Math.max(0, Math.min(10, Number(settings.countdown) || 0));

  if (seconds === 0) {
    await startCapture(target);
    return;
  }

  pendingSource = target.source;
  pushState({ phase: 'counting', mode: target.type, countdownLeft: seconds });
  showCountdownWindow(target, seconds);

  const endAt = Date.now() + seconds * 1000;
  let shown = seconds;

  stopCountdown();
  countdownTimer = setInterval(() => {
    const left = Math.max(0, endAt - Date.now());
    const secondsLeft = Math.ceil(left / 1000);

    if (secondsLeft !== shown) {
      shown = secondsLeft;
      if (countdownWin && !countdownWin.isDestroyed()) {
        countdownWin.webContents.send('countdown:tick', { left: secondsLeft, total: seconds });
      }
      pushState({ countdownLeft: secondsLeft });
    }

    if (left <= 0) {
      stopCountdown();
      closeCountdownWindow();
      // Start only after the countdown window is gone so it never lands in the video.
      setTimeout(() => {
        startCapture(target).catch(failFlow);
      }, 200);
    }
  }, 40);
}

async function startCapture(target) {
  stopCountdown();
  closeCountdownWindow();

  await ensureCaptureWindow();
  pendingSource = target.source;
  showBar();

  pushState({ phase: 'starting', mode: target.type, action: 'record' });

  const payload = {
    type: target.type,
    sourceId: target.source.id,
    rect: target.rect
      ? {
          x: target.rect.x,
          y: target.rect.y,
          width: target.rect.width,
          height: target.rect.height
        }
      : null,
    displayBounds: target.display.bounds,
    fps: settings.fps || FPS,
    selftest: IS_SELFTEST
  };

  captureWin.webContents.send('capture:start', payload);
}

function stopCapture() {
  if (!captureWin || captureWin.isDestroyed()) {
    idle();
    return;
  }
  pushState({ phase: 'stopping' });
  captureWin.webContents.send('capture:stop');
}

function failFlow(err) {
  console.error('[recorder]', err);
  const message = String((err && err.message) || err);
  pendingSource = null;
  idle();
  dialog.showErrorBox('Could not start recording', message);
}

// --------------------------------------------------------------------- save

function fileTimestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function toBuffer(data) {
  if (Buffer.isBuffer(data)) return data;
  return Buffer.from(data instanceof ArrayBuffer ? data : new Uint8Array(data));
}

async function saveRecording({ data, mimeType }) {
  const buffer = toBuffer(data);

  const ext = /mp4/.test(String(mimeType)) ? 'mp4' : 'webm';
  const dir = settings.outputDir;
  await fs.promises.mkdir(dir, { recursive: true });

  const name = `recording-${fileTimestamp()}.${ext}`;
  const file = path.join(dir, name);
  await fs.promises.writeFile(file, buffer);

  lastSavedFile = file;
  pushState({ phase: 'idle', startedAt: null, mode: null, lastSaved: file });
  showSavedPanel({ file, name, size: formatBytes(buffer.length) });
  console.log('[recorder] saved:', file, formatBytes(buffer.length));

  if (IS_SELFTEST) {
    setTimeout(() => app.exit(0), 600);
  }
}

async function saveImage({ data }) {
  const buffer = toBuffer(data);
  const dir = settings.outputDir;
  await fs.promises.mkdir(dir, { recursive: true });

  const name = `screenshot-${fileTimestamp()}.png`;
  const file = path.join(dir, name);
  await fs.promises.writeFile(file, buffer);

  lastSavedFile = file;
  pushState({ phase: 'idle', startedAt: null, mode: null, action: null });
  showSavedPanel({ file, name, size: formatBytes(buffer.length) });
  console.log('[recorder] screenshot saved:', file, formatBytes(buffer.length));

  if (IS_SELFTEST) setTimeout(() => app.exit(0), 500);
}

// ---------------------------------------------------------------------- ipc

function registerIpc() {
  ipcMain.on('bar:record', (_e, mode) => {
    startFlow(mode);
  });

  ipcMain.on('bar:stop', () => {
    if (state.phase === 'recording' || state.phase === 'starting') stopCapture();
    else if (state.phase !== 'idle') idle();
  });

  ipcMain.on('bar:close', () => {
    if (barWin && !barWin.isDestroyed()) barWin.close();
  });

  ipcMain.on('bar:open-folder', async () => {
    try {
      await fs.promises.mkdir(settings.outputDir, { recursive: true });
      await shell.openPath(settings.outputDir);
    } catch (err) {
      dialog.showErrorBox('Could not open folder', String(err.message || err));
    }
  });

  ipcMain.on('panel:toggle-settings', () => toggleSettingsPanel());

  ipcMain.on('panel:screenshot', () => {
    if (panelWin && !panelWin.isDestroyed() && panelWin.isVisible()) closePanel();
    else showScreenshotPanel();
  });

  ipcMain.on('screenshot:mode', (_e, mode) => {
    closePanel();
    startScreenshot(mode);
  });

  ipcMain.on('capture:snapshot-data', async (_e, payload) => {
    try {
      await saveImage(payload);
    } catch (err) {
      failFlow(err);
    }
  });

  ipcMain.on('panel:close', () => closePanel());

  ipcMain.on('settings:set-countdown', (_e, value) => {
    settings.countdown = Math.max(0, Math.min(10, Number(value) || 0));
    saveSettings();
    pushState({});
    if (panelWin && !panelWin.isDestroyed()) {
      panelWin.webContents.send('panel:view', { view: 'settings', settings: publicSettings() });
    }
  });

  ipcMain.on('settings:choose-dir', async () => {
    suppressPanelBlurUntil = Date.now() + 120000;
    const result = await dialog.showOpenDialog(panelWin || barWin, {
      title: 'Select recording folder',
      defaultPath: settings.outputDir,
      properties: ['openDirectory', 'createDirectory']
    });
    suppressPanelBlurUntil = 0;
    if (!result.canceled && result.filePaths[0]) {
      settings.outputDir = result.filePaths[0];
      saveSettings();
      pushState({});
      showSettingsPanel();
    }
  });

  ipcMain.on('settings:open-dir', async () => {
    await fs.promises.mkdir(settings.outputDir, { recursive: true });
    await shell.openPath(settings.outputDir);
  });

  ipcMain.on('saved:reveal', (_e, file) => {
    if (file && fs.existsSync(file)) shell.showItemInFolder(file);
  });

  ipcMain.on('saved:open', async (_e, file) => {
    if (file && fs.existsSync(file)) await shell.openPath(file);
  });

  // region overlay
  ipcMain.on('region:selected', async (_e, { displayId, rect }) => {
    closeRegionWindows();
    const display =
      screen.getAllDisplays().find((d) => String(d.id) === String(displayId)) || screen.getPrimaryDisplay();
    try {
      const source = await getScreenSource(display);
      if (!source) throw new Error('No screen source found.');
      if (pendingAction === 'screenshot') await takeSnapshot({ type: 'region', source, display, rect });
      else await beginCountdown({ type: 'region', source, display, rect });
    } catch (err) {
      failFlow(err);
    }
  });

  ipcMain.on('region:cancel', () => {
    closeRegionWindows();
    idle();
  });

  // window picker
  ipcMain.on('picker:selected', async (_e, { id }) => {
    pickerResolved = true;
    const source = lastWindowSources.get(id);
    closePicker();
    if (!source) {
      failFlow(new Error('Window source not found.'));
      return;
    }
    try {
      const target = {
        type: 'window',
        source,
        display: screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
      };
      if (pendingAction === 'screenshot') await takeSnapshot(target);
      else await beginCountdown(target);
    } catch (err) {
      failFlow(err);
    }
  });

  ipcMain.on('picker:cancel', () => {
    pickerResolved = true;
    closePicker();
    idle();
  });

  ipcMain.on('picker:refresh', async () => {
    pickerResolved = true;
    closePicker();
    pickerResolved = false;
    pushState({ phase: 'idle', mode: null });
    try {
      await openWindowPicker();
    } catch (err) {
      failFlow(err);
    }
  });

  // capture window
  ipcMain.on('capture:started', (_e, info) => {
    pushState({ phase: 'recording', startedAt: info.startedAt || Date.now(), mode: state.mode });
  });

  ipcMain.on('capture:error', (_e, message) => {
    failFlow(new Error(message));
  });

  ipcMain.on('capture:data', async (_e, payload) => {
    try {
      await saveRecording(payload);
    } catch (err) {
      failFlow(err);
    }
  });

  ipcMain.on('capture:frame', (_e, dataUrl) => {
    if (!IS_SELFTEST) return;
    try {
      const dir = selftestDir();
      fs.mkdirSync(dir, { recursive: true });
      const base64 = String(dataUrl).split(',')[1];
      const name = process.env.RECORDER_SELFTEST === 'region' ? 'frame-region.png' : 'frame.png';
      fs.writeFileSync(path.join(dir, name), Buffer.from(base64, 'base64'));
      console.log('[selftest] frame written');
    } catch (err) {
      console.error('[selftest] could not write frame', err);
    }
  });

  ipcMain.on('capture:frame-error', (_e, message) => {
    console.error('[selftest] frame error:', message);
  });
}

// ----------------------------------------------------------------- selftest

async function runSelfTest() {
  const mode = process.env.RECORDER_SELFTEST;

  try {
    if (mode === 'shot') {
      console.log('[selftest] screenshot test');
      const display = screen.getPrimaryDisplay();
      const source = await getScreenSource(display);
      await takeSnapshot({ type: 'screen', source, display });
      setTimeout(() => {
        console.error('[selftest] timed out');
        app.exit(1);
      }, 20000);
      return;
    }

    if (mode === 'flow' || mode === 'flow-noprotect') {
      if (mode === 'flow-noprotect' && barWin && !barWin.isDestroyed()) {
        barWin.setContentProtection(false);
      }
      console.log('[selftest] flow test:', mode);
      settings.countdown = 3;
      await startFlow('screen');
      setTimeout(() => {
        if (captureWin && !captureWin.isDestroyed()) captureWin.webContents.send('capture:stop');
      }, 7000);
      setTimeout(() => {
        console.error('[selftest] timed out');
        app.exit(1);
      }, 28000);
      return;
    }

    const regionMode = process.env.RECORDER_SELFTEST === 'region';
    console.log('[selftest] starting', regionMode ? '(region)' : '(screen)');
    settings.countdown = 0;
    const display = screen.getPrimaryDisplay();
    const source = await getScreenSource(display);
    const rect = regionMode
      ? {
          x: Math.round(display.bounds.width / 2 - 320),
          y: Math.round(display.bounds.height / 2 - 180),
          width: 640,
          height: 360
        }
      : null;
    const dir = selftestDir();
    fs.mkdirSync(dir, { recursive: true });
    try {
      const target = screen.getPrimaryDisplay();
      const size = {
        width: Math.round(target.size.width * target.scaleFactor),
        height: Math.round(target.size.height * target.scaleFactor)
      };
      const shots = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: size });
      if (shots[0]) fs.writeFileSync(path.join(dir, 'screen.png'), shots[0].thumbnail.toPNG());
    } catch (err) {
      console.error('[selftest] screen snapshot failed', err.message);
    }
    if (barWin && !barWin.isDestroyed()) {
      const idleImage = await barWin.webContents.capturePage();
      fs.writeFileSync(path.join(dir, 'bar-idle.png'), idleImage.toPNG());
    }

    await startCapture({ type: regionMode ? 'region' : 'screen', source, display, rect });

    setTimeout(async () => {
      try {
        showSettingsPanel();
        setTimeout(async () => {
          if (panelWin && !panelWin.isDestroyed()) {
            const image = await panelWin.webContents.capturePage();
            fs.writeFileSync(path.join(dir, 'panel.png'), image.toPNG());
            closePanel();
          }
          setTimeout(async () => {
            try {
              showScreenshotPanel();
              await new Promise((resolve) => setTimeout(resolve, 450));
              if (panelWin && !panelWin.isDestroyed()) {
                const shot = await panelWin.webContents.capturePage();
                fs.writeFileSync(path.join(dir, 'panel-shot.png'), shot.toPNG());
                closePanel();
              }
            } catch (err) {
              console.error('[selftest] screenshot panel error', err);
            }
          }, 300);
        }, 500);
        console.log('[selftest] UI snapshots written');
      } catch (err) {
        console.error('[selftest] UI snapshot error', err);
      }
    }, 500);
    setTimeout(() => {
      if (captureWin && !captureWin.isDestroyed()) captureWin.webContents.send('capture:stop');
    }, 4000);
    setTimeout(() => {
      console.error('[selftest] timed out');
      app.exit(1);
    }, 20000);
  } catch (err) {
    console.error('[selftest] error', err);
    app.exit(1);
  }
}

// ---------------------------------------------------------------------- tray

function showBar() {
  if (!barWin || barWin.isDestroyed()) {
    createBarWindow();
    return;
  }
  if (barWin.isMinimized()) barWin.restore();
  barWin.show();
  barWin.setAlwaysOnTop(true, 'floating');
  barWin.focus();
}

function createTray() {
  if (tray) return;

  const image = nativeImage.createFromPath(TRAY_ICON);
  tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image.resize({ width: 16, height: 16 }));
  tray.setToolTip('Screen Recorder');
  console.log('[boot] tray icon created, empty=', image.isEmpty());
  // Clicking the tray icon always brings the window back to the front.
  tray.on('click', () => showBar());
  tray.on('double-click', () => showBar());

  updateTrayMenu();
}

function updateTrayMenu() {
  if (!tray) return;

  const idleNow = state.phase === 'idle';
  const recording = state.phase === 'recording' || state.phase === 'starting' || state.phase === 'stopping';

  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Record area', enabled: idleNow, click: () => startFlow('region') },
      { label: 'Record window', enabled: idleNow, click: () => startFlow('window') },
      { label: 'Record full screen', enabled: idleNow, click: () => startFlow('screen') },
      { type: 'separator' },
      { label: 'Screenshot area', enabled: idleNow, click: () => startScreenshot('region') },
      { label: 'Screenshot window', enabled: idleNow, click: () => startScreenshot('window') },
      { label: 'Screenshot full screen', enabled: idleNow, click: () => startScreenshot('screen') },
      { type: 'separator' },
      { label: 'Stop recording', enabled: recording, click: () => stopCapture() },
      { type: 'separator' },
      { label: 'Show bar', click: showBar },
      { label: 'Hide bar', click: () => barWin && !barWin.isDestroyed() && barWin.hide() },
      { label: 'Open recordings folder', click: openRecordingsFolder },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          isQuitting = true;
          app.quit();
        }
      }
    ])
  );
}

// --------------------------------------------------------------------- boot

if (!app.requestSingleInstanceLock()) {
  app.exit(0);
} else {
  app.on('second-instance', () => {
    if (barWin && !barWin.isDestroyed()) {
      barWin.show();
      barWin.focus();
    }
  });

  app.whenReady().then(() => {
    // In dev there is no shortcut registered for this AUMID, so Windows falls back
    // to the electron.exe icon; only set it for the packaged build.
    if (app.isPackaged) app.setAppUserModelId('com.desktoprecorder.app');
    Menu.setApplicationMenu(null);
    loadSettings();
    registerIpc();

    session.defaultSession.setDisplayMediaRequestHandler(
      (_request, callback) => {
        if (pendingSource) callback({ video: pendingSource });
        else callback({});
      },
      { useSystemPicker: false }
    );

    createCaptureWindow();
    createBarWindow();
    createPanelWindow();
    createTray();

    if (IS_SELFTEST) setTimeout(runSelfTest, 1500);
  });

  app.on('window-all-closed', () => {
    if (isQuitting) app.quit();
  });

  app.on('before-quit', () => {
    isQuitting = true;
    stopCountdown();
    closeCountdownWindow();
    closeRegionWindows();
    if (tray && !tray.isDestroyed()) tray.destroy();
    tray = null;
  });
}
