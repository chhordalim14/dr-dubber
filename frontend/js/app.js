// AI Dubber Pro - Studio Frontend Controller

const state = {
    currentVideoPath: null,
    currentVideoUrl: null,
    currentBgmPath: null,
    currentBgmUrl: null,
    subtitles: [],
    activeSubtitleIndex: -1,
    voices: {},
    isPlaying: false,
    audioPlayers: new Map(), // subId -> Audio
    bgmAudio: new Audio()
};

// DOM Elements
const video = document.getElementById('mainVideo');
const videoSeeker = document.getElementById('videoSeeker');
const seekerFill = document.getElementById('seekerFill');
const timecodeDisplay = document.getElementById('timecodeDisplay');
const videoSubOverlay = document.getElementById('videoSubOverlay');
const subtitlesList = document.getElementById('subtitlesList');

// Sliders & Mixer
const sliderVoiceVol = document.getElementById('sliderVoiceVol');
const sliderBgmVol = document.getElementById('sliderBgmVol');
const sliderDucking = document.getElementById('sliderDucking');
const chkMuteOriginal = document.getElementById('chkMuteOriginal');
const selectGlobalVoice = document.getElementById('selectGlobalVoice');
const selectFont = document.getElementById('selectFont');
const sliderFontSize = document.getElementById('sliderFontSize');

// Status
const statusVideoFile = document.getElementById('statusVideoFile');
const statusBgmFile = document.getElementById('statusBgmFile');
const statusSysMemory = document.getElementById('statusSysMemory');
const statusSubtitleCount = document.getElementById('statusSubtitleCount');

// Render Modal
const renderModal = document.getElementById('renderModal');
const btnOpenRenderModal = document.getElementById('btnOpenRenderModal');
const btnCloseRenderModal = document.getElementById('btnCloseRenderModal');
const btnStartRender = document.getElementById('btnStartRender');
const btnOpenExportFolder = document.getElementById('btnOpenExportFolder');
const renderProgressSection = document.getElementById('renderProgressSection');
const renderProgressFill = document.getElementById('renderProgressFill');
const renderProgressText = document.getElementById('renderProgressText');
const renderProgressEta = document.getElementById('renderProgressEta');

// Initialize Studio
document.addEventListener('DOMContentLoaded', async () => {
    setupTitlebar();
    setupVideoControls();
    setupMixerControls();
    setupSubtitlesTools();
    setupRenderModal();
    
    await loadVoices();
    updateSystemMemory();
    setInterval(updateSystemMemory, 5000);
});

// Titlebar Electron IPC Controls
function setupTitlebar() {
    if (window.electronAPI && window.electronAPI.isElectron) {
        document.getElementById('btnMinimize')?.addEventListener('click', () => window.electronAPI.minimizeWindow());
        document.getElementById('btnMaximize')?.addEventListener('click', () => window.electronAPI.maximizeWindow());
        document.getElementById('btnClose')?.addEventListener('click', () => window.electronAPI.closeWindow());
    }
}

// Load Voices
async function loadVoices() {
    try {
        const res = await fetch('/api/voices');
        const data = await res.json();
        if (data.success && data.voices) {
            state.voices = data.voices;
            selectGlobalVoice.innerHTML = '';
            for (const [key, val] of Object.entries(data.voices)) {
                const opt = document.createElement('option');
                opt.value = key;
                opt.textContent = val.name || key;
                selectGlobalVoice.appendChild(opt);
            }
        }
    } catch (e) {
        console.error('Failed to load voices:', e);
    }
}

// Video Controls & Sync
function setupVideoControls() {
    const btnPlayPause = document.getElementById('btnPlayPause');
    const btnStepBack = document.getElementById('btnStepBack');
    const btnStepForward = document.getElementById('btnStepForward');

    btnPlayPause.addEventListener('click', () => {
        if (video.paused) {
            video.play();
            btnPlayPause.textContent = '⏸ Pause';
            state.isPlaying = true;
        } else {
            video.pause();
            btnPlayPause.textContent = '▶ Play';
            state.isPlaying = false;
        }
    });

    btnStepBack.addEventListener('click', () => {
        video.currentTime = Math.max(0, video.currentTime - 1);
    });

    btnStepForward.addEventListener('click', () => {
        video.currentTime = Math.min(video.duration || 0, video.currentTime + 1);
    });

    video.addEventListener('timeupdate', onVideoTimeUpdate);

    videoSeeker.addEventListener('click', (e) => {
        const rect = videoSeeker.getBoundingClientRect();
        const pos = (e.clientX - rect.left) / rect.width;
        if (video.duration) {
            video.currentTime = pos * video.duration;
        }
    });

    chkMuteOriginal.addEventListener('change', () => {
        video.muted = chkMuteOriginal.checked;
    });
}

