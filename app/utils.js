'use strict'

const fs = require('fs-extra'),
    path = require('path'),
    URL = require('url')

/**
 * @param url
 * @param dest
 * @param options object { noResume: true, timeout: 30, onresponse: function(res), onrequest: function(req) }
 * @return {Promise<any>} {error, reason, code}
 */
function download(url, dest, options) {
    options = options || {}
    const progress = options.progress || options
        , parsedUrl = URL.parse(url)

    return new Promise((resolve, reject) => {
            fs.stat(dest, (err, stat) => {
                if (err && err.code !== 'ENOENT')
                    return reject({error: err, reason: 'fstat-error', info: err.code, url: url})

                let start = (stat && stat.size && !options.noResume) ? stat.size : 0

                // 已下载的字节数，包括断点续传的，下载失败后要回退
                let downloaded = 0;
                let rejectRevertDownloaded = (data) => {
                    typeof progress === 'function' && progress(-1, -1, -downloaded);
                    downloaded = 0; //嵌套的错误可能减去多次
                    return reject(data);
                }

                const req = net.request(Object.assign({
                    method: options.method || 'GET',
                    headers: Object.assign({Range: 'bytes=' + start + '-'}, options.headers),
                    redirect: 'error' //TODO: agent
                }, parsedUrl), res => {
                    options.onresponse && options.onresponse(res)

                    if (res.statusCode === 416) {  //&& res.headers['content-range'] && res.headers['content-range'].slice(-2) !== '/0')
                        return fs.unlink(dest, () => resolve(download(url, dest, options)))
                    }

                    if (res.statusCode >= 400) {
                        return reject({
                            error: new Error('Response:' + res.statusCode),
                            reason: 'response-code',
                            info: res.statusCode,
                            url: url
                        })
                    }

                    if (res.headers.location) {
                        return reject({
                            error: new Error('Redirect:' + res.statusCode + ', ' + res.headers.location),
                            reason: 'response-redirect',
                            info: res.statusCode,
                            url: url
                        })
                    }

                    if (!res.headers['content-range'])
                        start = 0

                    const file = fs.createWriteStream(dest, {
                        flags: start ? 'r+' : 'w',
                        start
                    })

                    file.on('error', e => {
                        req.abort()
                        rejectRevertDownloaded({error: e, reason: 'stream-error', url: url})
                    })

                    const length = parseInt(res.headers['content-length'], 10) || 0;

                    downloaded = start
                    typeof progress === 'function' && progress(downloaded, (length + start), downloaded);

                    res.on('data', chunk => {
                        downloaded += chunk.length
                        //if(downloaded > 30000 && url.indexOf('glcdn') < 0) req.abort();
                        typeof progress === 'function' && progress(downloaded, (length + start), chunk.length);
                        file.write(chunk)
                    })

                    res.on('end', () => file.end())
                    file.on('finish', () => resolve(url));
                })

                options.onrequest && options.onrequest(req)

                req.on('error', e => rejectRevertDownloaded({error: e, reason: 'request-error', url: url}))
                req.on('timeout', () => {
                    req.abort();
                    rejectRevertDownloaded({error: new Error('RequestTimeout'), reason: 'request-timeout', url: url});
                })
                req.on('abort', () => rejectRevertDownloaded({
                    error: new Error('RequestAborted'),
                    reason: 'request-abort',
                    url: url
                }))
                // req.setTimeout((options.timeout || 30) * 1000)
                req.end()
            })
        }
    )
}

/**
 * A: 下载一个文件，如果失败则重试若干次，每次都可以更换地址. downloadRetry(file, dest, mapFunc, progress)
 * B: 下载一个url，最多重试N次. downloadRetry(url, dest, retry, progress)
 * @param fileOrUrl 要下载的文件名, 或者直接url
 * @param dest 文件保存的完整路径，包括文件名
 * @param mapOrRetry 文件与url的映射关系
 * @param onprogress 回调函数 onprogress(downloaded, total, delta)
 * @return {Promise<any>} @see download() 成功返回url, 失败则返回{error: reason: info:}
 */
function downloadRetry(fileOrUrl, dest, mapOrRetry, onprogress) {
    return new Promise((resolve) => {
            fs.ensureDir(path.dirname(dest))
                .then(() => {
                    let p = Promise.reject('start');
                    for (let i = 0; true; i++) {
                        let url;
                        if (typeof mapOrRetry === 'function') {
                            url = mapOrRetry(fileOrUrl, i);
                        } else {
                            url = i < mapOrRetry ? fileOrUrl : undefined;
                        }
                        if (!url) break;
                        p = p.catch((e) => {
                            //如果是磁盘问题则不重试，其实都重试也没什么问题
                            if (e.reason !== 'fstat-error' && e.reason !== 'stream-error') {
                                //每次重试时使用不同的url，第一次不尝试断点续传
                                if (i > 0) console.error(e.error);
                                console.log(i === 0 ? 'download' : 'retry', fileOrUrl, i, url);
                                return download(url, dest, {noResume: i === 0, timeout: 10, progress: onprogress});
                            }
                        })
                    }
                    resolve(p);
                });
        }
    )
}

