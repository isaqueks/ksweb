#!/usr/bin/env node
/*
 * check_dist.js — confere a distribuição (dist/ e dist/ksweb-single.html)
 * e exercita worker.js pelo protocolo de mensagens, em Node:
 *
 *   1. dist/ tem todos os arquivos referenciados por index.html;
 *   2. ksweb-single.html não referencia nada externo, contém o wasm em
 *      base64 idêntico a dist/ksvm.wasm e todos os seus <script> compilam;
 *   3. os scripts sem DOM extraídos do HTML (vt, input, format, vmcore,
 *      exemplos) rodam num contexto vm: o wasm embutido executa o exemplo
 *      embutido "hello";
 *   4. o código do worker embutido (vmcore + format + worker) roda num
 *      "self" falso: init, load, run, output, wait/input/eof, step, mem,
 *      debug com breakpoint e trace-export.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const dist = process.argv[2] || 'dist';
let total = 0, failed = 0;
const tests = [];
function test(name, fn) { tests.push([name, fn]); }
function eq(a, b, what) {
  const sa = JSON.stringify(a), sb = JSON.stringify(b);
  if (sa !== sb) throw new Error((what || 'valor') + ': ' + sa + ' != esperado ' + sb);
}
function ok(c, what) { if (!c) throw new Error(what || 'condição falsa'); }

const single = fs.readFileSync(path.join(dist, 'ksweb-single.html'), 'utf8');
const wasmFile = fs.readFileSync(path.join(dist, 'ksvm.wasm'));

/* <script ...>conteúdo</script> */
function scripts(html) {
  const out = [];
  const re = /<script([^>]*)>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(html))) out.push({ attrs: m[1], code: m[2] });
  return out;
}

