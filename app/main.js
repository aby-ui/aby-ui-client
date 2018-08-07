'use strict'
const debugging = false;
let GIT_USER = 'aby-ui';

const {app, BrowserWindow, Menu, Tray, dialog, Notification, ipcMain, shell} = require('electron');
const path = require('path'), fs = require('fs-extra'), childProc = require('child_process')


let status = {}

process.on('uncaughtException', function (error) {
    // Handle the error
    dialog.showErrorBox("出现错误，程序退出", error.stack || "");
    process.exit(-2);
})

// app.commandLine.appendSwitch('remote-debugging-port', '9222');

const getRes = file => path.join(process.resourcesPath, file);
const libPath = getRes('lib.asar');
const requireLib = (module) => require(path.join(libPath, 'node_modules', module));
const isWin32 = process.platform === 'win32';
const wowExecutable = isWin32 ? 'Wow.exe' : 'World of Warcraft.app';

// Keep a global reference of the window object, if you don't, the window will
// be closed automatically when the JavaScript object is garbage collected.
let mainWindow, tray;

function exitApp(code) {
    mainWindow = null;
    app.exit(code);
}

//发送ABYUI_RENDER事件
function fire() {
    if (mainWindow) {
        if (mainWindow.webContents) {
            mainWindow.webContents.send('ABYUI_RENDER', ...arguments);
        }
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
            // fs.removeSync(releaseRemote); // 不用删
        }
    }
    checkUpdateAddOn();
    return releaseData;
}

// ------------------------------------------------------------------------------------------
// -- 插件更新事件
// ------------------------------------------------------------------------------------------
const ADDON_DIR_JSON = 'abyui-repos.json';

function getLocalAddOnInfo() {
    let addOnDir = getAddOnDir();
    if (addOnDir) {
        // 如果插件目录下存在json，则使用目录下的，否则使用./data里的
        let jsonPath = path.join(addOnDir, ADDON_DIR_JSON);
        if (fs.existsSync(jsonPath)) {
            return fs.readJsonSync(jsonPath);
        } else {
            return localData;
        }
    }
}

function checkUpdateAddOn() {
    let wowPath = getAddOnDir();
    if (!wowPath) {
        return fire('SetUpdateInfo', '请先选择魔兽世界目录', false);
    }
    if (!releaseData) {
        return fire('SetUpdateInfo', '尚未取得新版本信息', false);
    } else {
        //比较版本
        let local = getLocalAddOnInfo().repos['repo-base'];
        let release = releaseData.repos['repo-base'];
        if (local && local.date >= release.date) {
            return fire('SetUpdateInfo', (local && local.date || '') + ' 已是最新版本，可以用右侧按钮进一步检查文件变化', false);
        } else {
            return fire('SetUpdateInfo', '发现新版本 ' + (release.date || ''), true);
        }
    }
}

// ------------------------------------------------------------------------------------------
// -- 定时检查app版本更新, 检查完毕后，每5分钟检查一次，检查失败每2分钟检查一次
// ------------------------------------------------------------------------------------------
const {getGitRawUrl} = require('./utils');
let gitHack = (gitUser, gitRepo, gitHash) => (file, retry) => {
    if (retry < 2) {
        return getGitRawUrl('gitlab', true, gitUser, gitRepo, gitHash, file); //官方稳定，但不能续传
    } else if (retry < 4) {
        return getGitRawUrl('bitbucket', true, gitUser, gitRepo, gitHash, file); //hack不限量，能续传
    } else if (retry < 5) {
        return getGitRawUrl('github', true, gitUser, gitRepo, gitHash, file); //hack不限量，不能续传
    } else {
        return undefined;
    }
};

let releaseJsonUrl = (file, retry) => {
    if (retry < 2) {
        return getGitRawUrl('gitlab', false, GIT_USER, 'repo-release', 'master', file); //官方稳定，但不能续传
    } else if (retry < 4) {
        return getGitRawUrl('bitbucket', false, GIT_USER, 'repo-release', 'master', file); //官方稳定，有限量
    } else if (retry < 6) {
        return getGitRawUrl('github', false, GIT_USER, 'repo-release', 'master', file); //官方慢
    } else {
        return undefined;
    }
};

