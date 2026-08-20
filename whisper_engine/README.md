# 🎙️ DR Dubber Local Whisper Engine

> High-performance, on-device speech-to-text engine powered by **faster-whisper** (CTranslate2) with seamless integration into **DR Dubber**.

---

## 📦 What's Inside

| File | Description |
| :--- | :--- |
| `setup.sh` | **1-Click Installer** for macOS / Linux (creates isolated virtualenv & installs packages) |
| `setup.bat` | **1-Click Installer** for Windows (creates isolated virtualenv & installs packages) |
| `run.sh` | High-speed launcher for macOS / Linux |
| `run.bat` | High-speed launcher for Windows |
| `transcribe.py` | Standalone CLI transcriber with real-time subtitle timestamps & hardware acceleration |
| `requirements.txt` | Minimal dependencies (`faster-whisper>=1.0.0`) |

---

## 🚀 1-Click Quick Setup

### On macOS / Linux
Open your Terminal, navigate into this folder, and run:
```bash
./setup.sh
```

### On Windows
Double-click `setup.bat` (or run in Command Prompt):
```cmd
setup.bat
```

---

## ⚡ Connecting with DR Dubber

1. Open **DR Dubber**.
2. Go to **Settings (⚙️)** ➔ **General** ➔ **Transcription Engine**.
3. Select **"Whisper + Translate"**.
4. In **Whisper Folder Path**, click **Browse** and choose this `whisper_engine` folder:
   - **Mac / Linux:** `/Users/.../dr-dubber/whisper_engine`
   - **Windows:** `C:\...\dr-dubber\whisper_engine`
5. Transcribe any audio or video file instantly on your device!

---

## 💻 Manual CLI Usage (Optional)

You can also run transcription directly from your command line:

```bash
# Basic transcription
./run.sh --audio sample.mp3 --output_srt subtitles.srt

# Specify model and language
./run.sh --audio interview.mp4 --model base --language en --device auto
```

### Available Options:
- `--audio` / `-i`: Path to input media file (mp3, wav, mp4, mkv, etc.)
- `--output_srt` / `-o`: Output `.srt` subtitle destination path
- `--model` / `-m`: Model size (`tiny`, `base`, `small`, `medium`, `large-v3`) *(default: `medium`)*
- `--language` / `-l`: Target speech language code (e.g. `en`, `zh`, `ja`, `km`, or `auto`) *(default: `auto`)*
- `--device` / `-d`: Compute device (`auto`, `cpu`, `cuda`) *(default: `auto`)*
