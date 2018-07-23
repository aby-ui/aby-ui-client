'use strict'
const debugging = true;
let GIT_USER = 'aby-ui';

const {app, BrowserWindow, Menu, Tray, dialog, Notification, ipcMain} = require('electron');
const path = require('path'), fs = require('fs-extra')

process.on('uncaughtException', function (error) {
    // Handle the error
    dialog.showErrorBox("出现错误，程序退出", error.stack || "");
    process.exit(-2);
})

// app.commandLine.appendSwitch('remote-debugging-port', '9222');

const getRes = file => path.join(process.resourcesPath, file);
const libPath = getRes('lib.asar');
const requireLib = (module) => require(path.join(libPath, 'node_modules', module));

// Keep a global reference of the window object, if you don't, the window will
// be closed automatically when the JavaScript object is garbage collected.
let mainWindow;

//发送ABYUI_RENDER事件
function fire() {
    if (mainWindow && mainWindow.webContents) {
        mainWindow.webContents.send('ABYUI_RENDER', ...arguments);
    }
}

const EventEmitter = require('events');
const evm = new EventEmitter();
const EVENT_GET_WOW_PATH = 'EVENT_GET_WOW_PATH'
//evm.emit(EVENT_GET_WOW_PATH, wowPath);
evm.on(EVENT_GET_WOW_PATH, (arg1) => {
    console.log(arg1);
})

// ------------------------------------------------------------------------------------------
// -- 加载配置项
// ------------------------------------------------------------------------------------------
let localJsonPath = getRes('data/abyui-local.json')
let localData;
if (fs.existsSync(localJsonPath)) {
    localData = fs.readJsonSync(localJsonPath);
} else {
    fs.ensureDirSync(path.dirname(localJsonPath));
    localData = {currWowPath: "", usedWowPaths: [], repos: {}}
    saveLocalData();
}

function saveLocalData() {
    fs.writeJsonSync(localJsonPath, localData);
}

// 更新器下载的临时文件
let releaseData; //最后一次读取到的更新数据
let releaseRemote = getRes('data/abyui-release.json.remote');

function updateReleaseData() {
    if (fs.existsSync(releaseRemote)) {
        try {
            releaseData = fs.readJsonSync(releaseRemote);
        } catch (e) {
        }
    }
    checkUpdateAddOn();
    return releaseData;
}

// ------------------------------------------------------------------------------------------
// -- 插件更新事件
// ------------------------------------------------------------------------------------------
function checkUpdateAddOn() {
    let wowPath = getAddOnDir();
    if (!wowPath) {
        return fire('SetUpdateInfo', '请先选择魔兽世界目录', false);
    }
    if (!releaseData) {
        return fire('SetUpdateInfo', '尚未取得新版本信息', false);
    } else {
        //TODO 比较版本
        return fire('SetUpdateInfo', '发现新版本，更新时间 2018-07-23 10:30', true);
    }
}

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

        //当前版本
        let verElec = process.versions.electron;
        let vers = {app: app.getVersion(), lib: fs.readJsonSync(libPath + '/package.json').version};
        const compare = require('compare-versions');

        //vers = {app: "1.0.1", lib: "1.0.1"};
        console.log('checking update', verElec, vers);

        // 以下这一串里面，需要处理 1.不需要更新 2.需要更新 3.异常，所以要一直传递一个标记。后来不传了，用updated文件是否存在来判断
        downloadRetry('abyui-release.json', releaseRemote + ".downloading", releaseJsonUrl(GIT_USER, 'repo-release', 'master'))
            .then(() => fs.remove(releaseRemote))
            .then(() => fs.rename(releaseRemote + ".downloading", releaseRemote))
            .then(() => updateReleaseData())
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

function _isWowPathVaid(wowPath) {
    //TODO mac
    if (wowPath && wowPath.trim().length > 0) {
        return fs.existsSync(path.join(wowPath, 'Wow.exe'));
    }
}

/**
 * 获取插件路径
 * @param manual 手工
 * @returns {string}
 */
function getAddOnDir(manual) {
    //读取配置里保存的魔兽目录
    let wowPath = localData.currWowPath;
    if (!_isWowPathVaid(wowPath)) wowPath = undefined;

    //TODO regedit win32

    if (manual) {
        while (true) {
            let chosen = dialog.showOpenDialog(mainWindow, {
                title: '选择魔兽执行文件',
                properties: ['openFile'],
                defaultPath: wowPath,
                filters: [{name: 'Wow', extensions: ['exe']}]
            })
            if (!chosen) break;
            let dir = path.dirname(chosen[0]);
            if (_isWowPathVaid(dir)) {
                wowPath = dir;
                localData.currWowPath = wowPath;
                saveLocalData();
                checkUpdateAddOn();
                break;
            } else {
                dialog.showMessageBox(mainWindow, {title: '选择无效', type: 'warning', message: '目录下没有 Wow.exe 文件，请重新选择!'});
            }
        }
    }

    if (wowPath) {
        fire('GetWowPathDone', wowPath);
        return path.resolve(path.join(wowPath, 'Interface/AddOns'));
    }
}