let checkUpdateAsar
(() => {
    const PROMPT_INTERVAL = 10 * 60 * 1000; //提醒间隔
    const CHECK_INTERVAL = 5 * 60 * 1000;
    const RETRY_INTERVAL = 3 * 60 * 1000;

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
            exitApp(0);
        }
    }

    checkUpdateAsar = async function () {

        if (status.DOWNLOADING) {
            return setTimeout(checkUpdateAsar, CHECK_INTERVAL)
        }

        const {downloadRetry} = require('./utils');

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
        downloadRetry('abyui-release.json', releaseRemote + ".downloading", releaseJsonUrl)
            .then(() => fs.remove(releaseRemote))
            .then(() => fs.rename(releaseRemote + ".downloading", releaseRemote))
            .then(() => updateReleaseData()) //下载后就可以检查插件版本
            .then((remote) => {
                if (debugging) return;
                // 如果当前electron比远程要求的electron版本要低，则不更新，提示错误
                if (compare(verElec, remote.client.electron) < 0) {
                    dialog.showMessageBox(mainWindow, {
                        title: "警告", type: 'warning',
                        message: "发现更新器新版本，但当前版本过低，无法自动更新，请手工去论坛或网盘下载新版更新器，抱歉啦",
                    });
                    exitApp(-1);
                    throw new Error('electron version too low');
                }

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
    if (wowPath && wowPath.trim().length > 0) {
        return fs.existsSync(path.join(wowPath, wowExecutable));
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

    if (manual) {
        while (true) {
            let chosen = dialog.showOpenDialog(mainWindow, {
                title: '选择魔兽执行文件',
                properties: ['openFile', 'openDirectory'],
                defaultPath: wowPath,
                filters: process.platform === 'win32' ? [{name: 'Wow', extensions: ['exe']}] : [{name: 'World of Warcraft', extensions: ['app']}]
            })
            if (!chosen) break;
            let dir = fs.statSync(chosen[0]).isDirectory() ? chosen[0] : path.dirname(chosen[0]);
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
    } else {
        //读取注册表
        if(!wowPath && isWin32) {
            try {
                let buf = childProc.execSync('reg QUERY "HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\Blizzard Entertainment\\World of Warcraft" /v InstallPath');
                let match = buf && buf.toString().match(/.*InstallPath[ \t]+REG_SZ[ \t]+(.*)/);
                wowPath = match && match[1];
                if(wowPath) console.log('find wowPath from registry', wowPath);
                if (_isWowPathVaid(wowPath)) {
                    localData.currWowPath = wowPath;
                    saveLocalData();
                    checkUpdateAddOn();
                }
            } catch (e) {}
        }
    }

    if (!_isWowPathVaid(wowPath)) wowPath = undefined;

    if (wowPath) {
        fire('GetWowPathDone', wowPath);
        return path.resolve(path.join(wowPath, 'Interface/AddOns'));
    }
}

let downloadRepo, lastCheckResult; //lastCheckResult是为了check之后马上更新的话不需要重新计算
(function () {

    const {downloadRetry, downloadList} = require('./utils');
    const futil = require('./utils');

    downloadRepo = async function (repo, hash, addOnDir, checkOnly, callback) {
        console.log('======================= downloading repo', repo, hash);

        //下载成功然后改名
        let savePath = getRes(`data/filelist-${repo}-${hash}.gz`);
        await fs.ensureDir(addOnDir);

        let remote, local, result;
        //使用10秒以内的结果
        if (!lastCheckResult || Date.now() - lastCheckResult.time > (debugging ? 0 : 10 * 1000)) {
            fire('RepoChecking');
            if (!await fs.pathExists(savePath)) {
                let bytes = 0;
                try {
                    await downloadRetry('.filelist.php', savePath + '.tmp', gitHack(GIT_USER, repo, hash), delta => console.log('downloaded', bytes += delta));
                    console.log('list file downloaded');
                    await fs.rename(savePath + '.tmp', savePath);
                } catch (e) {
                    return console.error('无法获取插件变更信息', e);
                }
            } else {
                console.log('use former downloaded');
            }

            remote = futil.readJsonGZ(savePath);
            local = await futil.buildFileList(addOnDir, [], false, true, count => fire('RepoChecking', count));
            result = await futil.calcDiff(remote, local, addOnDir, (count, total) => fire('RepoChecking', count, total)); //如果不传入addOnDir则只比较size，不计算md5
            lastCheckResult = {remote: remote, result: result, time: Date.now()}
        } else {
            remote = lastCheckResult.remote;
            result = lastCheckResult.result;
        }

        //先删除文件
        for (const file of result.deleted) {
            await fs.remove(path.join(addOnDir, file))
        }

        let downloads = result.modified.concat(result.added);
        let downloadsCount = downloads.length;
        let downloadsBytes = result.bytes.modified + result.bytes.added;
        let totalBytes = result.bytes.total;
        console.log("FILE need to download:", downloadsCount, ', BYTES:', downloadsBytes + ' / ' + totalBytes);
        if (callback) callback('RepoChecked', downloadsCount, downloadsBytes);
        if (downloadsCount === 0 || checkOnly) return;

        if (callback) callback('RepoBeginDownloading');
        let before = process.uptime() * 1000;
        let bytesDownloaded = 0;
        let fileSuccess = 0, fileFail = 0;
        let lastSendTime = 0; // 防止CPU过高
        let onDataDelta = (delta) => {
            bytesDownloaded += delta;
            if (callback && Date.now() >= lastSendTime + 1000) {
                lastSendTime = Date.now();
                callback('RepoDownloading', bytesDownloaded, downloadsBytes, fileSuccess, fileFail, downloadsCount);
            }
        };
        let onFileFinish = (file, success, finished, total) => {
            if (success) fileSuccess++; else fileFail++;
            console.log(finished + ' / ' + total, '    ', bytesDownloaded + ' / ' + downloadsBytes);
            if (callback) callback('RepoDownloading', bytesDownloaded, downloadsBytes, fileSuccess, fileFail, downloadsCount);
        };
        await downloadList(downloads, addOnDir, gitHack(GIT_USER, repo, hash), onDataDelta, onFileFinish);

        console.log("downloaded", bytesDownloaded, ', time:', process.uptime() * 1000 - before);

        local = await futil.buildFileList(addOnDir, [], false, true);
        result = await futil.calcDiff(remote, local); //仅比较文件尺寸即可
        let remained = result.modified.length + result.added.length;
        let success = remained === 0;
        console.log(success ? '更新成功' : '更新不完全');
        if (success) {
            let reposJson = path.join(addOnDir, ADDON_DIR_JSON);
            let json = fs.existsSync(reposJson) ? fs.readJsonSync(reposJson) : {};
            json.repos = json.repos || {};
            json.repos[repo] = releaseData.repos[repo];
            fs.writeJsonSync(reposJson, json);

            localData.repos = localData.repos || {};
            localData.repos[repo] = releaseData.repos[repo];
            saveLocalData();
        }
        lastCheckResult = undefined;
        if (callback) callback('RepoDownloaded', bytesDownloaded, downloadsBytes, fileSuccess, fileFail, downloadsCount);
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
        closable: true,
        title: `爱不易 warbaby's ABY-UI v${app.getVersion()}`,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            preload: __dirname + '/renderer/preload.js'
        }
    });

    // Open the DevTools.
    if (debugging) mainWindow.webContents.openDevTools({mode: "bottom"});

    mainWindow.webContents.on('before-input-event', function (event, input) {
        if (!mainWindow || !mainWindow.webContents) return;
        if (input.type === 'keyUp' && input.key === 'F12' && input.control) {
            if (mainWindow.webContents.isDevToolsOpened()) {
                mainWindow.webContents.closeDevTools();
            } else {
                mainWindow.webContents.openDevTools({mode: "bottom"});
            }
        }
    });

    mainWindow.webContents.on('destroyed', function () {
        if (mainWindow) mainWindow.webContents = null;
    })

    let handleRedirect = (e, url) => {
        if (url !== mainWindow.webContents.getURL()) {
            e.preventDefault()
            require('electron').shell.openExternal(url)
        }
    }

    mainWindow.webContents.on('will-navigate', handleRedirect)
    mainWindow.webContents.on('new-window', handleRedirect)

    mainWindow.webContents.on('did-finish-load', function () {
        if (mainWindow) {
            // mainWindow.setProgressBar(0);

            let bullet = getRes('data/bulletin.html');
            if (fs.existsSync(bullet)) {
                fire('UpdateBulletin', fs.readFileSync(bullet).toString());
            }
            const {downloadRetry} = require('./utils');
            let updateBullet = function () {
                downloadRetry('bulletin.html', bullet + ".downloading", releaseJsonUrl)
                    .then(() => fs.remove(bullet))
                    .then(() => fs.rename(bullet + ".downloading", bullet))
                    .then(() => fire('UpdateBulletin', fs.readFileSync(bullet).toString()))
                    .catch(console.error);
            };
            setInterval(updateBullet, 5 * 60 * 1000);
            setTimeout(updateBullet, 100);
        }
    });

    // and load the index.html of the app.
    mainWindow.loadFile('renderer/index.html');

    // 窗口关闭时触发，通过preventDefault可以阻止
    mainWindow.on('close', (e) => {
        // Dereference the window object, usually you would store windows
        // in an array if your app supports multi windows, this is the time
        // when you should delete the corresponding element.
        // 仅仅隐藏窗口，阻止默认事件执行close()
        mainWindow = null;
        // mainWindow.hide();
        // if (!debugging) e.preventDefault(); else mainWindow = null; //正常应该是设置为null, 当全部窗口都关闭时，程序退出
        // console.log('on close prevent');
    })

    if (process.platform === 'win32') {
        let trayIcon = path.join(__dirname, 'tray_icon.png');
        tray = new Tray(trayIcon)
        const contextMenu = Menu.buildFromTemplate([
            {label: '爱不易插件', sublabel: 'aby-ui'},
            {type: 'separator'},
            {
                label: '重启', type: 'normal', click: () => {
                    app.relaunch();
                    exitApp(0);
                }
            },
            {
                label: '退出', type: 'normal', click: () => {
                    exitApp(0)
                }
            }
        ])
        tray.setToolTip('爱不易插件更新器')
        tray.setContextMenu(contextMenu)
        tray.on('click', () => mainWindow.show());
    }
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
if (isSecondInstance) exitApp(-1)

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
function onAppReady() {
    if (isSecondInstance) return;
    //testElectron();

    setTimeout(checkUpdateAsar, 1000);
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
        mainWindow.webContents.once('did-finish-load', () => {
            updateReleaseData();
            if (status.DOWNLOADING) {
                fire('RepoBeginDownloading');
            }
        });
    }
});

app.on('browser-window-created', function (e, window) {
    window.setMenu(null);
});

// ------------------------------------------------------------------------------------------
// -- 界面事件
// ------------------------------------------------------------------------------------------
function EventMain(event, method, arg1) {
    console.log(method, arg1);
    switch (method) {
        case 'GetWowPath':
            getAddOnDir(true);
            break;
        case 'OpenWowPath': {
            let addOnDir = getAddOnDir();
            fs.ensureDirSync(addOnDir);
            shell.openExternal('file://' + addOnDir);
            break;
        }
        case 'RunWow' : {
            let addOnDir = getAddOnDir();
            if (addOnDir) {
                shell.openExternal('file://' + path.join(addOnDir, '..', '..', wowExecutable));
            } else {
                dialog.showMessageBox(mainWindow, {title: 'aby-ui-client', type: 'warning', message: `目录下没有${wowExecutable}`});
            }
            break;
        }
        case 'UpdateAddOn': {
            let addOnDir = getAddOnDir();
            let repo = releaseData && releaseData.repos['repo-base'];
            if (addOnDir && repo && repo.hash) {
                status.DOWNLOADING = true
                downloadRepo('repo-base', repo.hash, addOnDir, false, fire)
                    .then(() => {
                            //删除列表里我们的插件
                            for (let one of (releaseData["removed-addons"] || [])) {
                                const tocFile = path.join(addOnDir, one, one + '.toc');
                                if (fs.existsSync(tocFile)) {
                                    let content = fs.readFileSync(tocFile).toString();
                                    let isOurs = content.indexOf('\n## X-Vendor: AbyUI') >= 0
                                        || content.indexOf('\n## X-Vendor: NetEase') >= 0
                                        || content.indexOf('\n## X-163UI-Version:') >= 0;
                                    console.log('see if should remove', one, isOurs);
                                    if (isOurs) {
                                        const backupDir = path.join(addOnDir, '..', 'AddOns爱不易备份');
                                        fs.ensureDirSync(backupDir)
                                        const target = path.join(backupDir, one);
                                        if (fs.existsSync(target)) fs.removeSync(target);
                                        fs.moveSync(path.join(addOnDir, one), target)
                                        //fs.removeSync(path.join(addOnDir, one));
                                    }
                                }
                            }
                        }
                    )
                    .then(() => status.DOWNLOADING = false)
                    .catch(() => status.DOWNLOADING = false);
            }
            break;
        }
        case 'CheckAddOnDetail': {
            checkUpdateAsar().then(() => {
                let addOnDir = getAddOnDir();
                let repo = releaseData && releaseData.repos['repo-base'];
                if (addOnDir && repo && repo.hash) {
                    status.DOWNLOADING = true
                    downloadRepo('repo-base', repo.hash, addOnDir, true, fire)
                        .then(() => status.DOWNLOADING = false)
                        .catch(() => status.DOWNLOADING = false);
                }
            })
            break;
        }
    }
    event.returnValue = null;
}

ipcMain.on('ABYUI_MAIN', function () {
    EventMain(...arguments);
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
    if (true) exitApp(0);
}