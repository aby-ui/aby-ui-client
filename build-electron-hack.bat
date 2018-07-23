::mklink /J electron-dist electron-package\node_modules\electron\dist
::call asar e electron-dist\resources\electron.asar __tmp
::copy electron-hack\browser\init.js __tmp\browser
::ren electron-dist\resources\electron.asar electron.asar.origin
::call asar p __tmp electron-dist\resources\electron.asar
::rm -fr __tmp


set FILE=_package\AbyUI-win32-x64\resources\electron.asar
call asar e %FILE% __tmp
copy electron-hack\browser\init.js __tmp\browser
rm %FILE%
call asar p __tmp %FILE%
rm -fr __tmp
cp electron-dist\resources\electron.asar _build