# DR Dubber Pro

DR Dubber Pro is a desktop studio for dubbing videos into Khmer. You give it a video. It transcribes the speech, translates the subtitles into natural Khmer, voices each line with text-to-speech, separates the background music from the original voices, and renders a finished, dubbed video.

It is an Electron app with a local Node.js/Express backend. FFmpeg and a few Python tools do the heavy media work.

![DR Dubber Pro](assets/logo.png)

Full guide (using the app, settings, architecture, releases, troubleshooting): [docs/DOCUMENTATION.md](docs/DOCUMENTATION.md).

## Features

- **Transcribe**: Gemini direct transcription, or an on-device engine ([whisper_engine/](whisper_engine/), faster-whisper) followed by translation.
- **Translate to Khmer**: drama-aware translation with genre styles (romance, action, horror, mystery, fantasy, family, youth, …). It keeps character names the same across episodes, shortens lines that are too long for their time slot, and catches Latin text that slips through.
- **AI voices**: Microsoft Edge TTS Khmer voices (`km-KH-PisethNeural`, `km-KH-SreymomNeural`) with per-line emotion, speed and pitch. Each line keeps its Male/Female voice. VoxCPM2 voice cloning is optional.
- **Isolate BGM**: removes the original voices and keeps the music and effects. MDX-Net (UVR-MDX-NET-Voc_FT, default, runs on the GPU through DirectML on Windows), Demucs, Spleeter or plain FFmpeg.
- **Blur Subtitles**: finds hard-coded on-screen text (RapidOCR) and blurs it.
- **Timeline editor**: NLE-style timeline with video thumbnails, the original audio's waveform, and every dubbed line drawn as its own waveform.
- **Dub Whole Series**: hands-free batch dubbing of a whole series. It joins or splits episodes into parts, rotates spare Gemini keys, resumes after errors, and exports with progress.
- **Render**: hardware encoder detection, subtitle styling that matches the preview, and clean cancel (no half-written files left behind).
- **Self-update**: the app checks [update.json](update.json) on `main` for new releases.
- **English or Khmer interface**: switch with **EN / ខ្មែរ** in the header or in **Settings → General**. Subtitles and dubbing are not affected.

## Requirements

| | Needed for |
| :--- | :--- |
| **Node.js 22** and npm | Running and building the app |
| **FFmpeg / FFprobe** | All media work. Put the binaries in `backend/bin/` or have them on `PATH` (WinGet installs are found automatically). |
| **Python 3.11** | TTS, transcription, BGM separation and text detection. On Windows, `setup_python_env.bat` downloads its own portable copy. |
| **Gemini API key** (or a CodeCraft `cc_` key) | Transcription and translation. You enter keys in the app's **Settings**, not in `.env`. |

Windows is the main platform: CI runs there and the installer is built for it. macOS works for development.

## Getting started

```bash
git clone https://github.com/chhordalim14/dr-dubber.git
cd dr-dubber
npm install
```

**Windows**: set up the bundled Python environment (Edge TTS, the text detector and the MDX-Net model, about 64 MB):

```cmd
setup_python_env.bat
```

Then start the app:

```bash
npm start
```

You can also double-click `Run-DR-Dubber-Pro.bat` (Windows) or `Run-DR-Dubber-Pro.command` (macOS).

### Optional engines

| Engine | Setup |
| :--- | :--- |
| Spleeter (BGM) | `setup_spleeter.bat` (creates `backend/spleeter-env`, not shipped in the installer) |
| Demucs (BGM) | `pip install -r backend/python/requirements-demucs.txt` into `backend/demucs-env` |
| Local Whisper | See [whisper_engine/README.md](whisper_engine/README.md), then pick the folder in **Settings → General → Transcription Engine** |

### Configuration

Nothing needs configuring. Every setting has a working default. To change one, copy [.env.example](.env.example) to `.env`:

| Variable | Default | Purpose |
| :--- | :--- | :--- |
| `PORT` | `3001` | Port of the local backend |
| `APP_STORAGE_DIR` | `./storage` (app-data folder when packaged) | Uploads, separated audio, exports and logs |
| `PYTHON_PATH` / `PYTHON_BIN` | auto-detected | Python interpreter to use for the ML tools |

## Scripts

| Command | What it does |
| :--- | :--- |
| `npm start` | Builds the Tailwind CSS and launches the Electron app |
| `npm run server` | Runs only the backend (`backend/server.js`) |
| `npm test` | Runs the test suite with `node --test` |
| `npm run watch:css` | Rebuilds `frontend/css/tailwind-built.css` on every change |
| `npm run dist:win` | Builds the Windows installer and portable exe into `release/`. It needs `setup_python_env.bat` to have run first. |
| `npm run dist:mac` | Builds the macOS `.dmg` / `.zip` |

## Project layout

```
main.js, preload.js     Electron main process and the locked-down IPC bridge
backend/
  server.js             Express API: transcribe, translate, TTS, BGM, batch
  routes/               Render, preview, split, episodes, waveform, text detect, system
  lib/                  Prompts, Khmer text rules, key handling, security, paths, workers
  python/               TTS, transcription, vocal separation (MDX-Net ONNX) and text detection
  render_service.js     FFmpeg render pipeline
  episode_joiner.js     Joins episodes into parts for series dubbing
  video_splitter.js     Splits merged videos back into parts
frontend/
  index.html            The studio UI
  js/                   Studio logic, timeline, subtitle layout, Gemini models, Khmer speech
  js/i18n.js, i18n-km.js  Khmer interface: the translator and its English → Khmer dictionary
  css/                  Tailwind source/build and theme styles
whisper_engine/         Optional on-device faster-whisper transcriber
tests/                  Node test suite
storage/                Runtime data (uploads, cache, exports, logs). Ignored by git.
```

## Security

The backend can read and write files on your machine, so it only answers the app's own window. It:

- listens on `127.0.0.1` only
- rejects requests with a foreign `Host` or `Origin` header
- requires a random token, created at each launch and passed to the window as an HttpOnly cookie

See [backend/lib/security.js](backend/lib/security.js). API keys stay in the app's settings and are sent with each request. They are never read from environment files.

## Releasing

1. Bump `version` in [package.json](package.json).
2. On Windows, run `setup_python_env.bat`, then `npm run dist:win`.
3. Upload the installer from `release/` to a GitHub release.
4. Update [update.json](update.json) with the new version, download link and notes. Installed apps read this file to offer the update.

## License

MIT
