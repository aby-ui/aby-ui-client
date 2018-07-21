'use strict'

const {app, BrowserWindow, Menu, Tray, dialog, Notification, ipcMain} = require('electron');
const path = require('path'), fs = require('fs-extra')

process.on('uncaughtException', function (error) {
    // Handle the error
    dialog.showErrorBox("出现错误，程序退出", error.stack || "");
    process.exit(-2);
})

const getRes = file => path.join(process.resourcesPath, file);
const libPath = getRes('lib.asar');
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

        let releaseRemote = getRes('data/abyui-release.json.remote');

        //当前版本
        let verElec = process.versions.electron;
        let vers = {app: app.getVersion(), lib: fs.readJsonSync(libPath + '/package.json').version};
        const compare = require('compare-versions');

        //vers = { app: "1.0.1", lib: "1.0.1" };
        console.log('checking update', verElec, vers);

        // 以下这一串里面，需要处理 1.不需要更新 2.需要更新 3.异常，所以要一直传递一个标记。后来不传了，用updated文件是否存在来判断
        downloadRetry('abyui-release.json', releaseRemote, releaseJsonUrl('aby-ui', 'repo-release', 'master'))
            .then(() => fs.readJSON(releaseRemote))
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
                //一个小循环，防止写两遍
                for (let part of ['app', 'lib']) {
                    let remoteVer = remote.client[part].version;
                    //版本低于远程版本则尝试更新
                    if (compare(vers[part], remoteVer) < 0) {
                        let gzFile = getRes(part + '-v' + remoteVer + '.gz');
                        //文件不存在则下载后改名，已经存在直接解压
                        let prom = Promise.resolve();
                        if (!fs.existsSync(gzFile)) {
                            console.log('downloading new', part, remoteVer);
                            let temp = getRes(part + '.downloading');
                            prom = downloadRetry(part + '.asar.gz', temp, (file, retry) => remote.client[part].urls[retry])
                                .then(() => fs.rename(temp, gzFile))
                        }
                        //解压
                        prom = prom
                            .then(() => {
                                let stream = fs.createReadStream(gzFile)
                                    .pipe(require('zlib').createGunzip())
                                    .pipe(require('original-fs').createWriteStream(getRes(part + '-updated.asar')));
                                return streamPromise(stream);
                            })
                            .then(() => part);
                        promises.push(prom);
                    }
                }

                if (promises.length > 0) {
                    return Promise.all(promises);
                } else {
                    console.log('no need to update client')
                }
            })
            .then((r) => {
                // 如果有客户端新文件，则提示重启
                if (fs.pathExistsSync(getRes('app-updated.asar')) || fs.pathExistsSync(getRes('lib-updated.asar'))) {
                    showRestartDialog();
                } else {
                    console.log('no updated file created');
                }
                setTimeout(checkUpdateAsar, CHECK_INTERVAL)
            })
            .catch(e => {
                console.error(e)
                //如果任何一步失败，则删除两个文件，否则可能造成不一致
                fs.removeSync(getRes('app-updated.asar'));
                fs.removeSync(getRes('lib-updated.asar'));
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