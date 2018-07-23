mklink /J electron-dist electron-package\node_modules\electron\dist

call asar e electron-dist\resources\electron.asar __tmp
copy electron-hack\browser\init.js __tmp\browser
ren electron-dist\resources\electron.asar electron.asar.origin
call asar p __tmp electron-dist\resources\electron.asar
rm -fr __tmp