function onVideoTimeUpdate() {
    const current = video.currentTime || 0;
    const duration = video.duration || 0;

    // Update timecode
    timecodeDisplay.textContent = `${formatSeconds(current)} / ${formatSeconds(duration)}`;

    // Update seeker
    if (duration > 0) {
        const pct = (current / duration) * 100;
        seekerFill.style.width = `${pct}%`;
    }

    // Sync active subtitle & overlay text
    const activeSub = state.subtitles.find(s => current >= s.startSec && current <= s.endSec);
    if (activeSub) {
        videoSubOverlay.textContent = activeSub.dubbedText || activeSub.originalText || '';
        videoSubOverlay.style.opacity = '1';
    } else {
        videoSubOverlay.textContent = '';
        videoSubOverlay.style.opacity = '0';
    }
}

// Mixer Controls
function setupMixerControls() {
    sliderVoiceVol.addEventListener('input', () => {
        document.getElementById('valVoiceVol').textContent = `${sliderVoiceVol.value}%`;
    });

    sliderBgmVol.addEventListener('input', () => {
        document.getElementById('valBgmVol').textContent = `${sliderBgmVol.value}%`;
    });

    sliderDucking.addEventListener('input', () => {
        document.getElementById('valDucking').textContent = `Auto (-${Math.round(sliderDucking.value * 0.3)}dB)`;
    });

    sliderFontSize.addEventListener('input', () => {
        const sz = sliderFontSize.value;
        document.getElementById('valFontSize').textContent = `${sz}px`;
        videoSubOverlay.style.fontSize = `${sz}px`;
    });

    selectFont.addEventListener('change', () => {
        videoSubOverlay.style.fontFamily = selectFont.value;
    });
}

// File Selection & Toolbar Tools
function setupSubtitlesTools() {
    document.getElementById('btnOpenVideo').addEventListener('click', async () => {
        let filePath = null;
        if (window.electronAPI && window.electronAPI.selectVideoFile) {
            filePath = await window.electronAPI.selectVideoFile();
        }
        if (filePath) {
            loadVideo(filePath);
        } else {
            // HTML input fallback
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = 'video/*';
            input.onchange = (e) => {
                const file = e.target.files[0];
                if (file) loadVideoFile(file);
            };
            input.click();
        }
    });

    document.getElementById('btnOpenSrt').addEventListener('click', async () => {
        let filePath = null;
        if (window.electronAPI && window.electronAPI.selectSrtFile) {
            filePath = await window.electronAPI.selectSrtFile();
        }
        if (filePath) {
            loadSrt(filePath);
        } else {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = '.srt,.vtt,.txt';
            input.onchange = (e) => {
                const file = e.target.files[0];
                if (file) {
                    const reader = new FileReader();
                    reader.onload = (ev) => parseSrtContent(ev.target.result);
                    reader.readAsText(file);
                }
            };
            input.click();
        }
    });

    document.getElementById('btnRemoveVocals').addEventListener('click', separateVocalBgm);
    document.getElementById('btnBatchGenerateTTS').addEventListener('click', batchGenerateAllVoices);
    document.getElementById('btnAddSubtitleRow').addEventListener('click', addNewSubtitleRow);
    document.getElementById('btnExportSrt').addEventListener('click', exportSrtFile);
}

// Load Video
function loadVideo(filePath) {
    state.currentVideoPath = filePath;
    video.src = `http://localhost:5890/api/audio?path=${encodeURIComponent(filePath)}`;
    video.muted = chkMuteOriginal.checked;
    statusVideoFile.textContent = `Video: ${getFilename(filePath)}`;
}