/**
 * 下载一组文件，保存到某个目录里
 * @param files 文件列表
 * @param saveDir 要保存的目录
 * @param fileToUrlFunc 文件名到下载地址的映射，可以控制重试次数和每次尝试不同的链接
 * @param onDataDelta function(delta) {} 下载到文件内容后触发，当下载失败的时候，delta会回退已下载的大小
 * @param onFileFinish function(file, success, finished, total) 完成一个文件后触发，包括成功和失败
 * @return {Promise<*>}
 */
function downloadList(files, saveDir, fileToUrlFunc, onDataDelta, onFileFinish) {

    //下载一组文件时，方法内部是不知道总大小的，只能告知变化量
    let onprogress = function (downloaded, total, delta) {
        onDataDelta && onDataDelta(delta);
    };

    //pool 用的 producer，下载成功返回[file, true]失败则返回[file, false]，可以在fulfilled事件里统一处理
    let producer = function () {
        let file = files.shift();
        if (!file) return null;
        let dest = path.join(saveDir, file);
        return downloadRetry(file, dest, fileToUrlFunc, onprogress)
            .then(() => [file, true])
            .catch((e) => {
                console.error(`cannot download ${file}`, e.error);
                return [file, false]
            });
    };

    const PromisePool = require('es6-promise-pool');
    let total = files.length, finished = 0;
    let pool = new PromisePool(producer, 10);

    pool.addEventListener('fulfilled', function (event) {
        let result = event.data.result;
        finished++;
        //console.log('fulfilled', files.length, result);
        onFileFinish && onFileFinish(result[0], result[1], finished, total);
    });

    return new Promise(resolve => {
        resolve(pool.start());
    })
}

let getGitRawUrl = (server, githack, gitUser, gitRepo, gitHash, file) => {
    switch (server) {
        case 'bitbucket':
            return `https://${githack ? 'bbcdn.githack.com' : 'bitbucket.org'}/${gitUser}/${gitRepo}/raw/${gitHash}/${encodeURI(file)}`;
        case 'gitlab':
            return `https://${githack ? 'glcdn.githack.com' : 'gitlab.com'}/${gitUser + '2'}/${gitRepo}/raw/${gitHash}/${encodeURI(file)}`;
        case 'github':
            return `https://${githack ? 'rawcdn.githack.com' : 'raw.githubusercontent.com'}/${gitUser}/${gitRepo}/${gitHash}/${encodeURI(file)}`;
        default:
            return undefined;
    }
};

// ------------------------------------------------------------------------------------------
// -- fileUtils
// ------------------------------------------------------------------------------------------
const zlib = require('zlib');
const klaw = require('klaw');
const md5File = require('md5-file/promise');
const {net} = require('electron');

// 获取md5的前4个字节
let getPartialMD5 = function (rightMD5) {
    return parseInt(rightMD5.substr(0, 8), 16);
};

// 标准化路径，用于对比
let normalizePath = function (onepath) {
    let s = path.normalize(onepath).toLowerCase();
    if (s.slice(-1) === path.sep) s = s.slice(0, -1);
    return s;
};

/**
 * 生成根目录的文件列表，结构为 { 'dir' : { 'file' : [ size, md5_int ], ... }, ... }
 * @param base 要列表的目录位置
 * @param ignored 忽略的路径，可以是文件也可以是目录
 * @param calcMd5 是否计算文件md5
 * @param listEmptyDir 是否列出空目录，例如 'dir' : {}
 */
function buildFileList(base, ignored, calcMd5, listEmptyDir, callback) {

    let deep = function (relative, isFile) {
        if (relative === '.') return root;
        if (pathMap[relative]) return pathMap[relative];
        // if (ignored.indexOf(normalizePath(relative)) >= 0) return null; //已经在klaw里处理过了，这一步可以去掉
        let parent = deep(path.dirname(relative)); //先创建父目录
        // if (parent === null) return null;
        if (isFile) return parent;
        let dir = {};
        parent[path.basename(relative)] = dir; //父目录.目录名 = this
        pathMap[relative] = dir; //map[完整路径] = this
        return dir;
    };

    let root = {}, pathMap = {}; //记录已经用过的目录对象
    ignored = (ignored || []).map(normalizePath);

    let klawFilter = item => {
        if (path.basename(item.path)[0] === '.') return false; //以.开头的文件及目录
        if (ignored.indexOf(normalizePath(path.relative(base, item.path))) >= 0) return false; //配置文件里ignored
        if (item.stats.isFile() && item.stats.size === 0) return false;
        //TODO: 只保留lua, toc, xml, tga, blp, ogg, mp3, m2, ttf, 但用压缩包下载的可能会下到
        return true;
    };

    let count = 0;
    return new Promise(resolve => {
        let promises = [];
        klaw(base, {nodir: false})
            .on('data', item => {
                if (!klawFilter(item)) {
                    return;
                }
                promises.push(new Promise((resolve2, reject2) => {
                    let p = item.path;
                    let relative = path.relative(base, p);
                    if (item.stats.isDirectory()) {
                        //目录靠目录里的文件来体现，如果目录里没有文件，则不会出现在文件列表里,除非指定listEmptyDir
                        if (listEmptyDir) deep(relative);
                        return resolve2();
                    }
                    let parent = deep(relative, true);
                    if (parent !== null) {
                        if (calcMd5) {
                            return md5File(item.path).then(md5 => {
                                parent[path.basename(item.path)] = [item.stats.size, getPartialMD5(md5)]
                                resolve2();
                            });
                        } else {
                            parent[path.basename(item.path)] = [item.stats.size, 0]
                            return resolve2();
                        }
                    }
                    return resolve2();
                }).then(() => callback && callback(++count)));
            })
            .on('end', () => {
                Promise.all(promises).then(() => resolve(root))
            });

        return root;
    })

}

