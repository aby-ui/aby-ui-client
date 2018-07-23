// This file is required by the index.html file and will
// be executed in the renderer process for that window.
// All of the Node.js APIs are available in this process.

console.log('renderer.js');
window.$ = window.jQuery = require('./jquery.min.js');
const {ipcRenderer} = require('electron');
window.fire = function() {
    ipcRenderer.send('ABYUI_MAIN', ...arguments);
}
window.ipcRenderer = ipcRenderer;
