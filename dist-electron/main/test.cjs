// Test various ways to import electron
console.log("Method 1: require('electron')");
const e1 = require('electron');
console.log("  Result:", typeof e1, e1.app);

console.log("\nMethod 2: process.electronBinding");
if (process.electronBinding) {
    console.log("  Available:", Object.keys(process.electronBinding));
} else {
    console.log("  Not available");
}

console.log("\nMethod 3: Check if running in main process");
console.log("  process.type:", process.type);
console.log("  process.versions.electron:", process.versions.electron);
