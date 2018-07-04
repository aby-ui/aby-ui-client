// Modules to control application life and create native browser window
const {app, BrowserWindow, Menu, Tray, dialog} = require('electron');

const request = require('request');
const fs = require('fs-extra');
const progress = require('request-progress');


// Keep a global reference of the window object, if you don't, the window will
// be closed automatically when the JavaScript object is garbage collected.
let mainWindow;
let child;

//https://stackoverflow.com/questions/18323152/get-download-progress-in-node-js-with-request
// let url = 'https://raw.githubusercontent.com/WeakAuras/WeakAuras2/8.0-beta8/WeakAurasModelPaths/ModelPaths.lua'
// let url = 'https://rawcdn.githack.com/WeakAuras/WeakAuras2/8.0-beta8/WeakAurasModelPaths/ModelPaths.lua'
let url = 'https://codeload.github.com/WeakAuras/WeakAuras2/zip/master'
// let url = 'https://rawcdn.githack.com/warbaby/testzip/17d00448333f1e11a4d551c5b1937bc8baa92286/1.zip'
/*
progress(request(url))
        .on('progress', state => {
            console.log(state);
            if(state.percent!=null) mainWindow.setProgressBar(state.percent);
        })
        .on('end', () => { console.log('done'); mainWindow.setProgressBar(1); })
        .on('error', err => console.log(err))
        .pipe(fs.createWriteStream('big.lua'))
*/

const {ipcMain} = require('electron')
ipcMain.on('asynchronous-message', (event, arg) => {
    console.log(arg); // prints "ping"
    event.sender.send('asynchronous-reply', 'pong2')
})

let a = 0;
ipcMain.on('synchronous-message', (event, arg) => {
    a++;
    mainWindow.setProgressBar(a / 100);
    console.log(arg) // prints "ping"
    event.returnValue = dialog.showOpenDialog({ title: '选择魔兽执行文件', properties: ['openDirectory'], filters: [ { name: 'exe', extensions: ['exe'] }]}) || 'null';
    //event.returnValue = a;
})

function createWindow () {
    // Create the browser window.
    mainWindow = new BrowserWindow({width: 800, height: 600, frame: true});
    // child = new BrowserWindow({modal:true, parent: mainWindow});

    mainWindow.webContents.openDevTools();

    mainWindow.webContents.on('did-finish-load', function() {
        mainWindow.setProgressBar(0);
    });

    // and load the index.html of the app.
    mainWindow.loadFile('index.html');

    // child.loadFile('index.html');


    // Open the DevTools.
    // mainWindow.webContents.openDevTools()

    // Emitted when the window is closed.
    mainWindow.on('closed', function (e) {
        // Dereference the window object, usually you would store windows
        // in an array if your app supports multi windows, this is the time
        // when you should delete the corresponding element.
        console.log("closed")
        mainWindow = null
    })

    // mainWindow.setClosable(false);
    // mainWindow.setFullScreenable(true);

    mainWindow.on('close', (e) => {
        console.log('on close prevent');
        mainWindow.hide();
        // e.preventDefault();
    })

    mainWindow.on('minimize', () => {
        console.log("minimized")
        //mainWindow.hide();
    })
}

const isSecondInstance = app.makeSingleInstance((commandLine, workingDirectory) => {
    // Someone tried to run a second instance, we should focus our window.
    if (mainWindow) {
        if (mainWindow.isMinimized()) {
            mainWindow.restore()
            mainWindow.focus()
        } else {
            mainWindow.show()
        }
    }
})

if (isSecondInstance) {
    app.quit()
}

let tray = null
app.on('ready', () => {
    //dialog.showMessageBox( { message : process.execPath + " " + process.argv.join(" ") } );

    //console.log(process.execPath, process.argv);
    tray = new Tray('searchbox_button.png')
    const contextMenu = Menu.buildFromTemplate([
                                                   {label: 'Item1', type: 'normal'},
                                                   {label: '重启', type: 'normal', click: () => { app.relaunch({execPath : 'aaa.bat', args: process.argv.slice(1).concat(['--relaunch'])}); app.exit(0); }},
                                                   {label: '退出', type: 'normal', click: () => { app.exit(0) }}
                                               ])
    tray.setToolTip('This is my application.')
    tray.setContextMenu(contextMenu)

    tray.on('click', () => {
        mainWindow.show();
    })
})

process.on('uncaughtException', function (error) {
    // Handle the error
    dialog.showErrorBox("出现错误，程序退出", error.stack || "");
    app.exit(-2);
})

// app.commandLine.appendSwitch('remote-debugging-port', '9222');

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.on('ready', createWindow);

// Quit when all windows are closed.
app.on('window-all-closed', function () {
    // On OS X it is common for applications and their menu bar
    // to stay active until the user quits explicitly with Cmd + Q
    if (process.platform !== 'darwin') {
        app.quit()
    }
});

app.on('activate', function () {
    // On OS X it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (mainWindow === null) {
        createWindow()
    }
});

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
