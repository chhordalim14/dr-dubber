// Video rendering pipeline (color adjustments, flips, audio tracks,
// subtitles, BGM ducking). Thin HTTP wrapper around
// render_service.js's renderVideo/cancelRender/getRenderProgress.
// Extracted verbatim out of server.js. Mounted at /api.
const express = require('express');
const fs = require('fs');
const path = require('path');
const { resolveLocalFilePath, EXPORTS_DIR } = require('../lib/paths');
const { isNetworkPath, safeOutputFileName } = require('../lib/security');

// Exports at once. Measured 2026-11-08 (7.6-min tab, NVENC): 1 alone 119 s, 2 side by side 90 s
// each, 3 87 s each - two is where the gain is.
const MAX_RENDERS = 2;
// A new export waits while a subtitle search runs (render_service.js: they slow each other down
// many times over), but never longer than this - a search that hangs must not stop the exports.
const SEARCH_HOLD_MAX_MS = 20 * 60 * 1000;

module.exports = function createRenderRouter({
    upload, renderVideo, cancelRender, getRenderProgress, audioRepair,
    renderingCount = () => (getRenderProgress().status === 'rendering' ? 1 : 0),
    renderingOutputs = () => [],
    searchBusy = () => false,
    now = () => Date.now(),
}) {
    const router = express.Router();
    // Renders the server took but hasn't started yet (it checks the video's own audio first),
    // by token. They count as going: a page whose request was lost on the way (see
    // /render-progress) must wait for its own, not send it again - two renders of one file.
    const pendingRenders = new Map();
    // When each held export first asked (by its token, else its output file).
    const heldSince = new Map();

    router.post('/render', upload.any(), async (req, res) => {
        // Disable HTTP timeout for long render operations
        req.setTimeout(0);
        res.setTimeout(0);

        let renderOpts = { ...req.body };
        if (req.body.data) {
            try {
                const parsed = JSON.parse(req.body.data);
                renderOpts = { ...renderOpts, ...parsed };
            } catch (e) { }
        }

        // 1. Resolve uploaded video file or explicit path
        const uploadedVideo = (req.files || []).find(f => f.fieldname === 'videoFile' || f.fieldname === 'video');
        let videoPath = resolveLocalFilePath(renderOpts.videoPath || renderOpts.filePath || renderOpts.videoFilePath || renderOpts.sourceFilePath || (uploadedVideo ? uploadedVideo.path : null));

        const isAudioOnly = renderOpts.audioOnly === true || renderOpts.audioOnly === 'true';

        // If video export, require a valid source video
        if (!isAudioOnly) {
            if (!videoPath || !fs.existsSync(videoPath)) {
                return res.status(400).json({ success: false, error: 'Source video not found' });
            }
        }

        // Up to MAX_RENDERS at once; the page waits and sends again when all are busy.
        const renderToken = renderOpts.renderToken ? String(renderOpts.renderToken).slice(0, 64) : null;
        // A subtitle search is running: the export waits its turn (the page asks again shortly).
        const holdKey = renderToken || String(renderOpts.outputFileName || renderOpts.outputPath || '');
        if (searchBusy()) {
            const since = heldSince.get(holdKey) || now();
            heldSince.set(holdKey, since);
            if (now() - since < SEARCH_HOLD_MAX_MS) {
                return res.status(409).json({ success: false, held: 'search', error: 'Waiting for the subtitle search to finish.' });
            }
        }
        heldSince.delete(holdKey);
        for (const [k, t] of heldSince) if (now() - t > 2 * SEARCH_HOLD_MAX_MS) heldSince.delete(k);
        if (renderingCount() + pendingRenders.size >= MAX_RENDERS
            || (renderToken && (pendingRenders.has(renderToken) || getRenderProgress(renderToken).status === 'rendering'))) {
            return res.status(409).json({ success: false, error: 'A render is already in progress. Wait for it to finish or cancel it first.' });
        }

        // 2. Resolve BGM file or explicit path
        const uploadedBgm = (req.files || []).find(f => f.fieldname === 'bgmFile' || f.fieldname === 'bgm');
        let bgmPath = resolveLocalFilePath(renderOpts.bgmPath || renderOpts.bgmTrack?.serverPath || (uploadedBgm ? uploadedBgm.path : null));
        const bgmVolume = renderOpts.bgmVolume !== undefined ? parseFloat(renderOpts.bgmVolume) : (renderOpts.bgmTrack?.volume !== undefined ? parseFloat(renderOpts.bgmTrack.volume) : 0.5);
        const bgmStart = renderOpts.bgmStart !== undefined ? parseFloat(renderOpts.bgmStart) : (renderOpts.bgmTrack?.start !== undefined ? parseFloat(renderOpts.bgmTrack.start) : 0) || 0;
        const bgmFadeIn = renderOpts.bgmFadeIn !== undefined ? parseFloat(renderOpts.bgmFadeIn) : (renderOpts.bgmTrack?.fadeIn !== undefined ? parseFloat(renderOpts.bgmTrack.fadeIn) : 0) || 0;
        const bgmFadeOut = renderOpts.bgmFadeOut !== undefined ? parseFloat(renderOpts.bgmFadeOut) : (renderOpts.bgmTrack?.fadeOut !== undefined ? parseFloat(renderOpts.bgmTrack.fadeOut) : 0) || 0;

        // 3. Resolve imported audio files and audioTracks / subtitles
        const importedAudioFiles = (req.files || []).filter(f => f.fieldname === 'importedAudioFiles');
        const rawAudioTracks = renderOpts.audioTracks || renderOpts.subtitles || [];
        const resolvedAudioTracks = rawAudioTracks.map(track => {
            let filePath = track.file || track.audioPath || track.url;
            if (typeof filePath === 'string') {
                const importMatch = filePath.match(/^__imported__:(\d+)$/);
                if (importMatch) {
                    const idx = parseInt(importMatch[1], 10);
                    if (importedAudioFiles[idx]) {
                        filePath = importedAudioFiles[idx].path;
                    }
                } else {
                    filePath = resolveLocalFilePath(filePath);
                }
            }
            return {
                ...track,
                file: filePath,
                audioPath: filePath,
                start: track.start !== undefined ? parseFloat(track.start) : (track.audioStart !== undefined ? parseFloat(track.audioStart) : (track.textStart !== undefined ? parseFloat(track.textStart) : (track.startTime !== undefined ? parseFloat(track.startTime) : 0))),
                duration: track.duration ? parseFloat(track.duration) : undefined,
                volume: track.volume !== undefined ? parseFloat(track.volume) : 1.0,
                speed: track.speed !== undefined ? parseFloat(track.speed) : 1.0,
                pitch: track.pitch !== undefined ? parseFloat(track.pitch) : 0,
                sourceOffset: track.sourceOffset ? parseFloat(track.sourceOffset) : 0
            };
        });

        // 4. Resolve output folder and file name
        renderOpts.audioFormat = renderOpts.audioFormat === 'wav' ? 'wav' : 'mp3';
        const ext = isAudioOnly ? renderOpts.audioFormat : 'mp4';
        const baseName = videoPath ? path.basename(videoPath, path.extname(videoPath)) : `audio_${Date.now()}`;
        const defaultOutputName = isAudioOnly ? `${baseName}_Dubbed.${ext}` : `${baseName}_DR_Dubbed.mp4`;
        // The page sends a bare file name: keep it one name with the right extension
        // so it can't point outside the export folder or at a non-media file.
        const finalName = safeOutputFileName(renderOpts.outputFileName || defaultOutputName, [`.${ext}`], defaultOutputName);
        const targetFolder = (renderOpts.exportPath && !isNetworkPath(renderOpts.exportPath)) ? renderOpts.exportPath : EXPORTS_DIR;

        try {
            if (!fs.existsSync(targetFolder)) {
                fs.mkdirSync(targetFolder, { recursive: true });
            }
        } catch (e) {
            console.error('[Render] Could not create export folder:', targetFolder, e);
        }
        const outputPath = (renderOpts.outputPath && !isNetworkPath(renderOpts.outputPath) && path.extname(renderOpts.outputPath).toLowerCase() === `.${ext}`)
            ? renderOpts.outputPath
            : path.join(targetFolder, finalName);

        const shouldShowSubs = renderOpts.showSubtitles !== undefined
            ? (renderOpts.showSubtitles === true || renderOpts.showSubtitles === 'true')
            : (renderOpts.burnSubtitles === true || renderOpts.burnSubtitles === 'true');

        // Only when the video's own audio is actually mixed in (same rule as render_service):
        // checking/repairing a 2-hour track for a muted or audio-only export is wasted time.
        // The same file already being written by the other export: both would break it.
        const sameFile = (p) => path.resolve(p).toLowerCase() === path.resolve(outputPath).toLowerCase();
        if (renderingOutputs().some(sameFile) || [...pendingRenders.values()].some((p) => sameFile(p.outputPath))) {
            return res.status(409).json({ success: false, error: 'This file is already being exported. Wait for it to finish or cancel it first.' });
        }
        const pendingKey = renderToken || `p_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        pendingRenders.set(pendingKey, { token: renderToken, outputPath });
        let originalAudioPath = null;
        try {
            originalAudioPath = (videoPath && !isAudioOnly && !(renderOpts.isOriginalAudioMuted !== undefined ? renderOpts.isOriginalAudioMuted : (renderOpts.muteOriginal !== undefined ? renderOpts.muteOriginal : true)))
                ? (await audioRepair.getAudioSource(videoPath).catch(() => ({ path: videoPath }))).path : null;
        } finally {
            pendingRenders.delete(pendingKey); // renderVideo takes over in this same tick (it marks its job first)
        }

        // 5. Run render and wait for completion
        renderVideo({
            ...renderOpts,
            videoPath,
            audioOnly: isAudioOnly,
            audioFormat: renderOpts.audioFormat || 'mp3',
            audioTracks: resolvedAudioTracks,
            subtitles: Array.isArray(renderOpts.subtitles) ? renderOpts.subtitles : (Array.isArray(renderOpts.audioTracks) ? renderOpts.audioTracks : resolvedAudioTracks),
            srtContent: renderOpts.srtContent,
            showSubtitles: shouldShowSubs,
            burnSubtitles: shouldShowSubs,
            bgmPath,
            bgmVolume,
            bgmStart,
            bgmFadeIn,
            bgmFadeOut,
            duration: renderOpts.duration || renderOpts.videoDuration,
            videoDuration: renderOpts.videoDuration || renderOpts.duration,
            blurBoxes: Array.isArray(renderOpts.blurBoxes) ? renderOpts.blurBoxes : [],
            freeTexts: Array.isArray(renderOpts.freeTexts) ? renderOpts.freeTexts : [],
            videoPan: renderOpts.videoPan,
            videoZoom: renderOpts.videoZoom,
            videoScaleX: renderOpts.videoScaleX,
            videoScaleY: renderOpts.videoScaleY,
            encoder: renderOpts.encoder || (renderOpts.renderEngine === 'cpu' ? 'libx264' : 'auto'),
            duckingEnabled: renderOpts.duckingEnabled !== undefined
                ? (renderOpts.duckingEnabled === true || renderOpts.duckingEnabled === 'true' || renderOpts.duckingEnabled === 1 || renderOpts.duckingEnabled === '1')
                : true,
            duckingDepth: renderOpts.duckingDepth || 'standard',
            dialogueMastering: renderOpts.dialogueMastering === undefined ? true : !(renderOpts.dialogueMastering === false || renderOpts.dialogueMastering === 'false' || renderOpts.dialogueMastering === 0 || renderOpts.dialogueMastering === '0'),
            normalizeLoudness: renderOpts.normalizeLoudness === undefined ? true : !(renderOpts.normalizeLoudness === false || renderOpts.normalizeLoudness === 'false' || renderOpts.normalizeLoudness === 0 || renderOpts.normalizeLoudness === '0'),
            originalAudioPath,
            outputPath
        },
        (progress, eta) => { },
        (outputFile) => {
            if (!res.headersSent) {
                res.json({ success: true, message: 'Render completed successfully', outputPath: outputFile });
            }
        },
        (err) => {
            if (!res.headersSent) {
                res.status(500).json({ success: false, error: err.message || 'Render failed' });
            }
        });
    });

    router.get('/render-progress', (req, res) => {
        // ?token=: that render (two can run at once); none: the one started last, as before.
        const token = req.query && req.query.token ? String(req.query.token).slice(0, 64) : null;
        const pending = token ? (pendingRenders.get(token) || null) : [...pendingRenders.values()].pop();
        const progress = pending ? { status: 'rendering', progress: 0, eta: 'Calculating...', token: pending.token } : getRenderProgress(token);
        res.json({
            status: progress.status === 'rendering' ? 'processing' : progress.status,
            percent: progress.progress,
            eta: progress.eta,
            error: progress.error,
            outputFile: progress.outputFile,
            token: progress.token || null
        });
    });

    router.post('/cancel-render', (req, res) => {
        const token = (req.body && req.body.token) || (req.query && req.query.token) || null;
        const ok = cancelRender(token ? String(token) : undefined);
        res.json({ success: ok });
    });

    return router;
};