let downloadRepo;
(function () {

    const {downloadRetry, getGitRawUrl} = require('./utils');

    let fileToGitRaw = (gitUser, gitRepo, gitHash) => (file, retry) => {
        if (retry < 2) {
            return getGitRawUrl('gitlab', false, gitUser, gitRepo, gitHash, file); //官方稳定，但不能续传
        } else if (retry < 4) {
            return getGitRawUrl('bitbucket', true, gitUser, gitRepo, gitHash, file); //hack不限量，能续传
        } else if (retry < 5) {
            return getGitRawUrl('gitlab', true, gitUser, gitRepo, gitHash, file); //hack不限量，不能续传
        } else {
            return undefined;
        }
    };

    downloadRepo = async function (repo, hash) {
        console.log('======================= downloading repo', repo, hash);

        //下载成功然后改名
        let savePath = getRes(`data/filelist-${repo}-${hash}.gz`);

        if (!fs.existsSync(savePath)) {
            let bytes = 0;
            try {
                await downloadRetry('.filelist.php', savePath + '.tmp', fileToGitRaw(GIT_USER, repo, hash), delta => console.log('downloaded', bytes += delta));
                console.log('list file downloaded');
                fs.renameSync(savePath + '.tmp', savePath);
            } catch (e) {
                return console.error('无法获取插件变更信息', e);
            }
        } else {
            console.log('use former downloaded');
        }

        let addonDir = path.join('./data/', 'Interface/AddOns');

        fs.ensureDirSync(addonDir);

        let remote = futil.readJsonGZ(savePath);
        let local = futil.buildFileList(addonDir, [], false, true);
        let result = futil.calcDiff(remote, local, addonDir);

        //先删除文件
        result.deleted.forEach(file => {
            fs.removeSync(path.join(addonDir, file))
        });

        let downloads = result.modified.concat(result.added);
        let downloadsCount = downloads.length;
        let downloadsBytes = result.bytes.modified + result.bytes.added;
        let totalBytes = result.bytes.total;
        console.log("FILE need to download:", downloadsCount, ', BYTES:', downloadsBytes + ' / ' + totalBytes);

        let before = process.uptime() * 1000;
        let bytesDownloaded = 0;
        let onDataDelta = (delta) => {
            bytesDownloaded += delta;
            //console.log(`bytesDownloaded: ${bytesDownloaded} / ${downloadsBytes}`)
        };
        let onFileFinish = (file, success, finished, total) => {
            console.log(finished + ' / ' + total, '    ', bytesDownloaded + ' / ' + downloadsBytes);
        };
        await downloadList(downloads, addonDir, fileToGitRaw(GIT_USER, repo, hash), onDataDelta, onFileFinish);

        console.log("downloaded", bytesDownloaded, ', time:', process.uptime() * 1000 - before);

        local = futil.buildFileList(addonDir, [], false, true);
        result = futil.calcDiff(remote, local); //仅比较文件尺寸即可
        let remained = result.modified.length + result.added.length;
        console.log(remained > 0 ? '更新不完全' : '更新成功');
    }
})();

// ------------------------------------------------------------------------------------------
// -- 初始化窗口，加载页面
// ------------------------------------------------------------------------------------------
function createWindow() {
    // Create the browser window.
    mainWindow = new BrowserWindow({
        width: 800,
        height: 600,
        frame: true,
        resizable: false,
        closable: debugging,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            preload: __dirname + '/renderer/preload.js'
        }
    });

    // Open the DevTools.
    mainWindow.webContents.openDevTools();

    mainWindow.webContents.on('did-finish-load', function () {
        if (mainWindow) mainWindow.setProgressBar(0);
    });

    // and load the index.html of the app.
    mainWindow.loadFile('renderer/index.html');

    // 窗口关闭时触发，通过preventDefault可以阻止
    mainWindow.on('close', (e) => {
        // Dereference the window object, usually you would store windows
        // in an array if your app supports multi windows, this is the time
        // when you should delete the corresponding element.
        // mainWindow = null //正常应该是设置为null, 当全部窗口都关闭时，程序退出
        // 仅仅隐藏窗口，阻止默认事件执行close()
        mainWindow.hide();
        if (!debugging) e.preventDefault();
        console.log('on close prevent');
    })

    // 最小化的时候也只是隐藏窗口
    mainWindow.on('minimize', () => {
        mainWindow.hide();
    })

    let trayIcon = path.join(__dirname, 'tray_icon.png');
    let tray = new Tray(trayIcon)
    const contextMenu = Menu.buildFromTemplate([
        {label: '爱不易插件', sublabel: 'aby-ui'},
        {type: 'separator'},
        {
            label: '重启', type: 'normal', click: () => {
                app.relaunch();
                app.exit(0);
            }
        },
        {
            label: '退出', type: 'normal', click: () => {
                app.exit(0)
            }
        }
    ])
    tray.setToolTip('爱不易插件更新器')
    tray.setContextMenu(contextMenu)
    tray.on('click', () => mainWindow.show());
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
if (isSecondInstance) app.exit(-1)

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
function onAppReady() {
    if (isSecondInstance) return;
    //testElectron();

    if(!debugging) setTimeout(checkUpdateAsar, 1000);
    createWindow();

    mainWindow.webContents.once('did-finish-load', () => {
        updateReleaseData();
    });
}

app.on('ready', onAppReady)


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

app.on('browser-window-created', function (e, window) {
    window.setMenu(null);
});

// ------------------------------------------------------------------------------------------
// -- 界面事件
// ------------------------------------------------------------------------------------------
ipcMain.on('ABYUI_MAIN', (event, method, arg1) => {
    switch (method) {
        case 'GetWowPath':
            getAddOnDir(true);
            return event.returnValue = null;
    }
    event.returnValue = null;
});

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