// Keeps a copy of everything the backend prints (console.log/warn/error) in
// <storage>/logs/server.log, so a problem can be looked at after the app is closed -
// e.g. which Gemini model transcribed a chunk, or why a join failed. The file is
// rotated when it passes MAX_BYTES (server.log -> server.1.log -> server.2.log).
const fs = require('fs');
const path = require('path');
const util = require('util');

const MAX_BYTES = 5 * 1024 * 1024;
const KEEP = 2;

function rotate(file) {
    for (let i = KEEP; i >= 1; i--) {
        const from = i === 1 ? file : `${file.replace(/\.log$/, '')}.${i - 1}.log`;
        const to = `${file.replace(/\.log$/, '')}.${i}.log`;
        try { if (fs.existsSync(from)) fs.renameSync(from, to); } catch (e) { }
    }
}

function installServerLog(logsDir, { fileName = 'server.log', maxBytes = MAX_BYTES } = {}) {
    const file = path.join(logsDir, fileName);
    try {
        fs.mkdirSync(logsDir, { recursive: true });
        if (fs.existsSync(file) && fs.statSync(file).size > maxBytes) rotate(file);
    } catch (e) {
        return null; // logging to a file is a convenience; never stop the server over it
    }
    let size = 0;
    try { size = fs.existsSync(file) ? fs.statSync(file).size : 0; } catch (e) { }
    // Plain synchronous appends: a line is on disk before the next one (nothing lost if the
    // app crashes right after), and rotating can never race a stream that hasn't opened yet.
    let fd = null;
    try { fd = fs.openSync(file, 'a'); } catch (e) { return null; }

    const write = (level, args) => {
        const line = `${new Date().toISOString()} ${level} ${util.format(...args)}\n`;
        fs.writeSync(fd, line);
        size += Buffer.byteLength(line);
        if (size > maxBytes) {
            fs.closeSync(fd);
            rotate(file);
            size = 0;
            fd = fs.openSync(file, 'a');
        }
    };
    for (const [method, level] of [['log', 'INFO '], ['info', 'INFO '], ['warn', 'WARN '], ['error', 'ERROR']]) {
        const original = console[method].bind(console);
        console[method] = (...args) => {
            original(...args);
            try { write(level, args); } catch (e) { }
        };
    }
    console.log(`[Log] Server log: ${file}`);
    return file;
}

module.exports = { installServerLog };
