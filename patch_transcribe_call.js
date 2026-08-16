const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'frontend', 'index.html');
let content = fs.readFileSync(filePath, 'utf8');

const oldTranscribeCall = `body: JSON.stringify({
                      audioBase64: audioBase64,
                      mimeType: audioBlob.type || "audio/mp3",
                      duration: totalDur,
                      targetLanguage: targetProject.targetLanguage || targetLanguage,
                      apiKey: key,
                      model: activeModel,
                      requestId: targetProject.geminiRequestId,
                    }),`;

const newTranscribeCall = `body: JSON.stringify({
                      audioBase64: audioBase64,
                      mimeType: audioBlob.type || "audio/mp3",
                      duration: totalDur,
                      targetLanguage: targetProject.targetLanguage || targetLanguage,
                      apiKey: key,
                      model: activeModel,
                      requestId: targetProject.geminiRequestId,
                      videoName: (targetProject.file && targetProject.file.name) || "video",
                      customFolder: localStorage.getItem("aiDubberAutoSaveSrtCustomPath") || localStorage.getItem("aiDubberExportPath") || "",
                    }),`;

if (content.includes(oldTranscribeCall)) {
    content = content.replace(oldTranscribeCall, newTranscribeCall);
    fs.writeFileSync(filePath, content, 'utf8');
    console.log("Successfully updated /api/transcribe request body in index.html");
} else {
    console.log("Warning: oldTranscribeCall pattern not found, checking alternatives...");
}
