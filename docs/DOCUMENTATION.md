# DR Dubber Pro — Documentation

Last updated: 2026-11-17

## Overview

DR Dubber Pro turns a foreign-language video into a finished Khmer-dubbed video on your own computer. It transcribes the speech, translates it into natural Khmer, voices each line with text-to-speech, keeps the original music and effects, and renders the final video. The current release is v1.17.1.

It is built for editors who dub drama series into Khmer, often a whole season at a time. It is an Electron desktop app with a local Node.js/Express backend; FFmpeg and a few Python tools do the media work. Windows is the main platform; macOS works for development.

| Stage | What it does | Engines |
| --- | --- | --- |
| Transcribe | Turns speech into timed subtitles | Gemini direct (API keys, or Gmail accounts through the Gemini Web Router), or local Whisper then translation |
| Translate | Drama-aware Khmer translation with genre styles; keeps character names consistent across episodes, shortens lines too long for their slot | Gemini (or a CodeCraft `cc_` key) |
| Voice | Speaks each line with per-line emotion, speed and pitch; keeps each line's Male/Female voice | Edge TTS `km-KH-PisethNeural`, `km-KH-SreymomNeural`; optional VoxCPM2 cloning |
| Isolate BGM | Removes the original voices, keeps music and effects | MDX-Net (default), Demucs, Spleeter, FFmpeg |
| Blur subtitles | Finds burned-in on-screen text and blurs it | RapidOCR |
| Render | Encodes the final video with styled subtitles | FFmpeg with hardware encoder detection |

## Getting started

Install Node.js 22, FFmpeg and a Gemini key, then `npm install` and `npm start`. Nothing else needs configuring: every setting has a working default.

| Requirement | Needed for |
| --- | --- |
| Node.js 22 and npm | Running and building the app |
| FFmpeg / FFprobe | All media work. Put the binaries in `backend/bin/` or on `PATH`; WinGet installs are found automatically. |
| Python 3.11 | TTS, transcription, BGM separation and text detection. On Windows, `setup_python_env.bat` downloads a portable copy. |
| Gemini API key | Transcription and translation. Entered in the app's Settings, never in `.env`. Alternatives: Gmail accounts through the Gemini Web Router (see Settings), or a CodeCraft `cc_` key for text jobs only. |

### Install and run

1. Clone and install dependencies:

   ```bash
   git clone https://github.com/chhordalim14/dr-dubber.git
   cd dr-dubber
   npm install
   ```
2. On Windows, set up the bundled Python environment (Edge TTS, the text detector and the MDX-Net model, about 64 MB): run `setup_python_env.bat`. On a Mac, the MDX-Net model downloads itself the first time you isolate BGM.
3. Start the app with `npm start`. This builds the Tailwind CSS, then launches Electron. You can also double-click `Run-DR-Dubber-Pro.bat` (Windows) or `Run-DR-Dubber-Pro.command` (macOS).
4. Open **Settings** and paste your Gemini key. Add spare keys too: series dubbing rotates through them when one hits its quota.

### Optional engines

| Engine | Setup |
| --- | --- |
| Spleeter (BGM) | `setup_spleeter.bat` creates `backend/spleeter-env`; not shipped in the installer |
| Demucs (BGM) | `pip install -r backend/python/requirements-demucs.txt` into `backend/demucs-env` |
| Local Whisper | Follow `whisper_engine/README.md`, then pick the folder in **Settings → General → Transcription Engine** |

### Developer scripts

| Command | What it does |
| --- | --- |
| `npm start` | Builds the CSS and launches the Electron app |
| `npm run server` | Runs only the backend (`backend/server.js`) |
| `npm test` | Runs the test suite with `node --test` (65 test files in `tests/`) |
| `npm run build:css` | Builds `frontend/css/tailwind-built.css` once (`npm start` does this first) |
| `npm run watch:css` | Rebuilds `frontend/css/tailwind-built.css` on every change |
| `npm run pack` | Builds an unpacked app folder for a quick check, no installer |
| `npm run dist:win` | Builds the Windows installer and portable exe into `release/`; fails unless `setup_python_env.bat` has run |
| `npm run dist:mac` | Builds the macOS `.dmg` and `.zip` |

