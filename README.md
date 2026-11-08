# Desktop Recorder

A desktop screen recorder built on  Electron + RecordRTC, no extra tooling required.

## Features

- **Area recording:** the screen dims, you drag a rectangle, and only that region is recorded.
- **Window recording:** open windows are listed with live thumbnails; pick one and it is recorded.
- **Full screen:** records the whole monitor the cursor is on.
- **Screenshots:** area, window or full screen, saved as PNG next to the recordings.
- **Countdown:** 0 / 3 / 5 / 10 seconds. Recording starts automatically when it expires; the countdown never appears in the video.
- **While recording** the bar switches to a red dot, elapsed time and a stop button.
- When recording stops the file is saved automatically; the panel offers "Show in folder" and "Open video".

## Interface

A single-row dark bar that floats above the desktop, always on top and draggable:

```
[ area ]  [ window ]  [ screen ] │ [ camera ]  [ countdown 3s ]  [ folder ]
```

Hovering an icon shows a tooltip; clicking starts recording in that mode (with the countdown first, if enabled). A slim header above the icons shows `Screen Recorder` and a close button. Drag the bar anywhere; its position is remembered.

## System tray

The app keeps running in the system tray. Closing the bar with its × only hides it — the app stays alive
and the tray icon brings it back. The tray menu offers every capture action (record or screenshot an area,
a window or the full screen), stop recording, open the recordings folder, show the bar and quit.

## Install and run

```bash
npm install
npm start
```

## Release build

```bash
npm run build          # Windows -> dist/windows
npm run build:linux    # Linux   -> dist/linux (AppImage)
npm run build:linux:tar # Linux   -> dist/linux (tar.gz, works from Windows)
```

The Windows target produces `dist/windows/Desktop Recorder Setup <version>.exe` (NSIS installer) plus
`dist/windows/win-unpacked/`. The Linux target produces `dist/linux/*.AppImage`.
The installer icon comes from `256-icon.ico`; the window and tray icons live in `src/assets/`.

AppImage packaging creates symlinks, which Windows only allows with Developer Mode (or on Linux/CI);
use `build:linux:tar` when building the Linux bundle from Windows.

## Installing on Linux from the tar.gz bundle

`npm run build:linux:tar` produces `dist/linux/desktop-recorder-1.0.0.tar.gz`. The archive is a complete,
self-contained copy of the app: nothing has to be installed system-wide, and deleting the folder removes
the app again. The steps below assume no Linux experience.

**1. Extract the archive**

- File manager: right-click `desktop-recorder-1.0.0.tar.gz` and choose **Extract Here** (or "Extract to…").
- Terminal:

  ```bash
  cd ~/Downloads
  tar -xzf desktop-recorder-1.0.0.tar.gz
  ```

Either way you end up with a folder named `desktop-recorder-1.0.0`.

**2. Make the launcher executable, then start it**

```bash
cd ~/Downloads/desktop-recorder-1.0.0
chmod +x desktop-recorder
./desktop-recorder
```

`chmod +x` is needed once because the archive is built on Windows, which cannot store Linux permission
bits. After that you can double-click `desktop-recorder` in the file manager.

**3. If it refuses to start with a sandbox error**

```
The SUID sandbox helper binary was found, but is not configured correctly.
```

Start it without Chromium's sandbox:

```bash
./desktop-recorder --no-sandbox
```

or repair the helper once (asks for your own password, the safer option):

```bash
sudo chown root:root chrome-sandbox
sudo chmod 4755 chrome-sandbox
```

**4. Add it to the applications menu (optional)**

Create the file `~/.local/share/applications/desktop-recorder.desktop` with:

```ini
[Desktop Entry]
Type=Application
Name=Desktop Recorder
Comment=Record the screen, a window or an area
Exec=/home/YOUR_USER/Downloads/desktop-recorder-1.0.0/desktop-recorder
Terminal=false
Categories=Utility;
```

Replace `YOUR_USER` with your user name and adjust the path if you extracted the folder somewhere else.
No icon file ships inside the tar.gz, so the menu entry uses a generic icon; recording is unaffected.

**5. Where files go**

Recordings and screenshots are saved in your Videos folder, in a `Desktop Recorder` subfolder; the folder
icon on the bar opens it. Settings and the bar position are stored in `~/.config/Desktop Recorder/`.

**Notes**

- On a Wayland session, screen capture can fail on some desktops; start the app with
  `./desktop-recorder --ozone-platform-hint=x11` (or log in with an Xorg session) if that happens.
- To update, download the new `tar.gz`, delete the old folder and repeat steps 1–2.

**AppImage alternative:** `npm run build:linux` writes `desktop-recorder-1.0.0.AppImage`. Run it with
`chmod +x desktop-recorder-1.0.0.AppImage && ./desktop-recorder-1.0.0.AppImage`; if it reports a missing
FUSE library, install `libfuse2` (Ubuntu/Debian: `sudo apt install libfuse2`) or use
`./desktop-recorder-1.0.0.AppImage --appimage-extract-and-run`.

## Recordings folder

Default: `C:\Users\<user>\Videos\Desktop Recorder`

The folder icon on the bar opens it; the clock icon opens a panel where you can change the countdown and the recordings folder.

## Architecture

```
src/
  main/main.js            Electron main process: state machine, overlay windows, IPC, file writes
  preload/preload.js      Narrow IPC bridge exposed to renderers
  renderer/
    bar/                  Always-on-top recording bar
    region/               Full-screen transparent area selection (one window per monitor)
    picker/               Window picker (desktopCapturer thumbnails)
    countdown/            Countdown bubble
    panel/                Settings and "saved" panel
    capture/              Hidden renderer: getDisplayMedia + RecordRTC
  assets/icon.png         App icon for the window
  vendor/RecordRTC.js     Browser build copied from the recordrtc package
```

Flow: bar → main process → (`desktopCapturer` source selected) → countdown → the hidden capture window
gets the stream via `getDisplayMedia`. Area recordings are cropped on a canvas (`drawImage` + `captureStream`)
before reaching RecordRTC; window/screen recordings feed the stream straight through. Output is VP9/VP8 WebM.

The renderer produces a `Blob`, sends it to the main process as an `ArrayBuffer`, and the main process writes it to disk.

## Notes

- Selection and countdown windows are marked with `setContentProtection(true)`; on Windows 10 2004+ the bar and
  the countdown are excluded from the capture by Windows Graphics Capture. On older Windows versions the bar may
  show up as a black rectangle in the recording.
- Audio is not recorded (it was not requested); video only.
- With multiple monitors a selection layer opens on each screen, but a recording covers one screen/region only.
- WebM files carry no duration metadata; some players load the progress bar late, while Chrome/VLC/Windows Media
  Player handle them fine.

## Development self-test

To verify the end-to-end recording pipeline (screen → RecordRTC → file) without using the GUI:

```bash
# full screen recording, 4 seconds, then the app quits
RECORDER_SELFTEST=1 npx electron .

# area (crop) recording
RECORDER_SELFTEST=region npx electron .

# the real interactive flow (bar → countdown → record)
RECORDER_SELFTEST=flow npx electron .
```

Artifacts: `.selftest/` (frame captures) and `recording-*.webm` in the recordings folder.

## RecordRTC
* MIT License - Muaz Khan
* https://github.com/muaz-khan/RecordRTC