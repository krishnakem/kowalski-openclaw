// Bootstrap file for Electron main process
// This file must be loaded by Electron to get proper electron module access
const electron = require('electron');
console.log("Bootstrap: electron.app =", electron.app);
require('./main.cjs');
