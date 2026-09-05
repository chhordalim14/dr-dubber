const path = require('path');
const fs = require('fs');

let _resolvedFFmpegBin = null;

function ensureFFmpegInPath() {
    const extraPaths = [];

    // Bundled FFmpeg inside app (dev & packaged electron app)
    const bundledBin = path.join(__dirname, 'bin');
    extraPaths.push(bundledBin);
    if (process.resourcesPath) {
        extraPaths.push(path.join(process.resourcesPath, 'app.asar.unpacked', 'backend', 'bin'));
        extraPaths.push(path.join(process.resourcesPath, 'bin'));
    }

    const localAppData = process.env.LOCALAPPDATA || (process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'AppData', 'Local') : '');
    if (localAppData) {
        extraPaths.push(path.join(localAppData, 'Microsoft', 'WinGet', 'Links'));
        extraPaths.push(path.join(localAppData, 'Programs'));
        const wingetPkgs = path.join(localAppData, 'Microsoft', 'WinGet', 'Packages');
        if (fs.existsSync(wingetPkgs)) {
            try {
                const dirs = fs.readdirSync(wingetPkgs);
                for (const d of dirs) {
                    if (d.toLowerCase().includes('ffmpeg')) {
                        const base = path.join(wingetPkgs, d);
                        extraPaths.push(base);
                        try {
                            const subs = fs.readdirSync(base);
                            for (const s of subs) {
                                const subPath = path.join(base, s);
                                if (fs.statSync(subPath).isDirectory()) {
                                    extraPaths.push(path.join(subPath, 'bin'));
                                    extraPaths.push(subPath);
                                }
                            }
                        } catch (e) {}
                    }
                }
            } catch (e) {}
        }
    }

    const pf = process.env.ProgramFiles || 'C:\\Program Files';
    const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    extraPaths.push(
        'C:\\ffmpeg\\bin',
        'C:\\ffmpeg',
        path.join(pf, 'ffmpeg', 'bin'),
        path.join(pf, 'ffmpeg'),
        path.join(pf86, 'ffmpeg', 'bin'),
        'C:\\tools\\ffmpeg\\bin',
        'C:\\ProgramData\\chocolatey\\bin'
    );

    if (process.env.USERPROFILE) {
        extraPaths.push(path.join(process.env.USERPROFILE, 'scoop', 'shims'));
    }

    const validPaths = extraPaths.filter(p => {
        try {
            return fs.existsSync(p);
        } catch (e) {
            return false;
        }
    });

    const currentPath = process.env.PATH || process.env.Path || '';
    const currentList = currentPath.split(path.delimiter).filter(Boolean);
    const existingSet = new Set(currentList.map(p => {
        try { return path.resolve(p).toLowerCase(); } catch (e) { return p.toLowerCase(); }
    }));

    const toAdd = validPaths.filter(p => {
        try { return !existingSet.has(path.resolve(p).toLowerCase()); } catch (e) { return false; }
    });

    if (toAdd.length > 0) {
        const combined = [...toAdd, ...currentList].join(path.delimiter);
        process.env.PATH = combined;
        process.env.Path = combined;
    }
}

// Automatically run on load
ensureFFmpegInPath();

function getFFmpegBinary() {
    if (_resolvedFFmpegBin) return _resolvedFFmpegBin;
    ensureFFmpegInPath();

    const candidateExts = process.platform === 'win32' ? ['.exe', ''] : [''];
    const pathDirs = (process.env.PATH || process.env.Path || '').split(path.delimiter);

    for (const dir of pathDirs) {
        for (const ext of candidateExts) {
            const fullPath = path.join(dir, `ffmpeg${ext}`);
            try {
                if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
                    _resolvedFFmpegBin = fullPath;
                    return _resolvedFFmpegBin;
                }
            } catch (e) {}
        }
    }
    _resolvedFFmpegBin = 'ffmpeg';
    return _resolvedFFmpegBin;
}

let _resolvedFFprobeBin = null;
function getFFprobeBinary() {
    if (_resolvedFFprobeBin) return _resolvedFFprobeBin;
    ensureFFmpegInPath();

    const candidateExts = process.platform === 'win32' ? ['.exe', ''] : [''];
    const pathDirs = (process.env.PATH || process.env.Path || '').split(path.delimiter);

    for (const dir of pathDirs) {
        for (const ext of candidateExts) {
            const fullPath = path.join(dir, `ffprobe${ext}`);
            try {
                if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
                    _resolvedFFprobeBin = fullPath;
                    return _resolvedFFprobeBin;
                }
            } catch (e) {}
        }
    }
    _resolvedFFprobeBin = 'ffprobe';
    return _resolvedFFprobeBin;
}

module.exports = {
    ensureFFmpegInPath,
    getFFmpegBinary,
    getFFprobeBinary
};

