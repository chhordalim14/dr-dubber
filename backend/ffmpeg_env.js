const path = require('path');
const fs = require('fs');

let _resolvedFFmpegBin = null;
let _resolvedFFprobeBin = null;

function isValidExecutable(filePath) {
    if (!filePath || typeof filePath !== 'string') return false;
    // CRITICAL: A binary can NEVER be executed directly from inside an asar archive!
    if (filePath.includes('app.asar') && !filePath.includes('app.asar.unpacked')) {
        return false;
    }
    try {
        return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
    } catch (e) {
        return false;
    }
}

function ensureFFmpegInPath() {
    const extraPaths = [];

    // 1. Packaged Electron app: unpacked backend/bin in resources
    if (process.resourcesPath) {
        extraPaths.push(path.join(process.resourcesPath, 'app.asar.unpacked', 'backend', 'bin'));
        extraPaths.push(path.join(process.resourcesPath, 'bin'));
    }

    // 2. Unpacked backend/bin derived from __dirname (safe if running inside app.asar)
    if (__dirname.includes('app.asar')) {
        extraPaths.push(path.join(__dirname.replace('app.asar', 'app.asar.unpacked'), 'bin'));
    } else {
        // Dev environment (not packaged in asar)
        extraPaths.push(path.join(__dirname, 'bin'));
    }

    // 3. User local AppData (installed DR Dubber Pro unpacked bin, WinGet, Programs, etc.)
    const localAppData = process.env.LOCALAPPDATA || (process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'AppData', 'Local') : '');
    if (localAppData) {
        extraPaths.push(path.join(localAppData, 'Programs', 'DR Dubber Pro', 'resources', 'app.asar.unpacked', 'backend', 'bin'));
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

    // Filter out invalid paths AND any path containing app.asar without .unpacked
    const validPaths = extraPaths.filter(p => {
        if (!p || (p.includes('app.asar') && !p.includes('app.asar.unpacked'))) return false;
        try {
            return fs.existsSync(p) && fs.statSync(p).isDirectory();
        } catch (e) {
            return false;
        }
    });

    const currentPath = process.env.PATH || process.env.Path || '';
    const currentList = currentPath.split(path.delimiter).filter(p => {
        // Purge any accidentally injected app.asar paths from existing PATH
        return p && !(p.includes('app.asar') && !p.includes('app.asar.unpacked'));
    });
    const existingSet = new Set(currentList.map(p => {
        try { return path.resolve(p).toLowerCase(); } catch (e) { return p.toLowerCase(); }
    }));

    const toAdd = validPaths.filter(p => {
        try { return !existingSet.has(path.resolve(p).toLowerCase()); } catch (e) { return false; }
    });

    if (toAdd.length > 0 || currentList.length !== currentPath.split(path.delimiter).filter(Boolean).length) {
        const combined = [...toAdd, ...currentList].join(path.delimiter);
        process.env.PATH = combined;
        process.env.Path = combined;
    }
}

// Automatically run on load
ensureFFmpegInPath();

function getFFmpegBinary() {
    if (_resolvedFFmpegBin && isValidExecutable(_resolvedFFmpegBin)) {
        return _resolvedFFmpegBin;
    }
    ensureFFmpegInPath();

    const candidateExts = process.platform === 'win32' ? ['.exe', ''] : [''];

    // 1. First priority: Check known bundled locations directly
    const directDirs = [];
    if (process.resourcesPath) {
        directDirs.push(path.join(process.resourcesPath, 'app.asar.unpacked', 'backend', 'bin'));
        directDirs.push(path.join(process.resourcesPath, 'bin'));
    }
    if (__dirname.includes('app.asar')) {
        directDirs.push(path.join(__dirname.replace('app.asar', 'app.asar.unpacked'), 'bin'));
    } else {
        directDirs.push(path.join(__dirname, 'bin'));
    }
    const localAppData = process.env.LOCALAPPDATA || (process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'AppData', 'Local') : '');
    if (localAppData) {
        directDirs.push(path.join(localAppData, 'Programs', 'DR Dubber Pro', 'resources', 'app.asar.unpacked', 'backend', 'bin'));
    }

    for (const dir of directDirs) {
        for (const ext of candidateExts) {
            const fullPath = path.join(dir, `ffmpeg${ext}`);
            if (isValidExecutable(fullPath)) {
                _resolvedFFmpegBin = fullPath;
                return _resolvedFFmpegBin;
            }
        }
    }

    // 2. Second priority: Search in PATH
    const pathDirs = (process.env.PATH || process.env.Path || '').split(path.delimiter);
    for (const dir of pathDirs) {
        if (!dir || (dir.includes('app.asar') && !dir.includes('app.asar.unpacked'))) continue;
        for (const ext of candidateExts) {
            const fullPath = path.join(dir, `ffmpeg${ext}`);
            if (isValidExecutable(fullPath)) {
                _resolvedFFmpegBin = fullPath;
                return _resolvedFFmpegBin;
            }
        }
    }

    _resolvedFFmpegBin = 'ffmpeg';
    return _resolvedFFmpegBin;
}

function getFFprobeBinary() {
    if (_resolvedFFprobeBin && isValidExecutable(_resolvedFFprobeBin)) {
        return _resolvedFFprobeBin;
    }
    ensureFFmpegInPath();

    const candidateExts = process.platform === 'win32' ? ['.exe', ''] : [''];

    // 1. First priority: Check known bundled locations directly
    const directDirs = [];
    if (process.resourcesPath) {
        directDirs.push(path.join(process.resourcesPath, 'app.asar.unpacked', 'backend', 'bin'));
        directDirs.push(path.join(process.resourcesPath, 'bin'));
    }
    if (__dirname.includes('app.asar')) {
        directDirs.push(path.join(__dirname.replace('app.asar', 'app.asar.unpacked'), 'bin'));
    } else {
        directDirs.push(path.join(__dirname, 'bin'));
    }
    const localAppData = process.env.LOCALAPPDATA || (process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'AppData', 'Local') : '');
    if (localAppData) {
        directDirs.push(path.join(localAppData, 'Programs', 'DR Dubber Pro', 'resources', 'app.asar.unpacked', 'backend', 'bin'));
    }

    for (const dir of directDirs) {
        for (const ext of candidateExts) {
            const fullPath = path.join(dir, `ffprobe${ext}`);
            if (isValidExecutable(fullPath)) {
                _resolvedFFprobeBin = fullPath;
                return _resolvedFFprobeBin;
            }
        }
    }

    // 2. Second priority: Search in PATH
    const pathDirs = (process.env.PATH || process.env.Path || '').split(path.delimiter);
    for (const dir of pathDirs) {
        if (!dir || (dir.includes('app.asar') && !dir.includes('app.asar.unpacked'))) continue;
        for (const ext of candidateExts) {
            const fullPath = path.join(dir, `ffprobe${ext}`);
            if (isValidExecutable(fullPath)) {
                _resolvedFFprobeBin = fullPath;
                return _resolvedFFprobeBin;
            }
        }
    }

    _resolvedFFprobeBin = 'ffprobe';
    return _resolvedFFprobeBin;
}

module.exports = {
    isValidExecutable,
    ensureFFmpegInPath,
    getFFmpegBinary,
    getFFprobeBinary
};

