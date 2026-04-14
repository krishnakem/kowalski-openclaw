// Minimal test for Electron module loading
const electron = require('electron');
console.log("electron:", typeof electron, electron);
console.log("electron.app:", electron.app);

if (electron.app) {
    electron.app.on('ready', () => {
        console.log("App is ready!");
        electron.app.quit();
    });
} else {
    console.log("ERROR: electron.app is undefined");
    process.exit(1);
}