function loadVideoFile(file) {
    state.currentVideoPath = file.name;
    video.src = URL.createObjectURL(file);
    video.muted = chkMuteOriginal.checked;
    statusVideoFile.textContent = `Video: ${file.name}`;
}

// Load SRT
async function loadSrt(filePath) {
    try {
        const res = await fetch('/api/parse-srt', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ srtPath: filePath })
        });
        const data = await res.json();
        if (data.success && data.subtitles) {
            state.subtitles = data.subtitles;
            renderSubtitlesGrid();
        }
    } catch (e) {
        console.error('Error loading SRT:', e);
    }
}

async function parseSrtContent(content) {
    try {
        const res = await fetch('/api/parse-srt', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ srtContent: content })
        });
        const data = await res.json();
        if (data.success && data.subtitles) {
            state.subtitles = data.subtitles;
            renderSubtitlesGrid();
        }
    } catch (e) {
        console.error('Error parsing SRT:', e);
    }
}

// Render Subtitles Grid
function renderSubtitlesGrid() {
    subtitlesList.innerHTML = '';
    statusSubtitleCount.textContent = `${state.subtitles.length} Lines`;

    if (state.subtitles.length === 0) {
        subtitlesList.innerHTML = `<div style="text-align: center; color: var(--text-dim); padding: 40px;">No subtitles loaded.</div>`;
        return;
    }

    state.subtitles.forEach((sub, idx) => {
        const card = document.createElement('div');
        card.className = 'subtitle-item-card';
        card.dataset.index = idx;

        const hasAudio = sub.audioPath ? '✓ Audio Ready' : 'Generate Voice';
        const audioBtnStyle = sub.audioPath ? 'background: rgba(16, 185, 129, 0.2); color: #10b981; border: 1px solid #10b981;' : '';

        card.innerHTML = `
            <div class="subtitle-meta-row">
                <div style="display: flex; align-items: center; gap: 8px;">
                    <span class="sub-index">#${idx + 1}</span>
                    <span class="sub-timing">${sub.startTime} ➔ ${sub.endTime}</span>
                    <span class="sub-duration">(${sub.duration || 0}s)</span>
                </div>
                <div style="display: flex; gap: 6px;">
                    <button class="btn btn-sm" onclick="jumpToSubtitle(${idx})">Seek</button>
                    <button class="btn btn-sm" onclick="deleteSubtitle(${idx})" style="color: var(--danger);">✕</button>
                </div>
            </div>

            <div class="sub-text-inputs">
                <textarea placeholder="Original Text" onchange="updateSubText(${idx}, 'originalText', this.value)">${sub.originalText || ''}</textarea>
                <textarea placeholder="Dubbed Text (Khmer)" onchange="updateSubText(${idx}, 'dubbedText', this.value)">${sub.dubbedText || ''}</textarea>
            </div>

            <div class="sub-actions-row">
                <div style="display: flex; align-items: center; gap: 8px;">
                    <select onchange="updateSubVoice(${idx}, this.value)" style="max-width: 180px;">
                        ${Object.entries(state.voices).map(([k, v]) => `
                            <option value="${k}" ${sub.voice === k ? 'selected' : ''}>${v.name || k}</option>
                        `).join('')}
                    </select>
                </div>
                <div style="display: flex; gap: 8px;">
                    <button class="btn btn-sm" style="${audioBtnStyle}" onclick="generateSingleVoice(${idx}, this)">
                        ${hasAudio}
                    </button>
                    ${sub.audioPath ? `<button class="btn btn-sm btn-accent" onclick="playSubAudio(${idx})">▶ Preview</button>` : ''}
                </div>
            </div>
        `;

        subtitlesList.appendChild(card);
    });
}

// Subtitle Actions
window.jumpToSubtitle = function(idx) {
    const sub = state.subtitles[idx];
    if (sub && video) {
        video.currentTime = sub.startSec;
    }
};

window.updateSubText = function(idx, field, value) {
    if (state.subtitles[idx]) {
        state.subtitles[idx][field] = value;
    }
};

window.updateSubVoice = function(idx, voiceKey) {
    if (state.subtitles[idx]) {
        state.subtitles[idx].voice = voiceKey;
    }
};

