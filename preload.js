const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    // Platform info
    platform: process.platform,
    getBackendPort: () => ipcRenderer.invoke('app:getBackendPort'),
    getHardwareSpecs: () => ipcRenderer.invoke('app:getHardwareSpecs'),
    getDriveSpace: () => ipcRenderer.invoke('app:getDriveSpace'),
    getDeviceFingerprint: () => ipcRenderer.invoke('app:getDeviceFingerprint'),
    getCacheSize: (p) => ipcRenderer.invoke('app:getCacheSize', p),
    clearCache: (p) => ipcRenderer.invoke('app:clearCache', p),

    // File Dialogs & System operations
    openFile: (opts) => ipcRenderer.invoke('dialog:openFile', opts),
    openMultiFile: (opts) => ipcRenderer.invoke('dialog:openMultiFile', opts),
    selectFolder: (opts) => ipcRenderer.invoke('dialog:selectFolder', opts),
    checkPathExists: (p) => ipcRenderer.invoke('app:checkPathExists', p),
    saveSrt: (data) => ipcRenderer.invoke('app:saveSrt', data),
    saveTextFile: (data) => ipcRenderer.invoke('app:saveTextFile', data),
    autoSaveSrt: (data) => ipcRenderer.invoke('app:autoSaveSrt', data),
    readFileAsBase64: (p) => ipcRenderer.invoke('app:readFileAsBase64', p),
    readFileAsText: (p) => ipcRenderer.invoke('app:readFileAsText', p),
    openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),
    openExternalUrl: (url) => ipcRenderer.invoke('app:openExternal', url),

    // Whisper Transcription
    runWhisperTranscribe: (opts) => ipcRenderer.invoke('whisper:transcribe', opts),
    cancelWhisperTranscribe: (id) => ipcRenderer.invoke('whisper:cancel', id),
    checkWhisperFolder: (p) => ipcRenderer.invoke('whisper:checkFolder', p),
    onWhisperLog: (cb) => ipcRenderer.on('whisper:log', (e, d) => cb(d)),

    // VoxCPM2 / TTS Server Controls
    startVoxServer: (opts) => ipcRenderer.invoke('voxcpm2:startServer', opts),
    stopVoxServer: () => ipcRenderer.invoke('voxcpm2:stopServer'),
    voxServerStatus: () => ipcRenderer.invoke('voxcpm2:serverStatus'),
    writeVoxLog: (msg) => ipcRenderer.send('voxcpm2:writeLog', msg),
    onVoxServerLog: (cb) => ipcRenderer.on('voxcpm2:log', (e, d) => cb(d)),
    onVoxServerStopped: (cb) => ipcRenderer.on('voxcpm2:serverStopped', (e, d) => cb(d)),

    // Presets
    savePreset: (p) => ipcRenderer.invoke('preset:save', p),
    loadPresets: () => ipcRenderer.invoke('preset:load'),
    deletePreset: (id) => ipcRenderer.invoke('preset:delete', id),

    // Window Controls
    minimizeWindow: () => ipcRenderer.send('window:minimize'),
    maximizeWindow: () => ipcRenderer.send('window:maximize'),
    closeWindow: () => ipcRenderer.send('window:close'),
    onRequestQuit: (cb) => ipcRenderer.on('app:requestQuit', cb),
    confirmQuit: () => ipcRenderer.invoke('app:confirmQuit'),

    isElectron: true
});
