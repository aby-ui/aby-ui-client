# 爱不易插件更新器
项目基于 https://github.com/electron/electron-quick-start

## 安装
```bash
git clone https://github.com/aby-ui/aby-ui-client
cd aby-ui-client
# app目录是主程序

cd app
# npm intall 的时候需要下载electron, 国内指定一下镜像
set ELECTRON_MIRROR=https://npm.taobao.org/mirrors/electron/
npm install --registry=https://registry.npm.taobao.org

# 启动electron
npm start
```

## 发布
```bash
# 安装electron打包工具
npm -g i electron-packager

# 打包到_package/AbyUI-win32-ia32目录中
# 基本就是把electron的发行包改一下exe版本和图标而已
electron-packager ./app AbyUI --executable-name=爱不易插件 --platform=win32 --arch=ia32 --icon 163UI-light.ico --asar --out=_package --overwrite

# 用product模式安装app，打包到resources/app.asar里
build-app.bat

# 用product模式安装app-lib，打包到resources/app-lib.asar里
build-lib.bat

# 修改 resources/electron.asar
build-electron-hack.bat
```

## 更新器自身更新逻辑
1. 打包时，根据package.json里的version，发布到 https://github.com/aby-ui/repo-release/blob/master/abyui-release.json 里
2. 定时检查读取 https://github.com/aby-ui/repo-release/blob/master/abyui-release.json 如果发现版本大于当前app版本，则下载 app.asar.gz，解压为app-updated.asar，提示重启。
3. 重启时，修改的electron.asar会自动将app-updated.asar改为app.asar，完成升级
4. 定时读取 https://github.com/aby-ui/repo-release/blob/master/bulletin.html 将html片段嵌入更新器的主页面

## 插件更新逻辑
1. 插件代码提交后，将commit-hash存到上面的abyui-release.json里
2. 发布时用脚本遍历插件目录，计算每个文件的md5，发布到repo-base/filelist.json里
3. 定时检测，如果发现hash和当前魔兽目录下保存的abyui-repos.json不同，则提示插件更新
4. 用户点击更新或检查时，读取filelist.json.gz (filelist.php)，与本地文件对比，下载需要更新的文件
5. （单文件更新效率有点差，需要更先进一点的机制。最初设计的时候是不同插件在不同的repos里，这样可以利用git的打包下载机制）

## 遗留问题
- 打包脚本都是bat的，抽空改成node的
- 插件目录生成filelist.json的脚本在另一个项目里，正准备合过来
- 代码毫无结构可言，本来是想弄到一个文件里直接uglify一下，所以没拆分
- 基本不会写前端代码，请勿吐槽

## License

[CC0 1.0 (Public Domain)](LICENSE.md)