test('dist-arquivos', () => {
  const idx = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');
  const refs = [...idx.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
  ok(refs.length >= 8, 'referências em index.html');
  for (const r of refs.concat(['ksvm.wasm', 'worker.js'])) ok(fs.existsSync(path.join(dist, r)), 'falta ' + r);
  const ex = fs.readdirSync(path.join(dist, 'examples')).filter((f) => f.endsWith('.ksx'));
  ok(ex.length >= 10, 'exemplos .ksx em dist/examples');
  ok(!/https?:\/\//.test(idx.replace(/<!--[\s\S]*?-->/g, '')), 'index.html sem URLs externas');
});

test('single-autocontido', () => {
  ok(!/<script[^>]+src=/.test(single), 'nenhum <script src>');
  ok(!/<link[^>]+href=/.test(single), 'nenhum <link href>');
  ok(!/\bfetch\(\s*['"]https?:/.test(single), 'sem fetch externo');
  const m = /window\.KSWEB_WASM_B64 = "([A-Za-z0-9+/=]+)"/.exec(single);
  ok(m, 'wasm em base64');
  ok(Buffer.from(m[1], 'base64').equals(wasmFile), 'base64 = dist/ksvm.wasm');
  ok(/id="ksweb-worker-src"/.test(single), 'código do worker embutido');
});

test('single-scripts-compilam', () => {
  const s = scripts(single);
  ok(s.length >= 10, 'scripts: ' + s.length);
  for (const { code } of s) new vm.Script(code);           /* lança SyntaxError */
  for (const f of fs.readdirSync(dist).filter((x) => x.endsWith('.js'))) {
    new vm.Script(fs.readFileSync(path.join(dist, f), 'utf8'), { filename: f });
  }
});

function pureContext() {
  const ctx = { console, TextEncoder, TextDecoder, WebAssembly, atob, btoa, performance, setTimeout, clearTimeout };
  ctx.self = ctx;
  ctx.window = ctx;
  return vm.createContext(ctx);
}

test('single-wasm-e-exemplo-embutido', () => {
  const ctx = pureContext();
  const s = scripts(single).filter((x) => !/type=/.test(x.attrs));
  /* só os scripts sem DOM (mksingle.js marca cada um com o nome do arquivo) */
  const PURE = /^\s*\/\* (vt|input|format|vmcore|examples)\.js \*\//;
  for (const { code } of s) {
    if (PURE.test(code) || /^window\.KSWEB_WASM_B64 = "/.test(code)) vm.runInContext(code, ctx);
  }
  const code = `
    const bin = atob(KSWEB_WASM_B64), w = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) w[i] = bin.charCodeAt(i);
    const core = KsCore.createSync(w);
    const ex = KSWEB_EXAMPLES.find((e) => e.name === 'hello');
    const ib = atob(ex.b64), img = new Uint8Array(ib.length);
    for (let i = 0; i < ib.length; i++) img[i] = ib.charCodeAt(i);
    const ses = new KsSession(core, {});
    ses.load(img);
    const r = ses.runSync('');
    ({ out: new TextDecoder().decode(r.stdout), code: r.info.code,
       vt: (() => { const v = new VtScreen({ cols: 20, rows: 3 }); v.write(r.stdout); return v.lineText(0); })() });`;
  const r = vm.runInContext(code, ctx);
  eq(r.out, 'Hello, KSVM!\n'); eq(r.code, 0); eq(r.vt, 'Hello, KSVM!');
});

/* ---- worker num self falso ---- */
async function workerHarness(src) {
  const msgs = [];
  const ctx = {
    console, TextEncoder, TextDecoder, WebAssembly, performance, setTimeout, clearTimeout, MessageChannel,
    importScripts: () => { throw new Error('importScripts não deveria ser chamado'); },
    postMessage: (m) => { m._t = performance.now(); msgs.push(m); wake(); }
  };
  ctx.self = ctx;
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  let waiter = null;
  function wake() { if (waiter) { const w = waiter; waiter = null; w(); } }
  let seen = 0;
  async function until(pred, ms) {
    const t0 = Date.now();
    for (;;) {
      for (let i = seen; i < msgs.length; i++) {
        if (pred(msgs[i])) { seen = i + 1; return msgs[i]; }
      }
      if (Date.now() - t0 > (ms || 5000)) throw new Error('timeout esperando mensagem; recebidas: ' + msgs.slice(seen).map((m) => m.type + ':' + (m.state || '')).join(' '));
      await new Promise((res) => { waiter = res; setTimeout(res, 20); });
    }
  }
  const errors = [];
  /* sem await: devolve o que onmessage devolver; rejeições ficam em errors */
  const post = (m) => {
    try {
      const r = ctx.onmessage({ data: m });
      if (r && typeof r.then === 'function') r.catch((e) => errors.push(e));
      return r;
    } catch (e) { errors.push(e); return undefined; }
  };
  const sendMsg = async (m) => { await post(m); };
  const outputs = () => msgs.filter((m) => m.type === 'output').map((m) => Buffer.from(m.bytes).toString('latin1')).join('');
  return { msgs, until, send: sendMsg, post, errors, outputs, ctx };
}

const examplesCtx = pureContext();
vm.runInContext(fs.readFileSync(path.join(dist, 'examples.js'), 'utf8'), examplesCtx);
const EXAMPLES = examplesCtx.KSWEB_EXAMPLES;
const exImage = (name) => {
  const b = Buffer.from(EXAMPLES.find((e) => e.name === name).b64, 'base64');
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.length);
};

function workerSources() {
  const s = scripts(single).find((x) => /ksweb-worker-src/.test(x.attrs));
  return [
    ['single', s.code],
    ['dist', ['vmcore.js', 'format.js', 'worker.js'].map((f) => fs.readFileSync(path.join(dist, f), 'utf8')).join('\n;\n')]
  ];
}

for (const [label, src] of workerSources()) {
  test('worker-' + label + '-hello', async () => {
    const w = await workerHarness(src);
    await w.send({ type: 'init', wasm: wasmFile.buffer.slice(wasmFile.byteOffset, wasmFile.byteOffset + wasmFile.length) });
    await w.until((m) => m.type === 'ready');
    await w.send({ type: 'load', image: exImage('hello'), opts: { ramSize: 1 << 20, slice: 1000 } });
    const l = await w.until((m) => m.type === 'loaded');
    ok(l.ok, 'carregou'); eq(l.header.entry, 0);
    await w.send({ type: 'run' });
    const st = await w.until((m) => m.type === 'status' && m.state === 'done');
    eq(st.info.code, 0);
    eq(w.outputs(), 'Hello, KSVM!\n');
  });

  test('worker-' + label + '-stdin-wait-input-eof', async () => {
    const w = await workerHarness(src);
    await w.send({ type: 'init', wasm: new Uint8Array(wasmFile).buffer });
    await w.until((m) => m.type === 'ready');
    await w.send({ type: 'load', image: exImage('maiusculas'), opts: {} });
    await w.until((m) => m.type === 'loaded');
    await w.send({ type: 'run' });
    await w.until((m) => m.type === 'status' && m.state === 'waiting');
    await w.send({ type: 'input', bytes: new TextEncoder().encode('oi\n').buffer });
    await w.until((m) => m.type === 'status' && m.state === 'waiting');
    await w.send({ type: 'eof' });
    const st = await w.until((m) => m.type === 'status' && m.state === 'done');
    eq(st.info.code, 1);
    eq(w.outputs(), '> OI\n> 1 linhas\n');
  });

  test('worker-' + label + '-mensagens-antes-do-ready', async () => {
    /* A página pode mandar load/run logo depois de init, antes do ready. */
    const w = await workerHarness(src);
    w.post({ type: 'init', wasm: new Uint8Array(wasmFile).buffer });
    w.post({ type: 'load', image: exImage('hello'), opts: {} });
    w.post({ type: 'run' });
    await w.until((m) => m.type === 'ready');
    const l = await w.until((m) => m.type === 'loaded');
    ok(l.ok, 'carregou');
    const st = await w.until((m) => m.type === 'status' && m.state === 'done');
    eq(st.info.code, 0);
    eq(w.outputs(), 'Hello, KSVM!\n');
    eq(w.errors.map(String), [], 'sem exceções');
  });

  test('worker-' + label + '-run-repetido-nao-encurta-sleep', async () => {
    /* "Continuar" do depurador manda run com a VM já andando: não pode
     * abrir outra cadeia de fatias nem cancelar o prazo do SLEEP_MS. */
    const w = await workerHarness(src);
    await w.send({ type: 'init', wasm: new Uint8Array(wasmFile).buffer });
    await w.until((m) => m.type === 'ready');
    await w.send({ type: 'load', image: exImage('vtdemo'), opts: {} });
    await w.until((m) => m.type === 'loaded');
    await w.send({ type: 'run' });
    const s1 = await w.until((m) => m.type === 'status' && m.state === 'sleeping');
    eq(s1.ms, 25, 'prazo do quadro');
    await w.send({ type: 'run' });
    await w.send({ type: 'run' });
    const s2 = await w.until((m) => m.type === 'status' && m.state === 'sleeping');
    ok(s2._t - s1._t >= 20, 'o quadro seguinte respeitou o prazo: ' + (s2._t - s1._t).toFixed(1) + ' ms');
    await w.send({ type: 'pause' });
  });

  test('worker-' + label + '-poll-durante-espera-retoma', async () => {
    /* Ligar "stdin não bloqueante" com a VM suspensa em GETS: a syscall
     * tem de ser repetida já em modo poll (devolve 0, o programa cede). */
    const w = await workerHarness(src);
    await w.send({ type: 'init', wasm: new Uint8Array(wasmFile).buffer });
    await w.until((m) => m.type === 'ready');
    await w.send({ type: 'load', image: exImage('maiusculas'), opts: {} });
    await w.until((m) => m.type === 'loaded');
    await w.send({ type: 'run' });
    await w.until((m) => m.type === 'status' && m.state === 'waiting');
    await w.send({ type: 'config', stdinBlock: false });
    await w.until((m) => m.type === 'status' && m.state === 'sleeping', 2000);
    await w.send({ type: 'input', bytes: new TextEncoder().encode('ok\n').buffer });
    await w.send({ type: 'eof' });
    const st = await w.until((m) => m.type === 'status' && m.state === 'done');
    eq(st.info.code, 1);
    eq(w.outputs(), '> OK\n> 1 linhas\n');
  });

  test('worker-' + label + '-depurador', async () => {
    const w = await workerHarness(src);
    await w.send({ type: 'init', wasm: new Uint8Array(wasmFile).buffer });
    await w.until((m) => m.type === 'ready');
    await w.send({ type: 'debug', debug: { on: true, traceN: 100, bps: [0x10], stopBrk: true, stopSyscall: false } });
    await w.send({ type: 'load', image: exImage('hello'), opts: {} });
    await w.until((m) => m.type === 'loaded');
    await w.send({ type: 'run' });
    const b = await w.until((m) => m.type === 'status' && m.state === 'break');
    eq([b.reason, b.pc], ['breakpoint', 0x10]);
    const snap = await w.until((m) => m.type === 'snapshot');
    eq(snap.cpu.pc, 0x10);
    ok(snap.window.some((x) => x.current && x.addr === 0x10 && x.text === 'syscall 0x12'), 'janela de disasm com o pc');
    eq(snap.trace.length, 2, 'trace com as 2 instruções executadas');
    await w.send({ type: 'mem', addr: 0x1C, len: 13, id: 7 });
    const mem = await w.until((m) => m.type === 'mem');
    eq(Buffer.from(mem.bytes).toString(), 'Hello, KSVM!\n');
    await w.send({ type: 'step', n: 1 });
    const stp = await w.until((m) => m.type === 'stepped');
    eq([stp.pc, stp.text], [0x10, 'syscall 0x12']);
    await w.send({ type: 'trace-export' });
    const tr = await w.until((m) => m.type === 'trace-text');
    eq(tr.text.split('\n')[0], '00000000: 03 01 00 00 1C 00 00 00  movil r1, 0x1C               ----');
    await w.send({ type: 'run' });
    const d = await w.until((m) => m.type === 'status' && m.state === 'done');
    eq(d.info.code, 0);
  });
}

(async () => {
  for (const [name, fn] of tests) {
    total++;
    try { await fn(); } catch (e) { failed++; console.log('FALHA [' + name + '] ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e)); }
  }
  console.log('check_dist: ' + total + ' casos, ' + failed + ' falhas');
  process.exit(failed ? 1 : 0);
})();