window.deleteSubtitle = function(idx) {
    state.subtitles.splice(idx, 1);
    renderSubtitlesGrid();
};

window.playSubAudio = function(idx) {
    const sub = state.subtitles[idx];
    if (sub && sub.audioPath) {
        const audio = new Audio(`/api/audio?path=${encodeURIComponent(sub.audioPath)}`);
        audio.play();
    }
};

window.generateSingleVoice = async function(idx, btn) {
    const sub = state.subtitles[idx];
    if (!sub) return;

    btn.textContent = 'Generating...';
    btn.disabled = true;

    try {
        const res = await fetch('/api/generate-audio', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                id: sub.id || `sub_${idx}`,
                text: sub.dubbedText || sub.originalText,
                voice: sub.voice || selectGlobalVoice.value,
                rate: sub.rate || '+0%',
                pitch: sub.pitch || '+0Hz',
                volume: sub.volume || '+0%'
            })
        });

        const data = await res.json();
        if (data.success) {
            sub.audioPath = data.file;
            sub.audioUrl = data.url;
            sub.generatedDuration = data.duration;
            renderSubtitlesGrid();
        } else {
            alert('TTS failed: ' + (data.error || 'Unknown error'));
            btn.textContent = 'Retry';
            btn.disabled = false;
        }
    } catch (e) {
        alert('Network error generating TTS');
        btn.textContent = 'Retry';
        btn.disabled = false;
    }
};

function addNewSubtitleRow() {
    const current = video.currentTime || 0;
    const newSub = {
        id: `sub_${Date.now()}`,
        index: state.subtitles.length + 1,
        startTime: formatSeconds(current),
        endTime: formatSeconds(current + 3.0),
        startSec: current,
        endSec: current + 3.0,
        duration: 3.0,
        originalText: '',
        dubbedText: '',
        voice: selectGlobalVoice.value,
        rate: '+0%',
        pitch: '+0Hz',
        volume: '+0%',
        audioPath: null
    };
    state.subtitles.push(newSub);
    renderSubtitlesGrid();
}

// Batch Voice Generation
async function batchGenerateAllVoices() {
    if (state.subtitles.length === 0) {
        alert('Please import or add subtitles first!');
        return;
    }

    const btn = document.getElementById('btnBatchGenerateTTS');
    btn.textContent = '⏳ Generating all voices...';
    btn.disabled = true;

    try {
        const res = await fetch('/api/generate-batch-audio', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                subtitles: state.subtitles,
                defaultVoice: selectGlobalVoice.value
            })
        });

        const data = await res.json();
        if (data.success && data.subtitles) {
            state.subtitles = data.subtitles;
            renderSubtitlesGrid();
            alert(`Successfully generated dubbing for ${data.count} subtitle segments!`);
        }
    } catch (e) {
        alert('Batch generation error: ' + e.message);
    } finally {
        btn.textContent = '⚡ Generate All Dubbing';
        btn.disabled = false;
    }
}

// Vocal & BGM Separation
async function separateVocalBgm() {
    if (!state.currentVideoPath) {
        alert('Please open a video file first!');
        return;
    }

    const btn = document.getElementById('btnRemoveVocals');
    btn.textContent = '⏳ Separating BGM...';
    btn.disabled = true;

    try {
        // Step 1: extract audio if needed
        const extRes = await fetch('/api/extract-audio', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ videoPath: state.currentVideoPath })
        });
        const extData = await extRes.json();
        if (!extData.success) throw new Error(extData.error);

        // Step 2: Separate vocal / accompaniment
        const sepRes = await fetch('/api/remove-vocals', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ audioPath: extData.audioPath })
        });
        const sepData = await sepRes.json();
        if (sepData.success) {
            state.currentBgmPath = sepData.bgmPath;
            state.currentBgmUrl = sepData.bgmUrl;
            statusBgmFile.textContent = `BGM: Extracted & Ready`;
            alert('AI Vocal Separation complete! BGM track isolated successfully.');
        }
    } catch (e) {
        alert('Separation failed: ' + e.message);
    } finally {
        btn.textContent = 'Separate BGM (AI)';
        btn.disabled = false;
    }
}