## Using the app

A single video goes Load → Transcribe → Generate Audio → Isolate BGM → Blur Subtitles → Render. A whole season goes through **Dub Whole Series**, which runs the same steps for each part without you. While one part is voiced and blurred, the next part is already cut into tabs and transcribed in the background, so its Transcribe step finds the results ready. Spare Gemini keys (more keys than tabs) are lent to the tabs: each tab is cut into ~2-minute pieces asked at the same time.

### Where things are

The rail on the left opens a drawer for each area. The subtitle panel on the right has three tabs.

| Area | What it holds |
| --- | --- |
| **Media** | Load Video, Import SRT, Join Episodes, Split Movie, Dub Whole Series, DAI-Transcribe Studio (Batch), Clear All Data |
| **Audio** | Isolate BGM (and Isolate All), Load Background Music, Auto-Ducking (Light −8 dB, Standard −14 dB default, Deep −20 dB), Mute Original Video Audio |
| **Video** | Blur Censor, Blur Subtitles, Match Subtitles to Video |
| **Series** | Opens the Dub Whole Series window |
| **Effects** | Color, Vignette, Video Presets, Aspect Ratio, Crop |
| Subtitles tab | Language, Add Text, Transcribe, Edit, Delete, Find (Ctrl+H) |
| AI Dubbing tab | Drama genre, DAI-Transcribe, All Tabs menu, Fix Missing, AI Refactor (Natural & Short, Ultra-Short, Dramatic, Royal, Comedy) |
| Voice tab | Male / Female / profile per line, Reverb, Auto-Fit, Sync End, Fit Audio Slot, Fix Rushed Lines (the amber "N rushed" chip), Generate Audio, Generate All Tabs |

### Dub one video

1. **Media › Load Video**, or **Open Video** in the header to open it in a new tab.
2. **Subtitles › Transcribe**. In Direct mode Gemini writes Khmer subtitles straight from the speech. To bring your own, use **Import SRT**.
3. Check the translation. **Fix Missing** re-translates only lines with no Khmer; **AI Refactor** rewrites lines in a chosen tone.
4. In **Voice**, assign **Male** (Piseth) or **Female** (Sreymom) and press **Generate Audio**. If a line sounds rushed, an amber **N rushed** chip appears beside Auto-Fit: click it to give the lines the free time after them or have AI rewrite them shorter, then apply and regenerate. Or use **Fit Audio Slot** to change its tempo.
5. **Audio › Isolate BGM** removes the original voices and keeps the music.
6. **Video › Blur Subtitles** hides burned-in text. **Match Subtitles to Video** re-times lines to the picture.
7. Fine-tune on the timeline: Zoom, Split, and per-clip Speed (0.5–2.5), Vol (0–5) and Pitch (±12).
8. **Export › Render Video**. Choose Video + Audio or Audio Only, a subtitle style (Classic Cinema, TikTok Pop, Neon Cyan, Royal Gold), loudness normalisation to −14 LUFS and the file name, then **Start Render** or **Add to Queue**. **Export SRT** saves just the subtitles.

Every button in the **All Tabs** menu runs that step on every open tab, so you can load all episodes, then transcribe, fix, blur and translate them in one go.

### Dub a whole series

