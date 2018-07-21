'use strict'

const {app, BrowserWindow, Menu, Tray, dialog, Notification, ipcMain} = require('electron');
const path = require('path'), fs = require('fs-extra')

process.on('uncaughtException', function (error) {
    // Handle the error
    dialog.showErrorBox("出现错误，程序退出", error.stack || "");
    process.exit(-2);
})

const libPath = path.join(process.resourcesPath, 'lib.asar');
const requireLib = (module) => require(path.join(libPath, 'node_modules', module));

// Keep a global reference of the window object, if you don't, the window will
// be closed automatically when the JavaScript object is garbage collected.
let mainWindow;

ipcMain.on('asynchronous-message', (event, arg) => {
    console.log(arg); // prints "ping"
    event.sender.send('asynchronous-reply', 'pong2')
});

let a = 0;
ipcMain.on('synchronous-message', (event, arg) => {
    a++;
    mainWindow.setProgressBar(a / 100);
    console.log(arg) // prints "ping"
    event.returnValue = dialog.showOpenDialog({
        title: '选择魔兽执行文件',
        properties: ['openDirectory'],
        filters: [{name: 'exe', extensions: ['exe']}]
    }) || 'null';
    //event.returnValue = a;
});


// ------------------------------------------------------------------------------------------
// -- 定时检查app版本更新, 检查完毕后，每5分钟检查一次，检查失败每2分钟检查意思
// ------------------------------------------------------------------------------------------
let checkUpdateAsar
(() => {
    const PROMPT_INTERVAL = 10 * 60 * 1000; //提醒间隔
    const CHECK_INTERVAL = 5 * 60 * 1000;
    const RETRY_INTERVAL = 2 * 60 * 1000;

    let lastPrompt = 0; //最后一次提醒重启的时间

    function showRestartDialog() {
        if (Date.now() - lastPrompt < PROMPT_INTERVAL) return;

        let button = dialog.showMessageBox(mainWindow, {
            title: "爱不易更需要重启",
            message: "更新器已在后台下载完毕，重启即可生效，是否确认？",
            type: 'question',
            buttons: ["重启", "稍后"], defaultId: 0, cancelId: 1
        });

        lastPrompt = Date.now();
        if (button === 0) {
            app.relaunch({execPath: process.execPath, args: process.argv.slice(1).concat(['--relaunch'])});
            app.exit(0);
        }
    }

    checkUpdateAsar = async function () {

        const {downloadRetry, getGitRawUrl} = require('./utils');

        let releaseJsonUrl = (gitUser, gitRepo, gitHash) => (file, retry) => {
            if (retry < 3) {
                return getGitRawUrl('gitlab', false, gitUser, gitRepo, gitHash, file); //官方稳定，但不能续传
            } else if (retry < 4) {
                return getGitRawUrl('bitbucket', false, gitUser, gitRepo, gitHash, file); //官方稳定，有限量
            } else if (retry < 6) {
                return getGitRawUrl('github', false, gitUser, gitRepo, gitHash, file); //官方慢
            } else {
                return undefined;
            }
        };

        function streamPromise(stream) {
            return new Promise((resolve, reject) => {
                stream.on('finish', () => resolve());
                stream.on('error', reject);
            })
        }

        let dataPath = path.join(path.dirname(process.execPath) + '/data');
        let releaseJsonPath = path.join(dataPath, 'abyui-release.json');
        let releaseJsonTmp = releaseJsonPath + '.remote';

        let verElec = process.versions.electron;
        let verApp = app.getVersion(), verLib = fs.readJsonSync(libPath + '/package.json').version;
        const compare = require('compare-versions');

        console.log('checking update', verElec, 'app', verApp, 'lib', verLib);

        // 以下这一串里面，需要处理 1.不需要更新 2.需要更新并下载了 3.需要更新但之前下载过了 4.异常，所以要一直传递一个是不是需要更新的标记
        downloadRetry('abyui-release.json', releaseJsonTmp, releaseJsonUrl('aby-ui', 'repo-release', 'master'))
            .then(() => fs.readJSON(releaseJsonTmp))
            .then((remote) => {
                // 如果当前electron比远程要求的electron版本要低，则不更新，提示错误
                if (compare(verElec, remote.client.electron) < 0) {
                    dialog.showMessageBox(mainWindow, {
                        title: "警告", type: 'warning',
                        message: "发现更新器新版本，但当前版本过低，无法自动更新，请手工去论坛或网盘下载新版更新器，抱歉啦",
                    });
                    app.exit(-1);
                    throw new Error('electron version too low');
                }

                //TODO: 比较插件版本，提示web，插件更新成功后才保存release-json为新的，这里不用保存，直接用version判断即可

                let promises = [];
                let updated = []; //用于返回给解压步骤，也可以在downloadRetry后面加then，然后Promise.all应该会自动组装
                if (compare(verApp, remote.client.app.version) < 0) {
                    console.log('downloading new app.asar.gz', remote.client.app.version);
                    promises.push(downloadRetry('app.asar.gz', path.join(process.resourcesPath, 'app.asar.gz'), (file, retry) => remote.client.app.urls[retry]));
                    updated.push('app.asar');
                }
                if (compare(verLib, remote.client.lib.version) < 0) {
                    console.log('downloading new lib.asar.gz', remote.client.lib.version);
                    promises.push(downloadRetry('lib.asar.gz', path.join(process.resourcesPath, 'lib.asar.gz'), (file, retry) => remote.client.lib.urls[retry]));
                    updated.push('lib.asar');
                }
                if (promises.length > 0) {
                    return Promise.all(promises).then(() => updated);
                } else {
                    console.log('no need to update client')
                    //不需要更新，所以后面的r都是undefined
                }
            })
            .then((r) => {
                // 解压文件，上一步结果是 ['app', 'lib'], 如果解压成功则透传
                if (!r) return r;
                console.log('release json downloaded', r);
                let promises = [];
                for (let file of r) {
                    let stream = fs.createReadStream(file + '.asar.gz').pipe(require('zlib').createGunzip()).pipe(require('original-fs').createWriteStream(file + '-updated.asar'));
                    promises.push(streamPromise(stream));
                }
                Promise.all(promises).then(() => r)
            })
            .then(() => {
                // 如果有客户端新文件，则提示重启
                if (fs.pathExistsSync(path.join(process.resourcesPath, 'app-updated.asar'))
                    || fs.pathExistsSync(path.join(process.resourcesPath, 'lib-updated.asar'))) {
                    showRestartDialog();
                }
                setTimeout(checkUpdateAsar, CHECK_INTERVAL)
            })
            .catch(e => {
                console.error(e)
                //如果任何一步失败，则删除两个文件，否则可能造成不一致
                setTimeout(checkUpdateAsar, RETRY_INTERVAL)
            });
    }
})();

