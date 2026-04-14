// Entry point for Electron main process (ESM)
// Debug electron module exports
import electron from 'electron/main';

console.log("Entry: electron =", electron);
console.log("Entry: typeof electron =", typeof electron);
console.log("Entry: Object.keys =", electron ? Object.keys(electron) : "N/A");
console.log("Entry: process.type =", process.type);
console.log("Entry: process.versions.electron =", process.versions.electron);