1. Open **Series** and **Choose Folder** with the episodes.
2. Set **Join: minutes per part** (default 50) and **Split: minutes per tab** (default 7). Episodes are joined into parts, and each part is split into tabs.
3. If your videos are already one per part, tick **Videos are already merged**. It ticks itself when every video is 20 minutes or longer. To dub each episode as its own tab with nothing joined or split, tick **Each episode its own tab**.
4. Pick the steps (Transcribe, Match subtitles, Generate voices, Isolate BGM, Blur subtitles; all on by default) and a Drama Style.
5. Optional: a **Color filter** applied to every tab, from a Color Studio preset (a Drama LUT or a saved custom one).
6. Turn on **Hands-free** to export each part and start the next one. **Join into one video** joins the exports per part or into one video for the whole series. **Delete working files** removes the joined and split files at the end.
7. Optional: **Episodes at once** (how many tabs are transcribed together, default 8) and **Retry failed** (how often a failed tab is tried again, default 2).
8. Press **Start**.

Progress is saved after every step. After a Stop, a quota pause or a restart, **Continue** picks up where it left off. In Hands-free mode it also resumes by itself: up to 16 tries over about 14 hours for a used-up daily quota, which resets at midnight Pacific. Problems you must fix in Settings wait for you to press Continue.

## Settings

Most choices live in **Settings** (General, API Keys, VoxCPM2 AI, Theme, Shortcuts, Statistics, About), with a search box at the top. Settings are saved per user in the app; API keys are never read from `.env`.

### VoxCPM2 voice cloning

**Settings → VoxCPM2 AI → Install VoxCPM2** sets everything up in one click: a private Python environment (needs Python 3.10–3.12 on the PC), PyTorch, the `voxcpm` package, the `openbmb/VoxCPM2` model (4.6 GB) and the app's own server (`backend/python/voxcpm2_server.py`, copied in as `app.py`). The default folder is `%USERPROFILE%\DR Dubber VoxCPM2` (about 12 GB free needed). With an NVIDIA card of 6 GB or more it installs the GPU build; otherwise the CPU build, which works but is slow: about 30 seconds of computing per second of speech (measured on an i5-12400), so a 3-second line takes 1–2 minutes. A stalled download restarts itself and resumes; clicking Install again also repairs or finishes an interrupted install. When it is done, **VoxCPM2 Local Path** is filled in and **Start Server** loads the model (the status turns ready when it is loaded).

The server listens on `127.0.0.1:8808` only: `GET /` answers 503 while the model loads and 200 when ready; `POST /api/generate` takes `text`, `instruction` (a voice/style description, passed to VoxCPM2 in brackets before the text) and the reference clip as `reference_audio_base64`, and returns `audio_base64` and `duration`. Any server with the same API (for example on a cloud GPU) can be used instead through **Server URL**.

**How each line is said.** With **Clone voices from video** on, every speaker found in the video gets a voice cloned from the video itself, and each of their lines takes its delivery from the actor saying that very line: the backend cuts the line from the video (`POST /api/voice-capture/line`) and the server clones the line from it, while the speaker's own clip and anchor keep the voice the same in every feeling. The cut comes from the separated vocals once **Isolate BGM** has run on the video (from a 5.1 track's dialogue channel before that); a stereo track that has not been isolated is not used, as the music under the line would be copied into the dub, so the line falls back to the speaker's clip of its emotion, as do lines under 1.6 s (too little to clone from). Measured on 96 lines of a C-drama spoken with their real Khmer translations, the dub's pitch then follows the actor's from line to line (correlation 0.19, where the speaker's clip with the written emotion gave 0.00), with the same voice and Khmer as clear: a real step, though the dub still follows the actor only in part. Each dub line is also as loud as the actor said it against the film's other dialogue (60% of the difference, −9 to +6 dB), so a whisper stays under and a shout over. A voice picked by hand never takes the original actor's audio. Each line is also told its room on the timeline (`fit_seconds`): of the takes VoxCPM2 draws, one that fits is kept over one that would have to play rushed.

### Gemini Web Router

The Router lets Gmail accounts do transcription and translation instead of API keys. Open it with the **Gemini Web Router** button in **Settings → API Keys**, press **Install** (needs Python 3.10 or newer), add each Gmail and turn on **Use for dubbing**. By default the Gmails are used first and your API keys are the backup. In **Dub Whole Series** each ready Gmail transcribes its own tab, so set **Episodes at once** to about the number of Gmails you have. With ready Gmails, no API key is needed in Settings. Using Gmail accounts this way is against Google's terms and accounts can be banned: use only accounts you can afford to lose. How it works: [ARCHITECTURE.md › Gemini Web Router](ARCHITECTURE.md#10-gemini-web-router).

