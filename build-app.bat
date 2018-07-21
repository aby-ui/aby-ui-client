pushd app
zip -r ../_apptmp.zip * -x node_modules/*
popd
unzip _apptmp.zip -d _apptmp
pushd _apptmp
call npm i --product
popd
mkdir _build
call asar p _apptmp _build\app.asar
gzip -f _build\app.asar
rm -fr _apptmp
rm _apptmp.zip