#!/usr/bin/env node
/*
 * test_worker.js — o protocolo do worker da VM (web/worker.js) em Node, com
 * o worker carregado num contexto vm (self, postMessage, MessageChannel):
 *
 *   node test/test_worker.js --build build
 *
 * Roteiros de depuração que só o worker decide (passo por cima/sair da
 * função com parada por profundidade no laço C, entrada pendente, pausa):
 * a mensagem 'status' final e o pc são conferidos contra o fonte montado
 * pelo ksas.wasm (endereços tirados do mapa linha <-> endereço).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const T = require('../web/asmtools.js');

const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
const BUILD = args.build || 'build';
const WASM = fs.readFileSync(path.join(BUILD, 'ksvm.wasm'));
const KSAS = fs.readFileSync(path.join(BUILD, 'ksas.wasm'));
const WEB = path.join(__dirname, '..', 'web');

let total = 0, failed = 0;
async function test(name, fn) {
  total++;
  try { await fn(); } catch (e) { failed++; console.log('FALHA [' + name + '] ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e)); }
}
function eq(a, b, what) {
  const sa = JSON.stringify(a), sb = JSON.stringify(b);
  if (sa !== sb) throw new Error((what || 'valor') + ': ' + sa + ' != esperado ' + sb);
}
function ok(c, what) { if (!c) throw new Error(what || 'condição falsa'); }

/* Worker num contexto próprio; msgs = tudo o que ele postou. */
function startWorker() {
  const msgs = [];
  const chans = [];
  class MC extends MessageChannel { constructor() { super(); chans.push(this); } }
  const ctx = {
    console, setTimeout, clearTimeout, performance, TextEncoder, TextDecoder, WebAssembly, MessageChannel: MC,
    postMessage: (m) => msgs.push(m)
  };
  ctx.self = ctx;
  ctx.importScripts = (...files) => { for (const f of files) vm.runInContext(fs.readFileSync(path.join(WEB, f), 'utf8'), ctx, { filename: f }); };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(WEB, 'worker.js'), 'utf8'), ctx, { filename: 'worker.js' });
  const w = {
    msgs,
    send(m) { ctx.onmessage({ data: m }); },
    close() { for (const c of chans) { c.port1.close(); c.port2.close(); } },
    /* espera uma mensagem (a partir de from) que satisfaça pred */
    async until(pred, from, ms) {
      const t0 = Date.now();
      for (;;) {
        for (let i = from || 0; i < msgs.length; i++) if (pred(msgs[i])) return msgs[i];
        if (Date.now() - t0 > (ms || 3000)) throw new Error('tempo esgotado; últimas: ' + JSON.stringify(msgs.slice(-4).map((m) => m.type + ':' + (m.state || ''))));
        await new Promise((r) => setTimeout(r, 2));
      }
    }
  };
  return w;
}

function assemble(src) {
  const r = T.assemble(KSAS, { files: { 'p.ksasm': src }, main: 'p.ksasm' });
  if (!r.ok) throw new Error(r.stderr);
  const lineAddr = (l) => r.info.lines.get('p.ksasm\n' + l).addr;
  return { image: r.image, lineAddr };
}

async function boot(prog) {
  const w = startWorker();
  w.send({ type: 'init', wasm: WASM.buffer.slice(WASM.byteOffset, WASM.byteOffset + WASM.length) });
  await w.until((m) => m.type === 'ready');
  w.send({ type: 'debug', debug: { on: true, traceN: 0, stopBrk: false, stopSyscall: false, bps: prog.bps || [] } });
  const img = prog.image.slice();
  w.send({ type: 'load', image: img.buffer, opts: { ramSize: 1 << 20, stackSize: 0, maxInsns: 0, slice: 1000, stdinBlock: true } });
  await w.until((m) => m.type === 'loaded');
  return w;
}

/* Status de parada (break/done/paused/waiting) depois do índice from. */
const stopAfter = (w, from) => w.until((m) => m.type === 'status' && ['break', 'done', 'paused', 'waiting'].includes(m.state), from);

/*
 * _start chama main; main chama f, que lê um caractere (GETC) e volta.
 * Passo por cima de "call f" para em WAIT_INPUT dentro de f.
 */
const SRC = [
  '_start:',              // 1
  '        call main',     // 2
  '        mov r1, r16',   // 3
  '        halt',          // 4
  'main:',                // 5
  '        call f',        // 6
  '        mov r16, r1',   // 7
  '        call g',        // 8
  '        ret',           // 9
  'f:',                   // 10
  '        syscall GETC',  // 11
  '        ret',           // 12
  'g:',                   // 13
  '        nop',           // 14
  '        ret',           // 15
  ''].join('\n');