### Interface language

Switch between English and Khmer with **EN / ខ្មែរ** in the header or **Settings → General → Interface Language**. The default is English. This changes only the app's own labels; subtitles and dubbing stay Khmer either way. The translator is `frontend/js/i18n.js` and its English → Khmer dictionary is `frontend/js/i18n-km.js`.

### General settings

| Setting | Options | Default |
| --- | --- | --- |
| Gemini AI Model | Supported Gemini models; a saved model Google has retired switches to a working one | — |
| API Saver mode | Fewer, longer requests: pieces of about 9 min (up to 10 min in one request), and no extra gap check. Turned off automatically while Gmails from the Gemini Web Router are used | On |
| Transcription Engine | Direct (Gemini), Whisper + Translate | Direct (Gemini) |
| Vocal Removal Engine | MDX-Net (Best), Demucs, Spleeter, FFmpeg (Instant) | MDX-Net |
| Hardware Acceleration (Vocal Removal) | GPU, CPU. GPU: DirectML on Windows, Core ML (MDX-Net) and Apple's GPU (Remove music) on a Mac, each going back to the CPU by itself if the GPU fails | GPU |
| Performance | Auto (from this PC), Light, Standard, Strong. How much runs at the same time: exports, Isolate BGM tabs, subtitle searches, Transcribe tabs and voice requests. Auto picks **Light** for less than about 12 GB of RAM or 4 CPU threads or fewer, **Strong** for 30 GB and 12 threads or more, else **Standard** (the app's usual limits). The section shows what was found and the limits in use. Whatever is chosen, a big job waits while free RAM is short and another job is still running (20 minutes at most) | Auto |
| Demucs Segment Size | 1–7 | 7 |
| Final Video Rendering | GPU (Auto): uses NVIDIA, Intel Quick Sync, AMD or Mac hardware encoding when it works, otherwise the CPU. CPU (x264): always the CPU | GPU (Auto) |
| Concurrent Audio Generation | 1–10 lines per tab. Across every tab at most 5 Edge requests are open at once | 3 |
| Save Path (For Exported Video) | Any folder | `C:\Export\AIDubber` on Windows |
| Generated Audio Temp Path | Any folder | `C:\Temp\AIDubber` on Windows |
| Auto Save Subtitle | After transcription, with gender tag, beside the source or in a custom folder | — |

**API Keys** holds one or more Gemini keys. Add several from different Google projects: the backend rotates through them, skips invalid ones and parks rate-limited ones. **Theme** offers nine presets (Midnight Violet, Studio Grey, Coral Sunset, Sky Blue, Fresh Mint, Classic Indigo, Midnight Blue, Forest Green, Rose Gold). **About → Check for Updates** checks for a new release.

### Environment overrides

Only needed to override a default. Nothing reads a `.env` file, although `.env.example` suggests one: set these as real environment variables before starting the app.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PYTHON_PATH` / `PYTHON_BIN` | Auto-detected (bundled `backend/python_env` first) | Python used for the ML tools |
| `PORT` | `3001` | Backend port, for `npm run server` only. The Electron app always uses 3001, and setting `PORT` there breaks it |
| `VOXCPM_IDLE_MINUTES` | `15` | Minutes with no line spoken before the VoxCPM2 server unloads its model to free memory (the next line loads it again, about 40 s). `0` keeps it loaded |
| `APP_STORAGE_DIR` | `./storage` in development; the app-data folder when installed | Storage folder, for `npm run server` only. The Electron app always sets it itself |

### Where files are stored

| What | Where |
| --- | --- |
| Rendered videos | The Save Path; if none is set, `storage/exports` |
| Transcription output | The custom folder, else the video's own folder, else `storage/outputs` |
| Working data | `storage/`: uploads, audio\_cache, separated, preview\_cache, audio\_repair, exports, outputs |
| Saved results | `storage/`: batch\_results (finished transcripts), character\_sheets (names per series), series\_checkpoints, text\_detect, pronunciation, VoiceCaptures, gemini\_web |
| API keys and settings | The app window's local storage, not a file you edit |
| Key rest records | `gemini_key_rest.json` in the Electron userData folder |
| VoxCPM2 and Gemini Web Router | `~/DR Dubber VoxCPM2`, `~/DR Dubber Gemini Web` |
| Logs | `storage/logs`: `crash.log`, `server.log`, `voxcpm_debug.log`. **Settings → General → Open Logs** opens the folder. |
| Presets and device files | The Electron userData folder: `presets.json`, `approved-programs.json`, `device_id.txt` |

`storage/` sits in the project folder during development and under the user's app-data folder when installed. **Clear Cache** in Settings empties the caches; **Media › Clear All Data** resets the studio.

## How it works

Everything runs on your computer except the AI services: Gemini (by API key, or through the Gemini Web Router's Gmail accounts), CodeCraft for text jobs, and Microsoft's Edge TTS. The Electron app loads a local Express backend, which the window talks to over HTTP on 127.0.0.1:3001. FFmpeg and Python do the media work.

| Stage | Where the code is |
| --- | --- |
| Editor, tabs, timeline, series run | `frontend/js/studio-main.js` |
| Transcribe, translate, key rotation | `backend/routes/gemini.js` |
| Gemini Web Router | `backend/lib/gemini-web-router.js`, `backend/python/gemini_web_server.py` |
| Voices | `backend/server.js` (Edge TTS), `backend/python/voxcpm2_server.py` (VoxCPM2) |
| Isolate BGM | `backend/server.js`, `backend/python/vocal_separator.py` |
| Blur subtitles | `backend/text_detect_service.js`, `backend/python/text_detector.py` |
| Render | `backend/render_service.js` |

The full design — every pipeline as a flowchart, the HTTP and IPC reference, where state is stored, and known issues — is in [ARCHITECTURE.md](ARCHITECTURE.md).

## Releases and updates

A release is a version bump, a Windows installer on GitHub Releases, and an edit to `update.json` on `main`. Installed apps learn about it only when someone presses **Settings → About → Check for Updates**; there is no check at startup.

### How an installed app finds an update

1. The app fetches `https://raw.githubusercontent.com/chhordalim14/dr-dubber/main/update.json` (8 s timeout).
2. It compares `version` with its own version.
3. If newer, it shows a dialog with `notes`.
4. **Start Update** opens `link` (Windows) or `mac_link` (macOS) in the browser. The user downloads and runs the installer; the app does not download it itself.

| Field | Meaning | Today |
| --- | --- | --- |
| `version` | Latest version, compared as semver | `1.20.1` |
| `link` | Windows installer URL | `DR.Dubber.Pro.Setup.1.20.1.exe` on the v1.20.1 release |
| `mac_link` | macOS `.dmg` URL | Still the v1.2.1 arm64 `.dmg` |
| `notes` | Release notes shown in the dialog and the app's release notes | v1.20.1 notes |

### Cutting a release

1. Bump `version` in `package.json` and update `update.json` with the new `version`, `link` and `notes`. Commit, and tag the commit `vX.Y.Z`.
2. Push only the tag (`git push origin vX.Y.Z`). The Release workflow (`.github/workflows/release.yml`, on `windows-latest`) checks the tag matches `package.json`, runs `setup_python_env.bat` (portable Python, text detector and the MDX-Net model), puts FFmpeg essentials in `backend/bin`, runs `npm run dist:win`, and uploads `DR Dubber Pro Setup X.Y.Z.exe` to the release `vX.Y.Z`. If the release doesn't exist yet it is made with `update.json`'s notes. It can also be run by hand from the Actions tab with a tag.
3. When the installer is on the release, push `main`. Apps see the update from that moment; pushing `main` first would offer a link that isn't there yet.

To build by hand instead: on Windows, run `setup_python_env.bat` (`npm run dist:win` refuses to build without the MDX-Net model), then `npm run dist:win`, and upload the installer from `release/`.

CI (`.github/workflows/test.yml`) runs on every push and pull request on Windows with Node 22: `npm ci`, a syntax check of `main.js`, `backend/server.js` and `preload.js`, then `npm test`. It never launches Electron, so check the UI by hand before tagging.

## Troubleshooting

Most failures are a used-up Gemini quota, a missing Python or FFmpeg, or a BGM engine that does not suit the machine. Start with the logs: **Settings → General → Open Logs** (`storage/logs/server.log` and `crash.log`).

| You see | Cause | Fix |
| --- | --- | --- |
| "Please add at least one Gemini API Key in Settings." | No key saved | Add a key in **Settings → API Keys** |
| "Google reports the daily free Gemini quota used up on all N API key(s)…" | Every key hit its daily limit | Wait for the reset at midnight Pacific, pick another Gemini model, or add a key from another Google project |
| "All N API key(s) are rate-limited by Google - free again in …" | Too many requests per minute | Wait the time shown; lower **Concurrent Audio Generation**, or check **API Saver mode** is still on |
| "Fix Missing skipped: the daily Gemini quota is used up." | Quota ran out mid-run | After the reset, run **All Tabs › Fix Missing in all tabs** |
| "No working Python environment found for text-to-speech…" | Python not found | Windows: run `setup_python_env.bat`. Otherwise install Python 3.11 with "Add to PATH" and `pip install edge-tts`, or set `PYTHON_PATH` |
| Isolate BGM crashes or hangs | GPU driver problem with MDX-Net | Set **Hardware Acceleration (Vocal Removal)** to CPU |
| The computer freezes or runs out of memory during Dub Whole Series (16 GB of RAM) | Several heavy steps at once. The biggest are Spleeter (about 6.4 GB a tab) and Remove music (3.7 GB a tab on a Mac's GPU) | Keep **Vocal Removal Engine** on MDX-Net (0.9–1.7 GB a tab). On 16 GB or less the app already isolates one tab at a time and runs Spleeter and Remove music one at a time; turning **Remove music from BGM** off saves the most. On a small PC set **Settings → General → Performance** to **Light** (one export, one search, three Transcribe tabs at once). Keep 20 GB or more free on the disk: a full disk stops the system from swapping |
| Many `[Retry 1/8] Audio gen retry … No audio was received` lines | Microsoft is turning lines away because too many arrived too fast. It is not the text | Nothing to fix: the app sends fewer at once and rests 30–60 s, and every line is retried |
| Dozens of `[Retry 1/8] Audio gen retry … Failed to fetch` lines at the same moment | Requests from the window to the app's own server were dropped all at once | The lines are retried by themselves. The next line in the log, `[Network] … failed: net::ERR_…`, names the reason (e.g. `ERR_NETWORK_CHANGED`: a VPN or Wi-Fi change) |
| "BGM is only FFmpeg phase cancellation - it may have almost no music…" | The FFmpeg fallback engine ran | Switch **Vocal Removal Engine** to MDX-Net |
| "DR Dubber Pro could not start" | Port 3001 is in use, often by a second copy | Close the other copy, or whatever else uses port 3001. The port can't be changed for the app |
| "Unexpected Error" dialog | An uncaught error; the app keeps running | Send `storage/logs/crash.log` with a bug report |
| Media steps fail with no clear message | FFmpeg / FFprobe not found; the app has no dedicated message for this | Put the binaries in `backend/bin/` or on `PATH` |
| A render was cancelled or failed | — | Nothing to clean up: temp files and any half-written output are deleted |
| A series run stopped | Stop, quota pause or app restart | Open **Series** and press **Continue**; it resumes from the last finished step |
