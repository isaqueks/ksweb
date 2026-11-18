#!/usr/bin/env node
/*
 * mksingle.js — gera ksweb-single.html: a página inteira num arquivo só,
 * que abre com clique duplo (file://), sem fetch nem worker externo.
 *
 *   node tools/mksingle.js DIST_DIR SAIDA.html
 *
 * - style.css e todos os <script src> de index.html entram inline;
 * - ksvm.wasm vira base64 em window.KSWEB_WASM_B64 (ksweb.js usa no lugar
 *   do fetch); os exemplos já estão em examples.js (base64);
 * - vmcore.js + format.js + worker.js vão num
 *   <script type="text/js-worker" id="ksweb-worker-src">, que ksweb.js
 *   transforma em Blob para o new Worker().
 */
'use strict';
const fs = require('fs');
const path = require('path');

const [dist, outPath] = process.argv.slice(2);
const read = (f) => fs.readFileSync(path.join(dist, f), 'utf8');

/* "</script" dentro do conteúdo fecharia o elemento: escapa. */
const safe = (js) => js.replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\!--');

let html = read('index.html');
html = html.replace('<link rel="stylesheet" href="style.css">', () => '<style>\n' + read('style.css') + '</style>');

const wasm = fs.readFileSync(path.join(dist, 'ksvm.wasm')).toString('base64');
const workerSrc = ['vmcore.js', 'format.js', 'worker.js'].map(read).join('\n;\n');
let injected = false;
html = html.replace(/<script src="([^"]+)"><\/script>/g, (m, src) => {
  let pre = '';
  if (src === 'ksweb.js' && !injected) {
    injected = true;
    pre = '<script>window.KSWEB_WASM_B64 = "' + wasm + '";</script>\n' +
      '<script type="text/js-worker" id="ksweb-worker-src">\n' + safe(workerSrc) + '\n</script>\n';
  }
  return pre + '<script>\n/* ' + src + ' */\n' + safe(read(src)) + '\n</script>';
});
if (!injected) throw new Error('index.html sem ksweb.js');
html = html.replace('<title>ksweb', '<title>ksweb (arquivo único)');
fs.writeFileSync(outPath, html);
