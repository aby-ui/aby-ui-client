window.eval = global.eval = function () {
    throw new Error(`Sorry, this app does not support window.eval().`)
}

console.log('preload done');