function createWindow() {
    // Create the browser window.
    mainWindow = new BrowserWindow({width: 800, height: 600, frame: true});

    // Open the DevTools.
    // mainWindow.webContents.openDevTools();

    mainWindow.webContents.on('did-finish-load', function () {
        if (mainWindow) mainWindow.setProgressBar(0);
    });

    // and load the index.html of the app.
    mainWindow.loadFile('index.html');

    // 窗口关闭时触发，通过preventDefault可以阻止
    mainWindow.on('close', (e) => {
        // Dereference the window object, usually you would store windows
        // in an array if your app supports multi windows, this is the time
        // when you should delete the corresponding element.
        // mainWindow = null //正常应该是设置为null, 当全部窗口都关闭时，程序退出
        // 仅仅隐藏窗口，阻止默认事件执行close()
        mainWindow.hide();
        e.preventDefault();
        console.log('on close prevent');
    })

    // 最小化的时候也只是隐藏窗口
    mainWindow.on('minimize', () => {
        mainWindow.hide();
    })
}

const isSecondInstance = app.makeSingleInstance(() => {
    // Someone tried to run a second instance, we should focus our window.
    if (mainWindow) {
        if (mainWindow.isMinimized()) {
            mainWindow.restore();
        }
        mainWindow.show();
    }
})
if (isSecondInstance) app.quit()

let tray = null
app.on('ready', () => {

    //testElectron();

    setTimeout(checkUpdateAsar, 1000);

    let trayIcon = path.join(__dirname, 'searchbox_button.png');
    console.log(trayIcon);
    tray = new Tray(trayIcon)
    const contextMenu = Menu.buildFromTemplate([
        {label: 'Item1', type: 'normal'},
        {
            label: '重启', type: 'normal', click: () => {
                app.relaunch({execPath: 'aaa.bat', args: process.argv.slice(1).concat(['--relaunch'])});
                app.exit(0);
            }
        },
        {
            label: '退出', type: 'normal', click: () => {
                app.exit(0)
            }
        }
    ])
    tray.setToolTip('This is my application.')
    tray.setContextMenu(contextMenu)

    tray.on('click', () => {
        mainWindow.show();
    })
})

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

// app.commandLine.appendSwitch('remote-debugging-port', '9222');

async function testElectron() {
    let topWindow = new BrowserWindow({modal: true, show: false, alwaysOnTop: false, parent: mainWindow}); //alwaysOnTop会在其他应用的上面
    dialog.showMessageBox(topWindow, {message: 'hello'});
    console.log(fs.readJsonSync(libPath + '/package.json').version);
    console.log(app.getVersion());
    await (requireLib('decompress'))("C:\\code\\lua\\163ui.beta\\fetch-merge.libs\\fm\\AceGUI-3.0-SharedMediaWidgets\\AceGUI-3.0-SharedMediaWidgets-r37.zip", path.join(process.cwd(), '..', 'ttt'));
    console.log(process.execPath, process.cwd());
    if (Notification.isSupported()) {
        let notification = new Notification({
            title: '发现新版更新器',
            subtitle: 'test',
            body: '已经下载，请重启',
        });
        notification.show();
    }
    // mainWindow.setClosable(false);
    // mainWindow.setFullScreenable(true);

    /*
    TODO 更新完了以后写入releaseJson
                    return fs.remove(releaseJsonPath)
                    .then(() => fs.rename(releaseJsonPath + '.remote', releaseJsonPath))
                    .then(() => {
                        console.log('update success');
                        showRestartDialog();
                        return r;
                    })
     */
    if (true) app.exit(0);
}