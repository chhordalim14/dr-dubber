const fs = require('fs');
const path = require('path');

const indexHtml = fs.readFileSync(path.join(__dirname, 'frontend', 'index.html'), 'utf8');

const apis = [
  '/api/check-whisper-folder',
  '/api/cancel-transcribe',
  '/api/extract-audio',
  '/api/translate-srt',
  '/api/log-transcription',
  '/api/transcribe',
  '/api/open-logs-folder',
  '/api/audio',
  '/api/system-fonts',
  '/api/select-folder',
  '/api/log-error',
  '/api/check-video-preview',
  '/api/clear-logs',
  '/api/generate-voxcmp2',
  '/api/generate-audio',
  '/api/log-audio-gen',
  '/api/cancel-remove-vocals',
  '/api/remove-vocals',
  '/api/bgm-job-status',
  '/api/open-folder',
  '/api/cancel-render',
  '/api/render-progress',
  '/api/render',
  '/api/suggest-movie-title',
  '/api/system-memory'
];

apis.forEach(api => {
    const idx = indexHtml.indexOf(api);
    if (idx !== -1) {
        const snippet = indexHtml.substring(Math.max(0, idx - 100), Math.min(indexHtml.length, idx + 300));
        console.log(`\n=== API: ${api} ===`);
        console.log(snippet.replace(/\n\s*\n/g, '\n'));
    }
});
