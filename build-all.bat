set ELECTRON_MIRROR=https://npm.taobao.org/mirrors/electron/
call electron-packager .\app AbyUI --executable-name=爱不易插件 --platform=win32 --arch=x64 --app-version 1.0.0 --icon 163UI-light.ico --asar --out=_package --overwrite

call electron-packager .\app AbyUI --executable-name=爱不易插件 --platform=darwin --arch=x64 --app-version 1.0.0 --icon logo.icns --asar --out=_package --overwrite

call build-app.bat
call build-lib.bat
call build-electron-hack.bat