(async () => {
  const P = assemble(SRC);
  const A = P.lineAddr;

  await test('passo por cima com entrada pendente: termina ao chegar a entrada', async () => {
    const w = await boot(P);
    w.send({ type: 'step', mode: 'into', n: 1 });                 /* entra em main */
    let s = await stopAfter(w, 0);
    eq(s.pc, A(6), 'em call f');
    let k = w.msgs.length;
    w.send({ type: 'step', mode: 'over', n: 1 });
    s = await stopAfter(w, k);
    eq(s.state, 'waiting', 'esperando o GETC');
    k = w.msgs.length;
    w.send({ type: 'input', bytes: new Uint8Array([65]).buffer });
    s = await stopAfter(w, k);
    eq([s.state, s.reason, s.pc], ['break', 'step', A(7)], 'volta depois do call f');
    w.close();
  });

  /* Durante a espera do GETC, o usuário dá passos de uma instrução (F11 é
   * permitido no estado "esperando entrada") até sair de f. A parada por
   * profundidade do passo por cima interrompido não pode sobreviver: o
   * Continuar seguinte tem de rodar até o fim, não parar no "ret" de main. */
  await test('passo por cima interrompido por passos: Continuar não para num ret qualquer', async () => {
    const w = await boot(P);
    w.send({ type: 'step', mode: 'into', n: 1 });
    await stopAfter(w, 0);
    let k = w.msgs.length;
    w.send({ type: 'step', mode: 'over', n: 1 });
    let s = await stopAfter(w, k);
    eq(s.state, 'waiting', 'esperando o GETC');
    k = w.msgs.length;
    w.send({ type: 'step', mode: 'into', n: 1 });                 /* F11 com a VM esperando */
    await w.until((m) => m.type === 'status' && m.state === 'waiting', k);
    k = w.msgs.length;
    w.send({ type: 'input', bytes: new Uint8Array([66]).buffer });
    s = await stopAfter(w, k);
    eq(s.state, 'paused', 'entrada chegou com a VM parada pelo passo');
    for (const want of [A(12), A(7)]) {                            /* GETC, ret */
      k = w.msgs.length;
      w.send({ type: 'step', mode: 'into', n: 1 });
      s = await stopAfter(w, k);
      eq(s.pc, want, 'passo');
    }
    k = w.msgs.length;
    w.send({ type: 'run', slice: 1000 });
    s = await stopAfter(w, k);
    eq([s.state, s.info && s.info.code], ['done', 66], 'Continuar roda até o fim (código = "B")');
    w.close();
  });

  /* Passo N com um passo por cima pendente (interrompido pela espera de
   * entrada): executa N instruções, sem parar no ret do passo antigo. */
  await test('Passo N durante passo por cima pendente executa N instruções', async () => {
    const w = await boot(P);
    w.send({ type: 'step', mode: 'into', n: 1 });
    await stopAfter(w, 0);
    let k = w.msgs.length;
    w.send({ type: 'step', mode: 'over', n: 1 });
    let s = await stopAfter(w, k);
    eq(s.state, 'waiting', 'esperando o GETC');
    k = w.msgs.length;
    w.send({ type: 'step', n: 3 });                                /* Passo N com a VM esperando */
    await w.until((m) => m.type === 'status' && m.state === 'waiting', k);
    k = w.msgs.length;
    w.send({ type: 'input', bytes: new Uint8Array([67]).buffer });
    s = await stopAfter(w, k);
    eq(s.state, 'paused', 'parada');
    k = w.msgs.length;
    w.send({ type: 'step', n: 3 });                                /* GETC, ret, mov */
    s = await stopAfter(w, k);
    eq([s.state, s.pc], ['paused', A(8)], '3 instruções');
    k = w.msgs.length;
    w.send({ type: 'run', slice: 1000 });
    s = await stopAfter(w, k);
    eq([s.state, s.info && s.info.code], ['done', 67], 'até o fim');
    w.close();
  });

  await test('sair da função no nível de _start roda até o fim', async () => {
    const w = await boot(P);
    w.send({ type: 'input', bytes: new Uint8Array([68]).buffer });
    const k = w.msgs.length;
    w.send({ type: 'step', mode: 'out', n: 1 });
    const s = await stopAfter(w, k);
    eq([s.state, s.info && s.info.code], ['done', 68], 'fim');
    w.close();
  });

  await test('breakpoint dentro da função interrompe o passo por cima e o desliga', async () => {
    const w = await boot(Object.assign({}, P, { bps: [A(14)] }));
    w.send({ type: 'input', bytes: new Uint8Array([69]).buffer });
    w.send({ type: 'step', mode: 'into', n: 1 });
    await stopAfter(w, 0);
    let k = w.msgs.length;
    w.send({ type: 'step', mode: 'over', n: 1 });                 /* call f: volta */
    let s = await stopAfter(w, k);
    eq([s.state, s.reason, s.pc], ['break', 'step', A(7)], 'por cima de f');
    k = w.msgs.length;
    w.send({ type: 'step', mode: 'into', n: 1 });
    await stopAfter(w, k);
    k = w.msgs.length;
    w.send({ type: 'step', mode: 'over', n: 1 });                 /* call g: bp no nop */
    s = await stopAfter(w, k);
    eq([s.state, s.reason, s.pc], ['break', 'breakpoint', A(14)], 'breakpoint em g');
    w.send({ type: 'debug', debug: { on: true, traceN: 0, stopBrk: false, stopSyscall: false, bps: [] } });
    k = w.msgs.length;
    w.send({ type: 'run', slice: 1000 });
    s = await stopAfter(w, k);
    eq([s.state, s.info && s.info.code], ['done', 69], 'o passo interrompido não para no ret de g');
    w.close();
  });

  console.log('test_worker: ' + total + ' casos, ' + failed + ' falhas');
  process.exit(failed ? 1 : 0);
})();
