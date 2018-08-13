pushd app
zip -r ../_apptmp.zip * -x node_modules/*
popd
unzip _apptmp.zip -d _apptmp
pushd _apptmp

@rem npm install -g uglifyes asar
@rem call uglifyjs -m -c -o main.js main.js
@rem call uglifyjs -m -c -o utils.js utils.js

call npm i --product
popd
mkdir _build
call asar p _apptmp _build\app.asar

copy _build\app.asar _package\AbyUI-win32-ia32\resources

gzip -f _build\app.asar
rm -fr _apptmp
rm _apptmp.zip