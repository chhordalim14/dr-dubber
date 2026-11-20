---
description: Khmer Text-to-Speech Normalization and Audio Generation Rules for DR Dubber
globs: ["**/*khmer*", "**/*tts*", "**/*voxcpm*", "backend/routes/gemini.js", "frontend/js/studio-main.js", "frontend/js/khmer-speech.js"]
---

# Khmer Text-to-Speech & Dubbing Standards

When working on Khmer text normalization, TTS generation, or subtitle dubbing:

1. **Khmer Dictionary Compliance**:
   - Follow standard Khmer Dictionary (Chuon Nath / NCKL) spelling.
   - Numbers (0-9 and ០-៩) must be normalized into full Khmer words.
   - Decimals: Spoken natural style (e.g. 99.99 → កៅសិបប្រាំបួន ចុច កៅសិបប្រាំបួន).
   - Repetition mark `ៗ` must be expanded (e.g. លឿនៗ → លឿន លឿន).
   - `។ល។` / `៘` must be expanded to ជាដើម or និងផ្សេងៗទៀត.
   - All foreign/English terms must be transliterated into Khmer phonetic script (e.g. VIP → វីអាយភី, Facebook → ហ្វេសប៊ុក).

2. **Audio Generation (Edge-TTS & VoxCPM2)**:
   - Micro-stagger outgoing WebSocket connections by 80-120ms to prevent Microsoft rate-limiting.
   - Fast-fail empty lines or non-recoverable errors to avoid retry storms.
   - Cache reference audio Base64 in memory for VoxCPM2 batch synthesis.
   - Refer to `docs/KHMER_TTS_NORMALIZATION.md` for the full reference prompt and optimization details.
