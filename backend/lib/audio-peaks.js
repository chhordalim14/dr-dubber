// Waveform peaks for the timeline's "Original Audio" track. FFmpeg decodes the
// video's sound to 8 kHz mono 16-bit PCM and we keep only the loudest sample of
// each slice, so a 45-minute episode becomes ~54k small numbers instead of the
// gigabyte Web Audio would need to decode it in the page.
const { spawn } = require('child_process');

const SAMPLE_RATE = 8000;
const PEAKS_PER_SECOND = 20;

// Streams PCM chunks in (any byte boundaries) and gives back one 0-255 peak per
// samplesPerPeak samples.
function createPeakAccumulator(samplesPerPeak) {
    const peaks = [];
    let carry = null; // odd trailing byte of the previous chunk
    let max = 0;
    let count = 0;
    return {
        push(chunk) {
            let buf = chunk;
            if (carry) {
                buf = Buffer.concat([carry, chunk]);
                carry = null;
            }
            const usable = buf.length - (buf.length % 2);
            for (let i = 0; i < usable; i += 2) {
                const v = Math.abs(buf.readInt16LE(i));
                if (v > max) max = v;
                if (++count === samplesPerPeak) {
                    peaks.push(Math.min(255, Math.round((max / 32768) * 255)));
                    max = 0;
                    count = 0;
                }
            }
            if (usable < buf.length) carry = buf.subarray(usable);
        },
        finish() {
            if (count > 0) peaks.push(Math.min(255, Math.round((max / 32768) * 255)));
            count = 0;
            max = 0;
            return peaks;
        },
    };
}

function computeAudioPeaks({ ffmpegBin, filePath, peaksPerSecond = PEAKS_PER_SECOND, signal } = {}) {
    return new Promise((resolve, reject) => {
        const samplesPerPeak = Math.max(1, Math.round(SAMPLE_RATE / peaksPerSecond));
        const acc = createPeakAccumulator(samplesPerPeak);
        const args = ['-v', 'error', '-nostdin', '-i', filePath, '-vn', '-sn', '-dn', '-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 's16le', 'pipe:1'];
        const proc = spawn(ffmpegBin, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        let stderr = '';
        const onAbort = () => proc.kill();
        if (signal) signal.addEventListener('abort', onAbort, { once: true });
        proc.stdout.on('data', (chunk) => acc.push(chunk));
        proc.stderr.on('data', (d) => {
            if (stderr.length < 4000) stderr += d.toString();
        });
        proc.on('error', reject);
        proc.on('close', (code) => {
            if (signal) signal.removeEventListener('abort', onAbort);
            const peaks = acc.finish();
            // A file with no audio stream exits non-zero with nothing decoded.
            if (code !== 0 && peaks.length === 0) {
                return reject(new Error(stderr.trim().split('\n').pop() || `ffmpeg exited with ${code}`));
            }
            resolve({ peaksPerSecond: SAMPLE_RATE / samplesPerPeak, peaks });
        });
    });
}

module.exports = { createPeakAccumulator, computeAudioPeaks, SAMPLE_RATE, PEAKS_PER_SECOND };
