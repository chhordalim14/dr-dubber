const path = require('path');
const fs = require('fs');

const SEPARATED_DIR = path.join(__dirname, 'storage', 'separated');
const videoPath = 'C:\\Software\\DAI-Dubber-PRO\\episode.mp4';
const baseName = path.basename(videoPath, path.extname(videoPath));
const audioOut = path.join(SEPARATED_DIR, `${baseName}_audio.wav`);

console.log('Testing extraction output path:', audioOut);
console.log('Relative URL expected by frontend:', `/storage/separated/${baseName}_audio.wav`);
