pushd app-lib
rm -fr node_modules
call npm i --product --no-package-lock
popd
mkdir _build
call asar p app-lib _build\lib.asar

copy _build\lib.asar _package\AbyUI-win32-ia32\resources

gzip -f _build\lib.asar
::²»ÉúĞ§°¡ --unpack *.{bat,asar} && ls app-lib.asar.unpacked