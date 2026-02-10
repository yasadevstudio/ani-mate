// YASA PRESENTS
// preload.js - ANI-MATE Electron Preload

const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    isElectron: true
});
