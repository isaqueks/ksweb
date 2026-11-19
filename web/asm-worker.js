/*
 * asm-worker.js — Web Worker do assembler: roda o ksas.wasm e o ksdis.wasm
 * pelo shim WASI (wasi.js + asmtools.js) fora do thread da página, para o
 * lint em tempo real e a montagem não travarem a digitação.
 *
 * Página -> worker:
 *   {type: 'init', ksas: ArrayBuffer, ksdis: ArrayBuffer, isa}    -> ready | fatal
 *   {type: 'assemble', id, files: [[nome, texto]], main, debug}  -> assembled
 *   {type: 'disassemble', id, image: ArrayBuffer}                 -> disassembled
 * Worker -> página:
 *   {type: 'ready'}, {type: 'fatal', message}
 *   {type: 'assembled', id, result}   resultado de AsmTools.assemble (Maps
 *                                     passam pelo structured clone)
 *   {type: 'disassembled', id, ok, text, rows, stderr}
 */
'use strict';
/* global AsmTools, KsasmLang, compileWasi */
if (typeof AsmTools === 'undefined') importScripts('wasi.js', 'ksasm-lang.js', 'asmtools.js');

let ksas = null, ksdis = null;
const early = [];

function post(m, transfer) { self.postMessage(m, transfer || []); }

function handle(m) {
  if (m.type === 'assemble') {
    let result;
    try {
      result = AsmTools.assemble(ksas, { files: new Map(m.files), main: m.main, debug: m.debug !== false, defines: m.defines || [] });
    } catch (e) {
      result = { ok: false, exitCode: -1, stderr: String(e && e.message || e), diagnostics: [{ file: null, line: 0, col: 0, message: 'falha no ksas.wasm: ' + (e && e.message || e), severity: 'error' }], image: null, listingText: '', info: null };
    }
    const transfer = result.image ? [result.image.buffer] : [];
    post({ type: 'assembled', id: m.id, result }, transfer);
  } else if (m.type === 'disassemble') {
    try {
      const r = AsmTools.disassemble(ksdis, new Uint8Array(m.image));
      post({ type: 'disassembled', id: m.id, ok: r.ok, text: r.text, stderr: r.stderr, rows: AsmTools.parseKsdis(r.text) });
    } catch (e) {
      post({ type: 'disassembled', id: m.id, ok: false, text: '', stderr: String(e && e.message || e), rows: [] });
    }
  }
}

self.onmessage = (ev) => {
  const m = ev.data;
  if (m.type === 'init') {
    try {
      if (m.isa && typeof KsasmLang !== 'undefined') KsasmLang.setIsa(m.isa);
      ksas = compileWasi(new Uint8Array(m.ksas));
      ksdis = compileWasi(new Uint8Array(m.ksdis));
    } catch (e) {
      post({ type: 'fatal', message: 'não consegui compilar o ksas.wasm/ksdis.wasm: ' + (e && e.message || e) });
      return;
    }
    post({ type: 'ready' });
    while (early.length) handle(early.shift());
    return;
  }
  if (!ksas) early.push(m);
  else handle(m);
};
