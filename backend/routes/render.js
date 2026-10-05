// Video rendering pipeline (color adjustments, flips, audio tracks,
// overlays, subtitles, BGM ducking). Thin HTTP wrapper around
// render_service.js's renderVideo/cancelRender/getRenderProgress.
// Extracted verbatim out of server.js. Mounted at /api.
const express = require('express');
const fs = require('fs');
const path = require('path');
const { resolveLocalFilePath, EXPORTS_DIR } = require('../lib/paths');
const { isNetworkPath, safeOutputFileName } = require('../lib/security');

module.exports = function createRenderRouter({ upload, renderVideo, cancelRender, getRenderProgress, audioRepair }) {
    const router = express.Router();

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

        // Guard against simultaneous renders
        if (getRenderProgress().status === 'rendering') {
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

        // 3.5 Resolve overlay images from multipart uploads and local paths
        const uploadedOverlayFiles = (req.files || []).filter(f => f.fieldname === 'overlayImages');
        const overlayFileByIndex = new Map();
        uploadedOverlayFiles.forEach((f, idx) => {
            const match = (f.originalname || '').match(/overlay_(\d+)/);
            if (match) {
                overlayFileByIndex.set(parseInt(match[1], 10), f.path);
            } else {
                overlayFileByIndex.set(idx, f.path);
            }
        });

        const rawOverlayImages = Array.isArray(renderOpts.overlayImages) ? renderOpts.overlayImages : [];
        const resolvedOverlayImages = rawOverlayImages.map((img, idx) => {
            let imagePath = null;
            if (img.filePath && fs.existsSync(img.filePath)) {
                imagePath = img.filePath;
            } else if (img.path && fs.existsSync(img.path)) {
                imagePath = img.path;
            } else if (overlayFileByIndex.has(idx)) {
                imagePath = overlayFileByIndex.get(idx);
            } else if (uploadedOverlayFiles[idx]) {
                imagePath = uploadedOverlayFiles[idx].path;
            }

            return {
                ...img,
                path: imagePath,
                x: img.x !== undefined ? parseFloat(img.x) : 0,
                y: img.y !== undefined ? parseFloat(img.y) : 0,
                w: img.w !== undefined ? parseFloat(img.w) : 30,
                h: img.h !== undefined ? parseFloat(img.h) : 30,
                opacity: img.opacity !== undefined ? (parseFloat(img.opacity) > 1 ? parseFloat(img.opacity) / 100 : parseFloat(img.opacity)) : 1.0,
                radius: img.radius !== undefined ? parseFloat(img.radius) : 0,
                motion: img.motion || 'none',
                speed: img.speed !== undefined ? parseFloat(img.speed) : 1.0
            };
        }).filter(img => img.path && fs.existsSync(img.path));

        // 3.6 Resolve overlay videos from multipart uploads and local paths
        const uploadedVideoOverlayFiles = (req.files || []).filter(f => f.fieldname === 'overlayVideos');
        const videoOverlayFileByIndex = new Map();
        uploadedVideoOverlayFiles.forEach((f, idx) => {
            const match = (f.originalname || '').match(/overvid_(\d+)/);
            if (match) {
                videoOverlayFileByIndex.set(parseInt(match[1], 10), f.path);
            } else {
                videoOverlayFileByIndex.set(idx, f.path);
            }
        });

        const rawVideoOverlays = Array.isArray(renderOpts.videoOverlays) ? renderOpts.videoOverlays : [];
        const resolvedVideoOverlays = rawVideoOverlays.map((vid, idx) => {
            let videoOverlayPath = null;
            if (vid.filePath && fs.existsSync(vid.filePath)) {
                videoOverlayPath = vid.filePath;
            } else if (vid.path && fs.existsSync(vid.path)) {
                videoOverlayPath = vid.path;
            } else if (vid.videoPath && fs.existsSync(vid.videoPath)) {
                videoOverlayPath = vid.videoPath;
            } else if (videoOverlayFileByIndex.has(idx)) {
                videoOverlayPath = videoOverlayFileByIndex.get(idx);
            } else if (uploadedVideoOverlayFiles[idx]) {
                videoOverlayPath = uploadedVideoOverlayFiles[idx].path;
            }

            return {
                ...vid,
                path: videoOverlayPath,
                x: vid.x !== undefined ? parseFloat(vid.x) : 0,
                y: vid.y !== undefined ? parseFloat(vid.y) : 0,
                w: vid.w !== undefined ? parseFloat(vid.w) : 30,
                h: vid.h !== undefined ? parseFloat(vid.h) : 30,
                opacity: vid.opacity !== undefined ? (parseFloat(vid.opacity) > 1 ? parseFloat(vid.opacity) / 100 : parseFloat(vid.opacity)) : 1.0,
                radius: vid.radius !== undefined ? parseFloat(vid.radius) : 0
            };
        }).filter(vid => vid.path && fs.existsSync(vid.path));

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
            overlayImages: resolvedOverlayImages,
            videoOverlays: resolvedVideoOverlays,
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
            normalizeLoudness: renderOpts.normalizeLoudness === undefined ? true : !(renderOpts.normalizeLoudness === false || renderOpts.normalizeLoudness === 'false' || renderOpts.normalizeLoudness === 0 || renderOpts.normalizeLoudness === '0'),
            // Only when the video's own audio is actually mixed in (same rule as render_service):
            // checking/repairing a 2-hour track for a muted or audio-only export is wasted time.
            originalAudioPath: (videoPath && !isAudioOnly && !(renderOpts.isOriginalAudioMuted !== undefined ? renderOpts.isOriginalAudioMuted : (renderOpts.muteOriginal !== undefined ? renderOpts.muteOriginal : true)))
                ? (await audioRepair.getAudioSource(videoPath).catch(() => ({ path: videoPath }))).path : null,
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
        const progress = getRenderProgress();
        res.json({
            status: progress.status === 'rendering' ? 'processing' : progress.status,
            percent: progress.progress,
            eta: progress.eta,
            error: progress.error,
            outputFile: progress.outputFile
        });
    });

    router.post('/cancel-render', (req, res) => {
        const ok = cancelRender();
        res.json({ success: ok });
    });

    return router;
};