function writeJsonGZ(path, object) {
    fs.writeFileSync(path, zlib.gzipSync(JSON.stringify(object), {level: zlib.constants.Z_BEST_COMPRESSION}));
}

function readJsonGZ(path) {
    //require('zlib').gunzipSync(require('fs').readFileSync('C:/code/lua/163ui.beta/repos/atlasloot/.filelist.gz')).toString()
    let buf = fs.readFileSync(path);
    let unzipped = zlib.gunzipSync(buf);
    return JSON.parse(unzipped.toString());
}

let flatTree = function (dir, pathArray, result) {
    Object.entries(dir).forEach(f => {
        let name = f[0], data = f[1];
        let isFile = Array.isArray(data); //目录是 {}， 文件是 [size, md5]
        pathArray.push(name);
        result[normalizePath(path.join(...pathArray))] = {
            path: pathArray.join('/'),
            size: isFile ? data[0] : -1,
            md5: isFile ? data[1] : undefined
        };
        if (!isFile) {
            flatTree(data, pathArray, result)
        }
        pathArray.pop();
    });
    return result;
};

/**
 * 比较两个filelist对象，只返回新增的和变化的，
 * @param remote 下载的filelist.json里的数据，固定包含md5
 * @param localPathForMD5 本地插件目录，因为可能需要按需md5，如果此参数不提供，则只要size相同就认为相同
 * @param local 本地插件目录生成的filelist，可以不包含md5，但是需要包含空目录，防止目录名和文件名冲突
 * @return {modified: Array, deleted: Array, added: Array, bytes: {total: any, added: (*), modified: (*)}} 其中deleted可能存在目录及目录中的文件，真实删除时可能已经被删除掉了
 */
async function calcDiff(remote, local, localPathForMD5, callback) {
    if (!local) local = await buildFileList(localPathForMD5, [], false, true);
    let rootActual = local.files ? local.files : local;
    let rootExpect = remote.files ? remote.files : remote;

    let expectMap = flatTree(rootExpect, [], {});
    let actualMap = flatTree(rootActual, [], {});

    let total = Object.keys(expectMap).length;
    let count = 0;

    let modified = [], deleted = [], added = [];
    for (let e of Object.entries(expectMap)) {
        let name = e[0], expect = e[1];
        let actual = actualMap[name];
        let isDir = expect.size === -1;
        if (!actual) {
            if (!isDir) added.push(expect.path);
        } else if (expect.size !== actual.size) {
            //尺寸不同
            if (!isDir) modified.push(expect.path);
            //根据需要先删除原文件
            if ((isDir && actual.size !== -1) || (!isDir && actual.size === -1)) {
                //一方为目录，另一方为文件
                deleted.push(actual.path);
            } else if (expect.path !== actual.path) {
                //文件大小写不一致
                deleted.push(actual.path);
            }
        } else {
            //都是目录或者尺寸相同
            if (expect.path !== actual.path) {
                //文件大小写不一致
                deleted.push(actual.path);
                if (!isDir) modified.push(expect.path);
            } else if (isDir) {
                //同名目录不做处理
            } else if (localPathForMD5) {
                let actualMD5 = actual.md5 || getPartialMD5(await md5File(path.join(localPathForMD5, actual.path)));
                if (actualMD5 !== expect.md5) {
                    modified.push(expect.path);
                }
            }
        }
        if (callback) callback(++count, total)
    }
    let totalBytes = Object.values(expectMap).reduce((pre, obj) => pre + obj.size, 0);
    let addedBytes = added.reduce((pre, added) => pre + expectMap[normalizePath(added)].size, 0);
    let modifiedBytes = modified.reduce((pre, modified) => pre + expectMap[normalizePath(modified)].size, 0);
    if (callback) callback(total, total)
    return {
        modified: modified,
        deleted: deleted,
        added: added,
        bytes: {
            total: totalBytes,
            added: addedBytes,
            modified: modifiedBytes
        }
    };
}

module.exports = {
    download: download,
    downloadRetry: downloadRetry,
    downloadList: downloadList,
    getGitRawUrl: getGitRawUrl,

    buildFileList: buildFileList,
    writeJsonGZ: writeJsonGZ,
    readJsonGZ: readJsonGZ,
    calcDiff: calcDiff
};