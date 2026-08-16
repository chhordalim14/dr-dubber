const { app, dialog, BrowserWindow } = require('electron');

app.whenReady().then(async () => {
    console.log("Testing dialog.showOpenDialog without window...");
    try {
        const res = await dialog.showOpenDialog({
            title: "Test Dialog",
            properties: ['openFile', 'multiSelections']
        });
        console.log("Dialog result:", res);
    } catch (e) {
        console.error("Dialog error:", e);
    }
    app.quit();
});
