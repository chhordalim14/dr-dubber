const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'frontend', 'index.html');
let content = fs.readFileSync(filePath, 'utf8');

const target = `body: JSON.stringify({
                      audioBase64: audioBase64,
                      mimeType: audioBlob.type || "audio/mp3",
                      duration: totalDur,
                      targetLanguage: targetProject.targetLanguage || targetLanguage,
                      apiKey: key,
                      model: activeModel,
                      requestId: targetProject.geminiRequestId,
                    }),`;

const replacement = `body: JSON.stringify({
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

content = content.replace(target, replacement);
fs.writeFileSync(filePath, content, 'utf8');
console.log('Successfully patched index.html for customFolder transcribe pass-through!');
