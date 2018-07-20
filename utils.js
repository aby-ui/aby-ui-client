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
                return reject({error: err, reason: 'fstat-error', info: err.code})

            let start = (stat && stat.size && !options.noResume) ? stat.size : 0

            // 已下载的字节数，包括断点续传的，下载失败后要回退
            let downloaded = 0;
            let rejectRevertDownloaded = (data) => {
                typeof progress === 'function' && progress(-1, -1, -downloaded);
                downloaded = 0; //嵌套的错误可能减去多次
                return reject(data);
            }

            const req = require(parsedUrl.protocol.slice(0, -1)).request(Object.assign({
                                                                                           method: options.method || 'GET',
                                                                                           headers: Object.assign({Range: 'bytes=' + start + '-'}, options.headers)
                                                                                       }, parsedUrl), res => {
                options.onresponse && options.onresponse(res)

                //if (res.statusCode === 416 && res.headers['content-range'] && res.headers['content-range'].slice(-2) !== '/0')
                //    return fs.unlink(dest, () => resolve(download(url, dest, options)))

                if (res.statusCode >= 400)
                    return reject({
                                      error: new Error('Response:' + res.statusCode),
                                      reason: 'response-code',
                                      info: res.statusCode
                                  })

                if (res.headers.location)
                    return reject({
                                      error: new Error('Redirect:' + res.statusCode + ', ' + res.headers.location),
                                      reason: 'response-redirect',
                                      info: res.statusCode
                                  })

                if (!res.headers['content-range'])
                    start = 0

                const file = fs.createWriteStream(dest, {
                    flags: start ? 'r+' : 'w',
                    start
                })

                file.on('error', e => {
                    rejectRevertDownloaded({error: e, reason: 'stream-error'})
                    req.abort()
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
                file.on('finish', () =>
                        res.complete
                                ? resolve(url)
                                : rejectRevertDownloaded({
                                                             error: new Error('IncompleteResponse'),
                                                             reason: 'response-incomplete'
                                                         })
                )
            })

            options.onrequest && options.onrequest(req)

            req.on('error', e => rejectRevertDownloaded({error: e, reason: 'request-error'}))
            req.on('timeout', () => (req.abort(), rejectRevertDownloaded({
                                                                             error: new Error('RequestTimeout'),
                                                                             reason: 'request-timeout'
                                                                         })))
            req.on('abort', () => rejectRevertDownloaded({error: new Error('RequestAborted'), reason: 'request-abort'}))
            req.setTimeout((options.timeout || 30) * 1000)
            req.end()
        })
    })
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
                                                   if (i > 0) console.log(i === 0 ? 'download' : 'retry', fileOrUrl, i);
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
            return `https://${githack ? 'glcdn.githack.com' : 'gitlab.com'}/${gitUser}/${gitRepo}/raw/${gitHash}/${encodeURI(file)}`;
        case 'github':
            return `https://${githack ? 'rawcdn.githack.com' : 'raw.githubusercontent.com'}/${gitUser}/${gitRepo}/${gitHash}/${encodeURI(file)}`;
        default:
            return undefined;
    }
};

module.exports = {
    download: download,
    downloadRetry: downloadRetry,
    downloadList: downloadList,
    getGitRawUrl: getGitRawUrl
};