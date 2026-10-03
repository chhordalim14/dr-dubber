// Tracks every child process server.js spawns (ffmpeg, python, etc.) so they
// can all be force-killed together on shutdown instead of leaking orphaned
// processes. Extracted verbatim out of server.js.
const { exec } = require('child_process');

const spawnedProcesses = new Set();

function trackProcess(proc) {
    if (!proc || !proc.pid) return;
    spawnedProcesses.add(proc);
    proc.on('close', () => spawnedProcesses.delete(proc));
    proc.on('error', () => spawnedProcesses.delete(proc));
}

function killAllProcesses() {
    for (const proc of spawnedProcesses) {
        try {
            if (process.platform === 'win32') {
                exec(`taskkill /pid ${proc.pid} /T /F`, () => {});
            } else {
                proc.kill('SIGKILL');
            }
        } catch (e) {}
    }
    spawnedProcesses.clear();
}

process.on('exit', killAllProcesses);
process.on('SIGINT', () => { killAllProcesses(); process.exit(0); });
process.on('SIGTERM', () => { killAllProcesses(); process.exit(0); });

module.exports = { spawnedProcesses, trackProcess, killAllProcesses };
