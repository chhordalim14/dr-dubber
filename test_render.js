const path = require('path');
const { renderVideo } = require('./backend/render_service');

const videoPath = 'C:\\Software\\DAI-Dubber-PRO\\episode.mp4';
const outputPath = path.join(__dirname, 'storage', 'exports', 'test_dubbed_output.mp4');

const subtitles = [
    {
        id: 'sub_1',
        startTime: '00:00:01.000',
        endTime: '00:00:06.000',
        startSec: 1.0,
        endSec: 6.0,
        dubbedText: 'ជំរាបសួរ! នេះគឺជាការសាកល្បងបញ្ចូលសំឡេងជាភាសាខ្មែរ។',
        audioPath: path.join(__dirname, 'storage', 'audio_cache', 'test_khmer_piseth.mp3')
    },
    {
        id: 'sub_2',
        startTime: '00:00:07.000',
        endTime: '00:00:10.500',
        startSec: 7.0,
        endSec: 10.5,
        dubbedText: 'ស្វាគមន៍មកកាន់ការបង្កើតវីដេអូ Khmer Dubbing!',
        audioPath: path.join(__dirname, 'storage', 'audio_cache', 'test_khmer_sreymom.mp3')
    }
];

console.log('Starting test render...');

renderVideo({
    videoPath,
    subtitles,
    bgmPath: null,
    bgmVolume: 0.4,
    voiceVolume: 1.0,
    duckingEnabled: false,
    muteOriginal: true,
    burnSubtitles: true,
    subtitleFont: 'KantumruyPro-Bold',
    subtitleFontSize: 28,
    resolution: '720p',
    encoder: 'libx264',
    outputPath
},
(prog, eta) => console.log(`Progress: ${prog}% (ETA: ${eta})`),
(outFile) => {
    console.log(`✓ Test Render SUCCESS: ${outFile}`);
    process.exit(0);
},
(err) => {
    console.error(`✗ Test Render ERROR:`, err);
    process.exit(1);
});
