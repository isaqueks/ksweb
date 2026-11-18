/*
 * ksweb.js — controlador da página: carrega o wasm, cria o worker, liga
 * os controles, o terminal (terminal.js) e o depurador (debugger.js).
 *
 * Duas formas de distribuição:
 *   dist/index.html        busca ksvm.wasm com fetch e cria worker.js
 *   dist/ksweb-single.html wasm em base64 (KSWEB_WASM_B64) e o código do
 *                          worker num <script type="text/js-worker">,
 *                          transformado em Blob: abre com clique duplo
 */
(function () {
  'use strict';
  /* global TerminalView, DebuggerPanel, KsFormat, parseSymbols, KSWEB_EXAMPLES */
  const $ = (s) => document.querySelector(s);
  const F = KsFormat;

  const state = {
    worker: null, wasm: null, image: null, imageName: '', header: null,
    vmState: 'idle', loaded: false, lastInfo: null, pendingRun: false
  };
  let term, dbg;

  /* ---- utilidades ---- */

  function b64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  const enc = new TextEncoder();

  function sys(text, kind) { term.writeSystem(text, kind); }

  function send(msg, transfer) { if (state.worker) state.worker.postMessage(msg, transfer || []); }

  function intVal(sel, def) {
    const v = parseInt($(sel).value, 10);
    return Number.isFinite(v) && v >= 0 ? v : def;
  }

  function runOpts() {
    return {
      ramSize: intVal('#opt-ram', 1024) * 1024,
      stackSize: intVal('#opt-stack', 0),
      maxInsns: intVal('#opt-limit', 0),
      slice: Math.max(1, intVal('#opt-slice', 200000)),
      stdinBlock: !$('#opt-poll').checked
    };
  }

  /* ---- estado e botões ---- */

  const STATE_TEXT = {
    idle: 'sem programa', ready: 'pronto', running: 'executando', sleeping: 'executando (SLEEP)',
    waiting: 'esperando entrada', paused: 'pausado', break: 'parado (depurador)', done: 'terminou', error: 'erro'
  };

  function setState(s, extra) {
    state.vmState = s;
    const badge = $('#status');
    badge.textContent = STATE_TEXT[s] + (extra ? ' — ' + extra : '');
    badge.dataset.state = s;
    const canRun = state.loaded && ['ready', 'paused', 'break'].includes(s);
    const active = ['running', 'sleeping', 'waiting'].includes(s);
    $('#btn-run').disabled = !(canRun || (state.loaded && s === 'done'));
    $('#btn-run').textContent = s === 'paused' || s === 'break' ? 'Continuar' : 'Executar';
    $('#btn-stop').disabled = !active;
    $('#btn-restart').disabled = !state.image;
    $('#btn-step').disabled = !(state.loaded && (canRun || s === 'waiting'));
    $('#btn-eof').disabled = !state.loaded;
    $('#stdin-file-btn').disabled = !state.loaded;
    document.body.classList.toggle('waiting-input', s === 'waiting');
  }

  /* ---- worker ---- */

  function createWorker() {
    const src = document.getElementById('ksweb-worker-src');
    if (src) {
      const url = URL.createObjectURL(new Blob([src.textContent], { type: 'text/javascript' }));
      return new Worker(url);
    }
    return new Worker('worker.js');
  }

  async function loadWasm() {
    if (typeof window.KSWEB_WASM_B64 === 'string') return b64ToBytes(window.KSWEB_WASM_B64);
    const r = await fetch('ksvm.wasm');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return new Uint8Array(await r.arrayBuffer());
  }

  async function boot() {
    try {
      state.wasm = await loadWasm();
    } catch (e) {
      sys('não consegui carregar ksvm.wasm (' + e.message + ').', 'error');
      if (location.protocol === 'file:') {
        sys('Abrindo por file://, o navegador bloqueia fetch: use ksweb-single.html ou "make serve".', 'error');
      }
      setState('error');
      return;
    }
    try {
      state.worker = createWorker();
    } catch (e) {
      sys('não consegui criar o Web Worker (' + e.message + '). Use ksweb-single.html ou "make serve".', 'error');
      setState('error');
      return;
    }
    state.worker.onmessage = (ev) => onWorker(ev.data);
    state.worker.onerror = (ev) => { sys('erro no worker: ' + (ev.message || ev), 'error'); setState('error'); };
    const copy = state.wasm.slice();
    send({ type: 'init', wasm: copy.buffer }, [copy.buffer]);
  }

  function onWorker(m) {
    switch (m.type) {
      case 'ready':
        $('#version').textContent = 'KSVM ' + m.version;
        sys('KSVM ' + m.version + ' em WebAssembly (' + state.wasm.length + ' bytes). Carregue um .ksx (botão, arrastar e soltar ou exemplo).');
        sendDebug();
        setState('idle');
        if (state.image) loadImage(state.image, state.imageName, state.pendingRun);
        break;
      case 'loaded':
        if (!m.ok) {
          state.loaded = false;
          sys(state.imageName + ': ' + m.info.message + ' (código ' + m.info.code + ')', 'error');
          setState('done', 'código ' + m.info.code);
          break;
        }
        state.loaded = true;
        state.header = m.header;
        for (const l of F.headerLines(m.header, state.imageName)) sys(l);
        dbg.setImage(m.header, m.regions, parseSymbols(state.image, m.header.symOff, m.header.symSize));
        setState('ready');
        if (state.pendingRun) { state.pendingRun = false; run(); }
        break;
      case 'output':
        term.write(m.bytes);
        break;
      case 'status':
        onStatus(m);
        break;
      case 'progress':
        dbg.stats(m.insns, m.ips);
        $('#insns').textContent = m.insns.toLocaleString('pt-BR') + ' instr' + (m.ips ? ' · ' + fmtIps(m.ips) : '');
        break;
      case 'snapshot':
        dbg.snapshot(m);
        break;
      case 'stepped':
        if (!dbg.open) {
          sys('passo: 0x' + F.hex(m.pc) + '  ' + m.text);
          sys(F.regsDump(m.cpu).replace(/\n$/, ''));
        }
        break;
      case 'mem':
        dbg.memData(m);
        break;
      case 'trace-text':
        download('trace.txt', m.text);
        sys('trace exportado: ' + m.count + ' registros' + (m.total > m.count ? ' (os últimos de ' + m.total + ')' : ''));
        break;
      default:
        break;
    }
  }

  function fmtIps(ips) {
    return ips >= 1e6 ? (ips / 1e6).toFixed(1) + ' M instr/s' : ips.toLocaleString('pt-BR') + ' instr/s';
  }

  function onStatus(m) {
    if (m.state === 'done') {
      const info = m.info;
      state.lastInfo = info;
      if (info.kind === 'fault') {
        sys(info.message, 'error');
        sys('instrução: ' + (m.cpu ? '0x' + F.hex(info.fault.pc) : '') + (dbg.open ? ' (destacada no depurador)' : ''), 'error');
      } else if (info.kind === 'limit') {
        sys(info.message, 'error');
      }
      sys('fim: código de saída ' + info.code + ' · ' + m.insns.toLocaleString('pt-BR') + ' instruções',
        info.code === 0 ? 'ok' : 'error');
      if ($('#opt-regs').checked && m.cpu) sys(F.regsDump(m.cpu).replace(/\n$/, ''));
      setState('done', 'código ' + info.code);
      if (info.kind === 'fault' && $('#opt-dbg-on-fault').checked && !dbg.open) toggleDebugger(true);
      return;
    }
    if (m.state === 'break') {
      dbg.reason('parado: ' + m.reason + ' em 0x' + F.hex(m.pc));
      setState('break', m.reason + ' em 0x' + F.hex(m.pc));
      return;
    }
    if (m.state === 'paused') dbg.reason('pausado em 0x' + F.hex(m.pc));
    if (m.state === 'running' || m.state === 'waiting') dbg.reason('');
    setState(m.state);
    if (m.state === 'waiting') term.el.focus({ preventScroll: true });
  }

  function download(name, text) {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  /* ---- ações ---- */

  function loadImage(bytes, name, autoRun) {
    state.image = bytes;
    state.imageName = name;
    state.loaded = false;
    state.pendingRun = !!autoRun;
    $('#prog-name').textContent = name;
    if (!state.worker) return;
    sys('carregando ' + name + ' (' + bytes.length + ' bytes)');
    const copy = bytes.slice();
    send({ type: 'load', image: copy.buffer, opts: runOpts() }, [copy.buffer]);
  }

  function run() {
    if (!state.loaded) return;
    if (state.vmState === 'done') { restart(true); return; }
    term.el.focus({ preventScroll: true });
    send({ type: 'run', slice: runOpts().slice });
  }

  function pause() { send({ type: 'pause' }); }

  function step(n) {
    if (!state.loaded || state.vmState === 'done') return;
    send({ type: 'step', n: n || 1 });
  }

  function restart(autoRun) {
    if (!state.image) return;
    if ($('#opt-clear').checked) term.clear();
    loadImage(state.image, state.imageName, autoRun);
  }

  function sendInput(str) {
    if (!state.loaded) return;
    const b = enc.encode(str);
    send({ type: 'input', bytes: b.buffer }, [b.buffer]);
  }

  function sendEof() {
    if (!state.loaded) return;
    send({ type: 'eof' });
  }

  function sendDebug() { send({ type: 'debug', debug: dbg.config() }); }

  function toggleDebugger(on) {
    const open = on === undefined ? !dbg.open : on;
    dbg.setOpen(open);
    document.body.classList.toggle('dbg-open', open);
    $('#btn-dbg').setAttribute('aria-pressed', open ? 'true' : 'false');
    if (open && state.loaded) send({ type: 'snapshot' });
    setTimeout(() => term.fitToContainer(), 0);
  }

  function readFile(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(new Uint8Array(r.result));
      r.onerror = () => reject(r.error);
      r.readAsArrayBuffer(file);
    });
  }

  async function openFile(file) {
    try {
      const bytes = await readFile(file);
      if ($('#opt-clear').checked) term.clear();
      loadImage(bytes, file.name, $('#opt-autorun').checked);
    } catch (e) {
      sys('não consegui ler ' + file.name + ': ' + e.message, 'error');
    }
  }

  /* ---- montagem da página ---- */

  function setupExamples() {
    const sel = $('#examples');
    const list = typeof KSWEB_EXAMPLES !== 'undefined' ? KSWEB_EXAMPLES : [];
    for (const ex of list) {
      const o = document.createElement('option');
      o.value = ex.name;
      o.textContent = ex.title + (ex.stdin ? ' ⌨' : '');
      o.title = ex.desc;
      sel.appendChild(o);
    }
    sel.addEventListener('change', () => {
      const ex = list.find((e) => e.name === sel.value);
      sel.value = '';
      if (!ex) return;
      if ($('#opt-clear').checked) term.clear();
      if (ex.desc) sys(ex.desc);
      if (ex.stdin) sys('este exemplo lê da entrada: digite no terminal (Enter envia a linha; Ctrl+D = EOF).');
      loadImage(b64ToBytes(ex.b64), ex.name + '.ksx', true);
    });
  }

  function setupDrop() {
    const overlay = $('#drop');
    let depth = 0;
    window.addEventListener('dragenter', (e) => { e.preventDefault(); depth++; overlay.hidden = false; });
    window.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; overlay.hidden = true; } });
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => {
      e.preventDefault();
      depth = 0;
      overlay.hidden = true;
      const f = e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) openFile(f);
    });
  }

  function setupTermSize() {
    const apply = () => {
      const fit = $('#opt-fit').checked;
      term.fit = fit;
      $('#opt-cols').disabled = fit;
      $('#opt-rows').disabled = fit;
      if (fit) term.fitToContainer();
      else term.resize(Math.max(20, intVal('#opt-cols', 80)), Math.max(5, intVal('#opt-rows', 24)));
    };
    for (const id of ['#opt-fit', '#opt-cols', '#opt-rows']) $(id).addEventListener('change', apply);
    apply();
  }

  function init() {
    term = new TerminalView($('#term'), {
      cols: 80, rows: 24, scrollback: 5000,
      onData: (s) => sendInput(s),
      onEof: () => sendEof(),
      onInterrupt: () => { pause(); sys('VM interrompida (Ctrl+Alt+C)'); },
      onTitle: (t) => { $('#term-title').textContent = t; },
      onResize: (c, r) => { $('#term-size').textContent = c + '×' + r; }
    });
    dbg = new DebuggerPanel($('#debugger'), { send, run, pause, step, restart: () => restart(false) });
    dbg.el.hidden = true;

    $('#file').addEventListener('change', (e) => { const f = e.target.files[0]; if (f) openFile(f); e.target.value = ''; });
    $('#btn-open').addEventListener('click', () => $('#file').click());
    $('#btn-run').addEventListener('click', run);
    $('#btn-stop').addEventListener('click', pause);
    $('#btn-restart').addEventListener('click', () => restart($('#opt-autorun').checked));
    $('#btn-step').addEventListener('click', () => step(1));
    $('#btn-dbg').addEventListener('click', () => toggleDebugger());
    $('#btn-eof').addEventListener('click', () => { sendEof(); sys('EOF enviado'); });
    $('#btn-clear').addEventListener('click', () => term.clear());
    $('#stdin-file-btn').addEventListener('click', () => $('#stdin-file').click());
    $('#stdin-file').addEventListener('change', async (e) => {
      const f = e.target.files[0];
      e.target.value = '';
      if (!f) return;
      const bytes = await readFile(f);
      send({ type: 'input', bytes: bytes.buffer }, [bytes.buffer]);
      if ($('#opt-stdin-eof').checked) send({ type: 'eof' });
      sys('stdin: ' + f.name + ' (' + bytes.length + ' bytes)' + ($('#opt-stdin-eof').checked ? ' + EOF' : ''));
    });
    $('#opt-mode').addEventListener('change', (e) => {
      term.setLineMode(e.target.value === 'line');
      $('#mode-hint').textContent = e.target.value === 'line' ? 'linha (eco local)' : 'raw';
    });
    $('#opt-bs').addEventListener('change', (e) => { term.backspace = e.target.value === 'bs' ? '\b' : '\x7f'; });
    $('#opt-poll').addEventListener('change', (e) => send({ type: 'config', stdinBlock: !e.target.checked }));
    $('#opt-slice').addEventListener('change', () => send({ type: 'config', slice: runOpts().slice }));
    $('#btn-copy-all').addEventListener('click', () => {
      const t = term.allText();
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(t).then(() => sys('terminal copiado'), () => download('terminal.txt', t));
      } else {
        download('terminal.txt', t);
      }
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'F8') { e.preventDefault(); if (['running', 'sleeping', 'waiting'].includes(state.vmState)) pause(); else run(); }
      else if (e.key === 'F10') { e.preventDefault(); step(1); }
      else if (e.key === 'F9' && e.shiftKey === false && e.ctrlKey) { e.preventDefault(); toggleDebugger(); }
    });
    setupExamples();
    setupDrop();
    setupTermSize();
    setState('idle');
    term.el.focus({ preventScroll: true });
    boot();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
