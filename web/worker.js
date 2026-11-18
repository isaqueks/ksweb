/*
 * worker.js — executa a VM num Web Worker para a página não congelar.
 *
 * Laço: fatias de opts.slice instruções (ksweb_run); várias fatias por
 * tarefa até ~12 ms, depois cede o thread (MessageChannel, sem o atraso
 * mínimo de setTimeout) para atender mensagens da página. Estados:
 *   YIELD/SLEEP_MS  setTimeout(prazo; 1 ms no YIELD puro, como o runner)
 *   WAIT_INPUT      o laço para até chegar 'input'/'eof' (nada gira)
 *   BREAK/fim       para e envia um retrato do estado ao depurador
 *
 * Protocolo de mensagens: docs/01-arquitetura.md §4.
 */
'use strict';
/* global KsCore, KsSession, KsFormat, STATE_NAME */
if (typeof KsCore === 'undefined') importScripts('vmcore.js', 'format.js');

let core = null;
let session = null;
let image = null;
let opts = {};
let running = false;        /* o usuário quer a VM andando */
let waiting = false;        /* parada em WAIT_INPUT */
let timer = null;
let budgetMs = 12;
let debug = { on: false, traceN: 0, stopBrk: false, stopSyscall: false, bps: [] };
let totalInsns = 0;         /* soma das fatias (insn_count dá a volta em 2^32) */
let lastInsn = 0;
let ipsT0 = 0, ipsN0 = 0, ips = 0, lastProgress = 0;
let outChunks = [];

const chan = new MessageChannel();
chan.port1.onmessage = () => loop();

function post(msg, transfer) { self.postMessage(msg, transfer || []); }

function flushOutput() {
  const out = core.takeOutput();
  if (out.length) post({ type: 'output', bytes: out }, [out.buffer]);
}

function countInsns() {
  const n = core.insnCount();
  totalInsns += (n - lastInsn) >>> 0;
  lastInsn = n;
}

function progress(force) {
  const t = performance.now();
  if (!force && t - lastProgress < 250) return;
  if (t - ipsT0 >= 500) {
    ips = Math.round((totalInsns - ipsN0) * 1000 / (t - ipsT0));
    ipsT0 = t; ipsN0 = totalInsns;
  }
  lastProgress = t;
  post({ type: 'progress', insns: totalInsns, ips });
}

function status(state, extra) {
  post(Object.assign({ type: 'status', state, insns: totalInsns, pc: core.pc() }, extra || {}));
}

function schedule(ms) {
  clearTimeout(timer);
  timer = null;
  if (ms > 0) timer = setTimeout(loop, ms);
  else chan.port2.postMessage(0);
}

function applyDebug() {
  core.bpClearAll();
  if (debug.on) for (const a of debug.bps) core.bpSet(a);
  core.setStopFlags(debug.on && debug.stopBrk, debug.on && debug.stopSyscall);
  const want = debug.on ? debug.traceN : 0;
  if (want !== core._traceN) { core.traceEnable(want); core._traceN = want; }
}

function load(msg) {
  image = new Uint8Array(msg.image);
  opts = Object.assign({}, msg.opts);
  running = false; waiting = false;
  clearTimeout(timer);
  session = new KsSession(core, opts);
  core._traceN = -1;
  const err = session.load(image);
  totalInsns = 0; lastInsn = 0; ipsN0 = 0; ipsT0 = performance.now(); ips = 0;
  applyDebug();
  core.takeOutput();
  if (err) {
    post({ type: 'loaded', ok: false, info: err });
    return;
  }
  post({ type: 'loaded', ok: true, header: core.header(), regions: core.regions(), version: core.version() });
  status('ready');
  if (debug.on) snapshot();
}

/* Uma rodada do laço: fatias até o orçamento de tempo. */
function loop() {
  timer = null;
  if (!running || waiting || !session) return;
  const t0 = performance.now();
  let r;
  do {
    r = session.tick(false);
    countInsns();
  } while (r.action === 'continue' && performance.now() - t0 < budgetMs);
  flushOutput();
  handle(r);
}

function handle(r) {
  switch (r.action) {
    case 'continue':
      progress(false);
      schedule(0);
      break;
    case 'sleep':
      progress(false);
      status('sleeping', { ms: r.ms });
      schedule(Math.max(1, r.ms));
      break;
    case 'wait':
      waiting = true;
      progress(true);
      status('waiting');
      if (debug.on) snapshot();
      break;
    case 'break':
      running = false;
      progress(true);
      status('break', { reason: r.reason });
      snapshot();
      break;
    case 'done':
      running = false;
      progress(true);
      status('done', { info: r.info, cpu: core.cpu() });
      snapshot();
      break;
    default:
      running = false;
  }
}

