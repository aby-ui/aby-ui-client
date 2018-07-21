mklink /J electron-dist electron-package\node_modules\electron\dist

call asar e electron-dist\resources\electron.asar $tmp
copy electron-hack\browser\init.js $tmp\browser
ren electron-dist\resources\electron.asar electron.asar.origin
call asar p $tmp electron-dist\resources\electron.asar
rm -fr $tmp