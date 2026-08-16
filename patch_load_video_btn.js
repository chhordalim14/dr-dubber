const fs = require('fs');
const path = require('path');

const indexHtmlPath = path.join(__dirname, 'frontend', 'index.html');
let html = fs.readFileSync(indexHtmlPath, 'utf8');

const targetListener = `btnLoadVideo.addEventListener("click", async () => {
        if (window.electronAPI && window.electronAPI.openMultiFile) {
          const result = await window.electronAPI.openMultiFile({
            filters: [
              {
                name: "Video Files",
                extensions: ["mp4", "mkv", "mov", "avi", "webm", "flv", "wmv", "ts"],
              },
            ],
            defaultPath: localStorage.getItem("lastPath:loadVideo") || "",
          });
          if (result.canceled || !result.files) return;
          localStorage.setItem("lastPath:loadVideo", result.dirPath || "");
          const files = result.files;
          loadVideoFiles(
            files.map((f) => ({
              name: f.fileName,
              path: f.filePath,
              url: f.fileUrl,
            })),
          );
        } else {
          // fallback for non-electron (dev)
          videoUploadInput.setAttribute("multiple", "true");
          videoUploadInput.click();
        }
      });`;

const updatedListener = `btnLoadVideo.addEventListener("click", async () => {
        try {
          if (window.electronAPI && typeof window.electronAPI.openMultiFile === "function") {
            const result = await window.electronAPI.openMultiFile({
              filters: [
                {
                  name: "All Supported Video / Audio Files",
                  extensions: ["*"],
                },
              ],
              defaultPath: localStorage.getItem("lastPath:loadVideo") || "",
            });
            if (result && !result.canceled && result.files && result.files.length > 0) {
              localStorage.setItem("lastPath:loadVideo", result.dirPath || "");
              loadVideoFiles(
                result.files.map((f) => ({
                  name: f.fileName,
                  path: f.filePath,
                  url: f.fileUrl,
                })),
              );
              return;
            }
          }
        } catch (err) {
          console.warn("Electron dialog failed, falling back to input:", err);
        }
        // Universal fallback (browser or dialog failure)
        videoUploadInput.setAttribute("multiple", "true");
        videoUploadInput.click();
      });`;

if (html.includes(targetListener)) {
    html = html.replace(targetListener, updatedListener);
    fs.writeFileSync(indexHtmlPath, html, 'utf8');
    console.log("Successfully updated btnLoadVideo listener in index.html!");
} else {
    console.log("Target listener not exact, checking regex replacement...");
    const regex = /btnLoadVideo\.addEventListener\("click"[\s\S]*?videoUploadInput\.click\(\);\s*\}\s*\}\);/;
    if (regex.test(html)) {
        html = html.replace(regex, updatedListener);
        fs.writeFileSync(indexHtmlPath, html, 'utf8');
        console.log("Applied regex replacement for btnLoadVideo listener!");
    } else {
        console.log("Regex pattern not matched");
    }
}