function snapshot() {
  if (!session || !core.header().loaded) return;
  const h = core.header();
  const cpu = core.cpu();
  const win = KsFormat.disasmWindow(cpu.pc, (a) => core.disasmAt(a), 0, h.codeSize, 32, 32);
  const sp = cpu.r[31] >>> 0;
  const st = core.memRead(sp, 32 * 4);
  const words = [], readable = [];
  for (let i = 0; i < 32; i++) {
    const b = st.bytes, o = 4 * i;
    words.push((b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0);
    readable.push(st.mask[o] === 1 && st.mask[o + 3] === 1);
  }
  const fault = core.status() === 2 ? core.faultInfo() : null;
  post({
    type: 'snapshot', cpu, window: win, stack: { sp, words, readable }, fault,
    trace: debug.on && debug.traceN ? core.traceTail(Math.min(debug.traceN, 1000)) : [],
    traceTotal: core.traceTotal(), insns: totalInsns, bps: core.bpList()
  });
}

function feedInput(bytes) {
  if (!session) return;
  session.pushInput(bytes);
  resumeIfWaiting();
}

function resumeIfWaiting() {
  if (waiting && session.hasInput()) {
    waiting = false;
    status(running ? 'running' : 'paused');
    if (running) schedule(0);
  }
}

/* Mensagens que chegam enquanto o wasm compila esperam o 'ready'. O
 * handler é síncrono: uma exceção vira o evento 'error' do Worker na
 * página (num handler async ela sumiria como rejeição não tratada). */
let early = [];

function init(m) {
  KsCore.create(m.wasm, {}).then((c) => {
    core = c;
    post({ type: 'ready', version: core.version() });
    const q = early;
    early = [];
    for (const x of q) {
      try { dispatch(x); } catch (e) { setTimeout(() => { throw e; }); }
    }
  }, (e) => post({ type: 'fatal', message: 'não consegui instanciar o wasm: ' + (e && e.message ? e.message : e) }));
}

self.onmessage = (ev) => {
  const m = ev.data;
  if (m.type === 'init') init(m);
  else if (!core) early.push(m);
  else dispatch(m);
};

function dispatch(m) {
  switch (m.type) {
    case 'load':
      load(m);
      break;
    case 'run':
      if (!session || session.finished) return;
      if (m.slice) session.opts.slice = m.slice;
      if (running) return;    /* já anda: outra cadeia de fatias cortaria o prazo do SLEEP_MS */
      running = true;
      status(waiting ? 'waiting' : 'running');
      if (!waiting) schedule(0);
      break;
    case 'pause':
      if (!session) return;
      running = false;
      clearTimeout(timer);
      flushOutput();
      status(session.finished ? 'done' : 'paused', session.finished ? { info: session.finished } : {});
      snapshot();
      break;
    case 'step': {
      if (!session || session.finished) return;
      running = false;
      clearTimeout(timer);
      const n = Math.max(1, m.n | 0);
      let r;
      if (n === 1) {
        const pc0 = core.pc(), d = core.disasmAt(pc0);
        r = session.tick(true);
        countInsns();
        post({ type: 'stepped', pc: pc0, text: d.text, len: d.len, cpu: core.cpu() });
      } else {
        const saved = session.opts.slice;
        session.opts.slice = n;
        r = session.tick(false);
        session.opts.slice = saved;
      }
      countInsns();
      flushOutput();
      progress(true);
      if (r.action === 'continue' || r.action === 'sleep') {
        status('paused');
        snapshot();
      } else {
        handle(r);
      }
      break;
    }
    case 'input':
      feedInput(new Uint8Array(m.bytes));
      break;
    case 'eof':
      if (!session) return;
      session.eof();
      resumeIfWaiting();
      break;
    case 'config':
      if (m.slice && session) session.opts.slice = m.slice;
      if (m.stdinBlock !== undefined && session) { session.opts.stdinBlock = m.stdinBlock; core.setStdinBlock(m.stdinBlock); }
      if (m.budgetMs) budgetMs = m.budgetMs;
      break;
    case 'debug':
      debug = Object.assign(debug, m.debug);
      if (session) {
        applyDebug();
        if (!running || waiting) snapshot();
      }
      break;
    case 'snapshot':
      snapshot();
      break;
    case 'mem': {
      if (!session) return;
      const r = core.memRead(m.addr >>> 0, Math.min(m.len | 0, 65536));
      post({ type: 'mem', id: m.id, addr: m.addr >>> 0, bytes: r.bytes, mask: r.mask }, [r.bytes.buffer, r.mask.buffer]);
      break;
    }
    case 'trace-export':
      post({ type: 'trace-text', text: session ? core.traceText() : '', total: core.traceTotal(), count: core.traceCount() });
      break;
    default:
      break;
  }
}
