pushd app-lib
rm -fr node_modules
call npm i --product
popd
asar p app-lib _build\app-lib.asar 
::����Ч�� --unpack *.{bat,asar} && ls app-lib.asar.unpacked