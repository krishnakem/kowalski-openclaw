// Entry point for Electron main process
// Using ESM imports as required by "type": "module" in package.json
import electron from 'electron';
console.log("Entry: electron =", electron);
console.log("Entry: electron.app =", electron.app);
console.log("Entry: process.type =", process.type);
