#!/usr/bin/env node
/*
 * mksingle.js — gera ksweb-single.html: a IDE inteira num arquivo só, que
 * abre com clique duplo (file://), sem fetch nem worker externo.
 *
 *   node tools/mksingle.js DIST_DIR SAIDA.html
 *
 * - style.css e todos os <script src> de index.html (inclusive o
 *   CodeMirror de vendor/ e isa.js) entram inline;
 * - ksvm.wasm, ksas.wasm e ksdis.wasm viram base64 em
 *   window.KSWEB_WASM_B64, KSWEB_KSAS_B64 e KSWEB_KSDIS_B64 (ksweb.js usa
 *   no lugar do fetch); os exemplos já estão em examples.js (base64);
 * - os dois workers vão em <script type="text/js-worker">, que ksweb.js
 *   transforma em Blob para o new Worker():
 *     ksweb-worker-src      vmcore.js + format.js + worker.js (a VM)
 *     ksweb-asm-worker-src  wasi.js + ksasm-lang.js + asmtools.js +
 *                           asm-worker.js (o assembler)
 */
'use strict';
const fs = require('fs');
const path = require('path');

const [dist, outPath] = process.argv.slice(2);
const read = (f) => fs.readFileSync(path.join(dist, f), 'utf8');
const b64 = (f) => fs.readFileSync(path.join(dist, f)).toString('base64');

/* "</script" dentro do conteúdo fecharia o elemento; "<!--" mudaria o
 * estado do parser de script: escapa os dois. */
const safe = (js) => js.replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\!--');

let html = read('index.html');
html = html.replace('<link rel="stylesheet" href="style.css">', () => '<style>\n' + read('style.css') + '</style>');

const vmWorker = ['vmcore.js', 'format.js', 'worker.js'].map(read).join('\n;\n');
const asmWorker = ['wasi.js', 'ksasm-lang.js', 'asmtools.js', 'asm-worker.js'].map(read).join('\n;\n');
let injected = false;
html = html.replace(/<script src="([^"]+)"><\/script>/g, (m, src) => {
  let pre = '';
  if (src === 'ksweb.js' && !injected) {
    injected = true;
    pre = '<script>window.KSWEB_WASM_B64 = "' + b64('ksvm.wasm') + '";\n' +
      'window.KSWEB_KSAS_B64 = "' + b64('ksas.wasm') + '";\n' +
      'window.KSWEB_KSDIS_B64 = "' + b64('ksdis.wasm') + '";</script>\n' +
      '<script type="text/js-worker" id="ksweb-worker-src">\n' + safe(vmWorker) + '\n</script>\n' +
      '<script type="text/js-worker" id="ksweb-asm-worker-src">\n' + safe(asmWorker) + '\n</script>\n';
  }
  return pre + '<script>\n/* ' + src + ' */\n' + safe(read(src)) + '\n</script>';
});
if (!injected) throw new Error('index.html sem ksweb.js');
html = html.replace('<title>ksweb', '<title>ksweb (arquivo único)');
fs.writeFileSync(outPath, html);
