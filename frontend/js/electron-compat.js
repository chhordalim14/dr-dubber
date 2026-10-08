// Electron 32+ removed File.path. The studio reads file.path in many places
// (drag & drop, file inputs) to send the real disk path to the backend, so
// restore it from webUtils.getPathForFile via the preload bridge. Loaded
// before every other script.
(function () {
  const api = window.electronAPI;
  if (!api || typeof api.getPathForFile !== "function") return;
  if (Object.getOwnPropertyDescriptor(File.prototype, "path")) return;
  Object.defineProperty(File.prototype, "path", {
    configurable: true,
    get() {
      try {
        return api.getPathForFile(this) || "";
      } catch (e) {
        return "";
      }
    },
  });
})();