// Export SRT
function exportSrtFile() {
    if (state.subtitles.length === 0) return;
    let srtText = '';
    state.subtitles.forEach((sub, i) => {
        srtText += `${i + 1}\n${sub.startTime} --> ${sub.endTime}\n${sub.dubbedText || sub.originalText}\n\n`;
    });
    const blob = new Blob([srtText], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'Dubbed_Subtitles_Khmer.srt';
    a.click();
}

// Render Modal & Export Pipeline
function setupRenderModal() {
    btnOpenRenderModal.addEventListener('click', () => {
        renderModal.classList.add('active');
    });

    btnCloseRenderModal.addEventListener('click', () => {
        renderModal.classList.remove('active');
    });

    btnStartRender.addEventListener('click', startRenderProcess);

    btnOpenExportFolder.addEventListener('click', () => {
        fetch('/api/open-folder', { method: 'POST' });
    });
}

async function startRenderProcess() {
    if (!state.currentVideoPath) {
        alert('Please open a video file first!');
        return;
    }

    const outputName = document.getElementById('renderOutputName').value || 'Khmer_Dubbed.mp4';
    const resolution = document.getElementById('renderResolution').value;
    const encoder = document.getElementById('renderEncoder').value;
    const burnSubs = document.getElementById('renderBurnSubs').checked;

    btnStartRender.disabled = true;
    renderProgressSection.style.display = 'flex';
    renderProgressFill.style.width = '0%';
    renderProgressText.textContent = 'Initializing FFmpeg render...';

    try {
        const res = await fetch('/api/render', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                videoPath: state.currentVideoPath,
                subtitles: state.subtitles,
                bgmPath: state.currentBgmPath,
                bgmVolume: parseFloat(sliderBgmVol.value) / 100,
                voiceVolume: parseFloat(sliderVoiceVol.value) / 100,
                duckingEnabled: true,
                muteOriginal: chkMuteOriginal.checked,
                burnSubtitles: burnSubs,
                subtitleFont: selectFont.value,
                subtitleFontSize: parseInt(sliderFontSize.value, 10),
                resolution: resolution,
                encoder: encoder,
                outputFileName: outputName
            })
        });

        const data = await res.json();
        if (data.success) {
            // Poll render progress
            pollRenderProgress();
        }
    } catch (e) {
        alert('Render start failed: ' + e.message);
        btnStartRender.disabled = false;
    }
}

function pollRenderProgress() {
    const timer = setInterval(async () => {
        try {
            const res = await fetch('/api/render-progress');
            const data = await res.json();
            
            if (data.status === 'rendering') {
                renderProgressFill.style.width = `${data.progress}%`;
                renderProgressText.textContent = `Rendering: ${data.progress}%`;
                renderProgressEta.textContent = `ETA: ${data.eta}`;
            } else if (data.status === 'completed') {
                clearInterval(timer);
                renderProgressFill.style.width = '100%';
                renderProgressText.textContent = '✓ Render Complete!';
                renderProgressEta.textContent = 'Done';
                btnStartRender.disabled = false;
                btnOpenExportFolder.style.display = 'inline-flex';
            } else if (data.status === 'failed') {
                clearInterval(timer);
                alert('Render failed: ' + (data.error || 'Unknown error'));
                btnStartRender.disabled = false;
            }
        } catch (e) {
            clearInterval(timer);
        }
    }, 1000);
}

// Telemetry
async function updateSystemMemory() {
    try {
        const res = await fetch('/api/system-memory');
        const data = await res.json();
        if (data.success) {
            statusSysMemory.textContent = `RAM: ${data.usedMemoryGB}GB / ${data.totalMemoryGB}GB (${data.percentUsed}%)`;
        }
    } catch (e) {}
}

function formatSeconds(secs) {
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = Math.floor(secs % 60);
    const ms = Math.floor((secs - Math.floor(secs)) * 1000);
    return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(ms, 3)}`;
}

function pad(n, z = 2) {
    return ('' + n).padStart(z, '0');
}

function getFilename(pathStr) {
    if (!pathStr) return '';
    return pathStr.split(/[\\/]/).pop();
}
