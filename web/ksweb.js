/*
 * ksweb.js — controlador da IDE: projeto e explorador, editor com abas,
 * montagem/lint pelo worker do assembler (asm-worker.js: ksas.wasm e
 * ksdis.wasm), execução e depuração em nível de fonte pelo worker da VM
 * (worker.js: ksvm.wasm), terminal, painéis e barra de status.
 *
 * Duas formas de distribuição:
 *   dist/index.html        busca os .wasm com fetch e cria worker.js e
 *                          asm-worker.js
 *   dist/ksweb-single.html wasm em base64 (KSWEB_WASM_B64, KSWEB_KSAS_B64,
 *                          KSWEB_KSDIS_B64) e o código dos workers em
 *                          <script type="text/js-worker">: abre com clique duplo
 *
 * Modo simples: um .ksx (arrastado, aberto pelo menu ou exemplo) roda
 * direto, com o desassembly do ksdis no lugar do editor.
 */
(function () {
  'use strict';
  /* global TerminalView, DebuggerPanel, KsFormat, parseSymbols, KSWEB_EXAMPLES, KSWEB_ISA, pageShortcut,
     ideShortcut, KsEditor, KsLayout, KsProject, KsasmLang, AsmTools, IsaRef */
  const $ = (s) => document.querySelector(s);
  const F = KsFormat;
  const { Project, ProjectStore } = KsProject;
  const hex8 = (v) => '0x' + F.hex(v >>> 0);

  const DEFAULT_MAIN = [
    '; main.ksasm — um programa KSVM para começar.',
    '; Ctrl+B monta, F5 executa, F9 marca breakpoint, F10/F11 avançam (F1: atalhos).',
    '',
    '        .text',
    '        .global _start',
    '_start:',
    '        la      r1, msg',
    '        call    puts            ; F11 entra, F10 passa por cima',
    '        li      r1, 0',
    '        halt',
    '',
    '; puts(r1 = string terminada em 0): escreve com a syscall PUTS',
    'puts:',
    '        mov     r5, r1',
    'puts_len:',
    '        ldb     r6, [r5]',
    '        cmpi    r6, 0',
    '        beq     puts_out',
    '        inc     r5',
    '        b       puts_len',
    'puts_out:',
    '        sub     r2, r5, r1      ; comprimento',
    '        syscall PUTS            ; r1 = ponteiro, r2 = bytes',
    '        ret',
    '',
    '        .data',
    'msg:    .asciz  "Olá, KSVM!\\n"',
    ''
  ].join('\n');

  const S = {
    worker: null, wasm: null, ready: false,
    asm: { worker: null, ready: false, seq: 0, pending: new Map(), ksas: null, ksdis: null },
    store: null, project: null, version: 0,
    lint: null, built: null, diags: new Map(), codeLines: new Map(),
    image: null, imageName: '', imageSource: null, imageVersion: -1, header: null,
    vmState: 'idle', loaded: false, pendingRun: false, stopAtEntry: false, debugSession: false,
    ksxMode: false, disRows: [], disImage: null, pc: null, insns: 0, ips: 0,
    memSeq: 2000000, memWait: new Map(), watches: [], saveTimer: null, lintTimer: null, events: []
  };
  let term, dbg, editor, layout;

  /* ---- utilidades ---- */

  function b64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  const enc = new TextEncoder();
  function sys(text, kind) { term.writeSystem(text, kind); }
  function send(msg, transfer) { if (S.worker) S.worker.postMessage(msg, transfer || []); }
  function intVal(sel, def) {
    const v = parseInt($(sel).value, 10);
    return Number.isFinite(v) && v >= 0 ? v : def;
  }
  function runOpts() {
    return {
      ramSize: intVal('#opt-ram', 1024) * 1024, stackSize: intVal('#opt-stack', 0), maxInsns: intVal('#opt-limit', 0),
      slice: Math.max(1, intVal('#opt-slice', 200000)), stdinBlock: !$('#opt-poll').checked
    };
  }
  function h(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    for (const k in attrs || {}) {
      if (k === 'class') e.className = attrs[k];
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] !== false && attrs[k] !== null && attrs[k] !== undefined) e.setAttribute(k, attrs[k]);
    }
    for (const c of kids) if (c !== null && c !== undefined) e.append(c);
    return e;
  }
  let msgTimer = null;
  function status(text, sticky) {
    $('#sb-msg').textContent = text;
    clearTimeout(msgTimer);
    if (!sticky) msgTimer = setTimeout(() => { $('#sb-msg').textContent = ''; }, 8000);
  }
  function download(name, data, type) {
    const url = URL.createObjectURL(new Blob([data], { type: type || 'text/plain' }));
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
  function readFile(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(new Uint8Array(r.result));
      r.onerror = () => reject(r.error);
      r.readAsArrayBuffer(file);
    });
  }
  const fmtIps = (ips) => (ips >= 1e6 ? (ips / 1e6).toFixed(1) + ' M instr/s' : ips.toLocaleString('pt-BR') + ' instr/s');

  /* ---- estado da VM e botões ---- */

  const STATE_TEXT = {
    idle: 'sem programa', ready: 'pronto', running: 'executando', sleeping: 'executando (SLEEP)',
    waiting: 'esperando entrada', paused: 'pausado', break: 'parado', done: 'terminou', error: 'erro'
  };
  const isActive = () => ['running', 'sleeping', 'waiting'].includes(S.vmState);
  const isStopped = () => S.loaded && ['ready', 'paused', 'break'].includes(S.vmState);

  function setState(s, extra) {
    S.vmState = s;
    for (const b of [$('#status'), $('#sb-state')]) {
      b.textContent = STATE_TEXT[s] + (extra ? ' — ' + extra : '');
      b.dataset.state = s;
    }
    const hasProg = !!(S.project && S.project.main) || S.imageSource === 'ksx';
    $('#btn-run').disabled = isActive() || !(hasProg || S.image);
    $('#btn-debug').disabled = isActive() || !hasProg && !S.image;
    $('#btn-build').disabled = !S.asm.ready || !(S.project && S.project.main);
    $('#btn-stop').disabled = !isActive();
    $('#btn-restart').disabled = !S.image && !hasProg;
    $('#btn-continue').disabled = !isStopped();
    $('#btn-step-over').disabled = isActive() || !(hasProg || S.image);
    $('#btn-step-into').disabled = isActive() || !(hasProg || S.image);
    $('#btn-step-out').disabled = !isStopped();
    $('#btn-eof').disabled = !S.loaded;
    $('#stdin-file-btn').disabled = !S.loaded;
    document.body.classList.toggle('waiting-input', s === 'waiting');
    if (isActive()) editor.setDebugLine(null, null);
    updateStale();
  }

  function updateStale() {
    const stale = S.loaded && S.imageSource === 'build' && S.imageVersion !== S.version && S.vmState !== 'done';
    $('#stale').hidden = !stale;
  }

  function updateStatusBar() {
    $('#sb-pc').textContent = 'pc ' + (S.pc === null ? '—' : hex8(S.pc));
    $('#sb-insns').textContent = S.insns.toLocaleString('pt-BR') + ' instr' + (S.ips && isActive() ? ' · ' + fmtIps(S.ips) : '');
    $('#sb-size').textContent = S.image ? 'imagem ' + S.image.length + ' B' : '—';
  }

  /* ---- workers ---- */

  function createWorker(srcId, file) {
    const src = document.getElementById(srcId);
    if (src) return new Worker(URL.createObjectURL(new Blob([src.textContent], { type: 'text/javascript' })));
    return new Worker(file);
  }

  async function loadBytes(file, b64name) {
    if (typeof window[b64name] === 'string') return b64ToBytes(window[b64name]);
    const r = await fetch(file);
    if (!r.ok) throw new Error(file + ': HTTP ' + r.status);
    return new Uint8Array(await r.arrayBuffer());
  }

  async function boot() {
    try {
      [S.wasm, S.asm.ksas, S.asm.ksdis] = await Promise.all([
        loadBytes('ksvm.wasm', 'KSWEB_WASM_B64'), loadBytes('ksas.wasm', 'KSWEB_KSAS_B64'), loadBytes('ksdis.wasm', 'KSWEB_KSDIS_B64')]);
    } catch (e) {
      sys('não consegui carregar os módulos wasm (' + e.message + ').', 'error');
      if (location.protocol === 'file:') sys('Abrindo por file://, o navegador bloqueia fetch: use ksweb-single.html ou "make serve".', 'error');
      setState('error');
      return;
    }
    try {
      S.worker = createWorker('ksweb-worker-src', 'worker.js');
      S.asm.worker = createWorker('ksweb-asm-worker-src', 'asm-worker.js');
    } catch (e) {
      sys('não consegui criar os Web Workers (' + e.message + '). Use ksweb-single.html ou "make serve".', 'error');
      setState('error');
      return;
    }
    S.worker.onmessage = (ev) => onWorker(ev.data);
    S.worker.onerror = (ev) => { sys('erro no worker da VM: ' + (ev.message || ev), 'error'); setState('error'); };
    S.asm.worker.onmessage = (ev) => onAsm(ev.data);
    S.asm.worker.onerror = (ev) => { sys('erro no worker do assembler: ' + (ev.message || ev), 'error'); };
    const w = S.wasm.slice();
    send({ type: 'init', wasm: w.buffer }, [w.buffer]);
    const a = S.asm.ksas.slice(), d = S.asm.ksdis.slice();
    S.asm.worker.postMessage({ type: 'init', ksas: a.buffer, ksdis: d.buffer, isa: typeof KSWEB_ISA !== 'undefined' ? KSWEB_ISA : null }, [a.buffer, d.buffer]);
  }

  function asmCall(msg) {
    return new Promise((resolve) => {
      const id = ++S.asm.seq;
      S.asm.pending.set(id, resolve);
      S.asm.worker.postMessage(Object.assign({ id }, msg));
    });
  }

  function onAsm(m) {
    if (m.type === 'ready') {
      S.asm.ready = true;
      status('assembler pronto (ksas.wasm ' + S.asm.ksas.length + ' B, ksdis.wasm ' + S.asm.ksdis.length + ' B)');
      setState(S.vmState);
      scheduleLint(0);
      return;
    }
    if (m.type === 'fatal') { sys(m.message, 'error'); return; }
    const res = S.asm.pending.get(m.id);
    if (res) { S.asm.pending.delete(m.id); res(m); }
  }

  /* Últimos eventos (mensagens do worker da VM e abas abertas), para
   * depurar a própria IDE: ksweb.state.events no console. */
  function note(s) {
    S.events.push(Math.round(performance.now()) + ' ' + s);
    if (S.events.length > 80) S.events.shift();
  }

  function onWorker(m) {
    if (m.type !== 'output' && m.type !== 'progress') note('vm ' + m.type + (m.state ? ' ' + m.state : '') + (m.cpu ? ' pc=' + hex8(m.cpu.pc) : m.pc !== undefined ? ' pc=' + hex8(m.pc) : ''));
    switch (m.type) {
      case 'ready':
        S.ready = true;
        $('#version').textContent = 'KSVM ' + m.version;
        sys('KSVM ' + m.version + ' em WebAssembly. Edite e monte (Ctrl+B), execute (F5) ou arraste um .ksx.');
        dbg.sync();
        setState(S.loaded ? S.vmState : 'idle');
        if (S.image && S.pendingLoad) { S.pendingLoad = false; loadImage(S.image, S.imageName, S.pendingRun); }
        break;
      case 'fatal':
        sys('erro no worker: ' + m.message, 'error');
        setState('error');
        break;
      case 'loaded':
        if (!m.ok) {
          S.loaded = false;
          sys(S.imageName + ': ' + m.info.message + ' (código ' + m.info.code + ')', 'error');
          setState('done', 'código ' + m.info.code);
          break;
        }
        S.loaded = true;
        S.header = m.header;
        S.insns = 0;
        S.pc = m.header.entry;
        for (const l of F.headerLines(m.header, S.imageName)) sys(l);
        dbg.setImage(m.header, m.regions, parseSymbols(S.image, m.header.symOff, m.header.symSize));
        dbg.sync();
        setState('ready');
        updateStatusBar();
        if (S.pendingRun) { S.pendingRun = false; send({ type: 'run', slice: runOpts().slice }); }
        else if (S.stopAtEntry) { dbg.reason('parado na entrada ' + hex8(m.header.entry)); send({ type: 'snapshot' }); }
        break;
      case 'output':
        term.write(m.bytes);
        break;
      case 'status':
        onStatus(m);
        break;
      case 'progress':
        S.insns = m.insns; S.ips = m.ips;
        dbg.stats(m.insns, m.ips);
        $('#insns').textContent = m.insns.toLocaleString('pt-BR') + ' instr' + (m.ips ? ' · ' + fmtIps(m.ips) : '');
        updateStatusBar();
        break;
      case 'snapshot':
        dbg.snapshot(m);
        S.pc = m.cpu.pc;
        S.insns = m.insns;
        updateStatusBar();
        if (S.vmState === 'done') { if (m.fault) showPc(m.fault.pc, true); }
        else if (!isActive()) showPc(m.cpu.pc, !!m.fault);
        else if (S.vmState === 'waiting') showPc(m.cpu.pc, false, true);
        break;
      case 'stepped':
        S.pc = m.cpu.pc;
        break;
      case 'mem': {
        const w = S.memWait.get(m.id);
        if (w) { S.memWait.delete(m.id); w(m); } else dbg.memData(m);
        break;
      }
      case 'trace-text':
        download('trace.txt', m.text);
        sys('trace exportado: ' + m.count + ' registros' + (m.total > m.count ? ' (os últimos de ' + m.total + ')' : ''));
        break;
      default:
        break;
    }
  }

  function onStatus(m) {
    if (m.pc !== undefined) S.pc = m.pc;
    if (m.insns !== undefined) S.insns = m.insns;
    updateStatusBar();
    if (m.state === 'done') {
      const info = m.info;
      if (info.kind === 'fault') sys(info.message, 'error');
      else if (info.kind === 'limit') sys(info.message, 'error');
      sys('fim: código de saída ' + info.code + ' · ' + m.insns.toLocaleString('pt-BR') + ' instruções', info.code === 0 ? 'ok' : 'error');
      if ($('#opt-regs').checked && m.cpu) sys(F.regsDump(m.cpu).replace(/\n$/, ''));
      setState('done', 'código ' + info.code);
      if (info.kind === 'fault') {
        if ($('#opt-dbg-on-fault').checked) { layout.collapse('right', false); layout.showRight('debugger'); }
        showPc(info.fault ? info.fault.pc : m.pc, true);
      } else {
        editor.setDebugLine(null, null);
        renderDisasmPc(null);
      }
      return;
    }
    if (m.state === 'break') {
      const why = m.reason === 'step' ? 'passo' : m.reason;
      dbg.reason('parado: ' + why + ' em ' + hex8(m.pc));
      setState('break', why + ' em ' + hex8(m.pc));
      return;
    }
    if (m.state === 'paused') dbg.reason('pausado em ' + hex8(m.pc));
    if (m.state === 'running' || m.state === 'waiting') dbg.reason(m.stepping ? (m.stepping === 'out' ? 'saindo da função…' : 'passo por cima…') : '');
    setState(m.state);
    if (m.state === 'waiting') {
      layout.showPanel('terminal');
      term.el.focus({ preventScroll: true });
    }
  }

  /* ---- linha atual da depuração ---- */

  /*
   * Mapas linha <-> endereço. Cada montagem (S.built) guarda os textos que
   * montou e, por arquivo, a ChangeSet do CodeMirror composta com todas as
   * edições desde então (onDocChanges). S.run é a montagem da imagem que
   * está na VM: um Ctrl+B durante a depuração cria outro S.built, mas
   * breakpoints e linha atual continuam no mapa de S.run até a nova imagem
   * ser carregada (Executar/Reiniciar). Linha atual -> linha da montagem ->
   * endereço, e o caminho inverso, por AsmTools.curLineToBuild /
   * buildLineToCur; linha nova (ou arquivo sem mapa) = breakpoint pendente.
   */
  function newBuildMap(result, version) {
    return { result, version, texts: new Map(projectFiles()), changes: new Map() };
  }

  /* o mapa que vale para a VM: o da imagem carregada, ou o da última
   * montagem quando não há imagem montada na VM */
  function mapRun() { return S.imageSource === 'build' && S.run ? S.run : S.built; }

  function onDocChanges(name, cs) {
    for (const run of new Set([S.built, S.run])) {
      if (!run || !run.texts.has(name)) continue;
      const prev = run.changes.get(name);
      if (prev === null) continue;                              /* já sem mapa */
      if (cs === null) run.changes.set(name, null);
      else if (prev === undefined) run.changes.set(name, cs.length === run.texts.get(name).length ? cs : null);
      else run.changes.set(name, prev.newLength === cs.length ? prev.compose(cs) : null);
    }
    if (S.run && S.loaded) scheduleBpSync();
  }

  function toBuildLine(run, file, line) {
    if (!run || !run.texts.has(file) || !S.project.has(file)) return null;
    return AsmTools.curLineToBuild(run.changes.get(file), S.project.text(file), run.texts.get(file), line);
  }

  function toCurLine(run, file, line) {
    if (!run || !run.texts.has(file) || !S.project.has(file)) return null;
    return AsmTools.buildLineToCur(run.changes.get(file), run.texts.get(file), S.project.text(file), line);
  }

  function showPc(pc, fault, quiet) {
    S.pc = pc;
    updateStatusBar();
    renderDisasmPc(pc);
    const run = S.imageSource === 'build' ? S.run : null;
    const loc = run && run.result.info.addrLine.get(pc >>> 0);
    const line = loc && !S.ksxMode ? toCurLine(run, loc.file, loc.line) : null;
    if (line !== null) {
      openTab(loc.file);
      editor.setDebugLine(loc.file, line);
      if (!quiet) status((fault ? 'fault em ' : 'parado em ') + loc.file + ':' + line + ' (' + hex8(pc) + ')');
    } else {
      editor.setDebugLine(null, null);
      if (loc && !quiet) status((fault ? 'fault em ' : 'parado em ') + hex8(pc) + ': a linha ' + loc.line + ' de ' + loc.file + ' mudou desde a montagem (veja o Desassembly)');
      if (S.loaded && !S.ksxMode && !quiet) layout.showPanel('disasm');
    }
  }

  /* ---- montagem e lint ---- */

  function projectFiles() {
    return S.project.fileNames().map((n) => [n, S.project.text(n)]);
  }

  async function assemble(main) {
    const m = await asmCall({ type: 'assemble', files: projectFiles(), main: main || S.project.main, debug: $('#opt-g').checked });
    return m.result;
  }

  function scheduleLint(ms) {
    clearTimeout(S.lintTimer);
    if (!$('#opt-lint').checked && ms !== 0) return;
    S.lintTimer = setTimeout(runLint, ms === undefined ? 300 : ms);
  }

  async function runLint() {
    if (!S.asm.ready || !S.project || !S.project.main) { applyDiagnostics(null); return; }
    const v = S.version, proj = S.project;
    const r = await assemble();
    if (v !== S.version || proj !== S.project) return;
    S.lint = { result: r, version: v };
    let extra = [];
    /* arquivo ativo fora da montagem do principal (ex.: biblioteca sem
     * .include no principal): monta-o sozinho para o lint */
    const act = editor.active;
    /* sem listing (a montagem falhou), o alcance vem dos .include: um
     * incluído não é montado sozinho por causa de um erro no principal (os
     * símbolos do principal apareceriam como indefinidos nele) */
    const covered = (r.info ? r.info.files.includes(act) : AsmTools.includeClosure(new Map(projectFiles()), proj.main).has(act)) ||
      r.diagnostics.some((d) => d.file === act);
    if (act && act !== proj.main && !covered && /\.(ksasm|asm|s|inc)$/i.test(act)) {
      const r2 = await assemble(act);
      if (v !== S.version || proj !== S.project) return;
      extra = r2.diagnostics.filter((d) => d.file === act);
    }
    applyDiagnostics(r, extra);
    if (r.ok) applyCodeLines(r.info);
  }

  function applyDiagnostics(r, extra) {
    const all = r ? r.diagnostics.concat(extra || []) : [];
    const byFile = new Map();
    for (const d of all) {
      if (d.severity === 'info') continue;
      const f = d.file && S.project.has(d.file) ? d.file : null;
      if (!f) continue;
      if (!byFile.has(f)) byFile.set(f, []);
      byFile.get(f).push(d);
    }
    for (const n of S.project.fileNames()) {
      const list = byFile.get(n) || [];
      const had = S.diags.get(n);
      if ((had && had.length) || list.length) editor.setDiagnostics(n, list);
      S.diags.set(n, list);
    }
    renderProblems(all);
    renderExplorer();
  }

  function applyCodeLines(info) {
    S.codeLines = new Map();
    for (const n of S.project.fileNames()) {
      const lines = info.code.get(n) || [];
      const list = lines.map((l) => ({ line: l, addr: info.lines.get(n + '\n' + l).addr }));
      S.codeLines.set(n, list);
      editor.setCodeLines(n, list);
    }
  }

  function renderProblems(all) {
    const ul = $('#problems');
    ul.textContent = '';
    const errs = all.filter((d) => d.severity !== 'info');
    for (const d of errs) {
      const loc = d.file ? d.file + (d.line ? ':' + d.line + (d.col ? ':' + d.col : '') : '') : 'ksas';
      const li = h('li', { tabindex: '0', title: d.text || d.message },
        h('span', { class: 'sev' }, '✖'), h('span', { class: 'loc' }, loc), h('span', {}, d.message));
      const go = () => {
        if (d.file && S.project.has(d.file)) {
          openTab(d.file);
          const ln = editor.view.state.doc.line(Math.max(1, Math.min(d.line || 1, editor.view.state.doc.lines)));
          editor.gotoLine(d.file, d.line || 1, d.col ? AsmTools.byteColToChar(ln.text, d.col) + 1 : 1);
        }
      };
      li.addEventListener('click', go);
      li.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
      ul.append(li);
    }
    if (!errs.length) ul.append(h('li', { class: 'empty' }, all.length || S.lint ? 'Nenhum problema.' : 'Monte o projeto para ver os problemas.'));
    const c = $('#problem-count');
    c.textContent = String(errs.length);
    c.classList.toggle('err', errs.length > 0);
  }

  async function build(quiet) {
    if (!S.asm.ready) { status('o assembler ainda está carregando…'); return null; }
    if (!S.project.main) { status('o projeto não tem arquivo principal'); return null; }
    clearTimeout(S.lintTimer);
    const v = S.version;
    const r = S.lint && S.lint.version === v && S.lint.result.ok ? S.lint.result : await assemble();
    if (v !== S.version) return build(quiet);
    S.lint = { result: r, version: v };
    applyDiagnostics(r);
    if (!r.ok) {
      const n = r.diagnostics.filter((d) => d.severity !== 'info').length;
      status('montagem falhou: ' + n + ' erro(s)', true);
      layout.showPanel('problems');
      return null;
    }
    applyCodeLines(r.info);
    S.built = newBuildMap(r, v);
    $('#asm-output').textContent = r.listingText || '(listing vazio)';
    resolveBreakpoints(true);
    disassembleImage(r.image);
    status('montado: ' + S.project.main + ' → ' + r.image.length + ' bytes em ' + Math.max(1, Math.round(r.ms)) + ' ms' + (quiet ? '' : ' (Saída da montagem e Desassembly atualizados)'));
    return r;
  }

  async function disassembleImage(image) {
    S.disImage = image;
    const m = await asmCall({ type: 'disassemble', image: image.slice().buffer });
    if (S.disImage !== image) return;
    S.disRows = m.ok ? m.rows : [{ text: m.stderr || 'ksdis falhou', addr: null }];
    renderDisasm();
  }

  /* ---- desassembly (painel inferior e modo .ksx) ---- */

  function renderDisasmInto(box) {
    box.textContent = '';
    const frag = document.createDocumentFragment();
    for (const r of S.disRows) {
      const bp = r.code && dbg.hasBp(r.addr);
      const cls = 'dr' + (r.code ? ' code' : '') + (r.label ? ' lbl' : '') + (/^;/.test(r.text) ? ' hdr' : '');
      const d = h('div', { class: cls }, h('span', { class: 'dot' }, bp ? '●' : ' '), r.text);
      if (r.code) {
        d.dataset.addr = String(r.addr);
        d.addEventListener('click', () => { dbg.toggleBp(r.addr); renderDisasm(); });
      }
      frag.append(d);
    }
    box.append(frag);
  }

  function renderDisasm() {
    renderDisasmInto($('#disasm'));
    if (S.ksxMode) renderDisasmInto($('#ksx-dis'));
    renderDisasmPc(S.loaded && !isActive() ? S.pc : null);
  }

  function renderDisasmPc(pc) {
    for (const box of [$('#disasm'), $('#ksx-dis')]) {
      for (const e of box.querySelectorAll('.dr.cur')) e.classList.remove('cur');
      if (pc === null || pc === undefined) continue;
      const row = box.querySelector('.dr.code[data-addr="' + (pc >>> 0) + '"]');
      if (row) {
        row.classList.add('cur');
        if (box.offsetParent) box.scrollTop = row.offsetTop - box.clientHeight / 2;
      }
    }
  }

  /* ---- breakpoints ---- */

  /* [{file, line, addr, moved, pending}] dos breakpoints de fonte (linhas
   * atuais), resolvidos pelo mapa da imagem carregada (mapRun). pending:
   * a linha é nova desde aquela montagem; não vai para a VM até remontar. */
  function breakpointList() {
    if (!S.project) return [];
    const out = [];
    const run = mapRun();
    const pend = new Map();
    for (const [file, lines] of S.project.breakpoints) {
      for (const line of lines) {
        let r = null, pending = false;
        if (run && run.texts.has(file)) {
          const bl = toBuildLine(run, file, line);
          if (bl === null) pending = true;
          else r = AsmTools.resolveBreakpoint(run.result.info, file, bl);
        }
        if (pending) { if (!pend.has(file)) pend.set(file, []); pend.get(file).push(line); }
        out.push({ file, line, addr: r ? r.addr : null, moved: S.bpMoved && S.bpMoved.get(file + ':' + line), pending });
      }
    }
    showPending(pend);
    return out;
  }

  /* marcas vazadas no gutter (fora da atualização em curso do editor) */
  function showPending(pend) {
    const key = JSON.stringify([...pend]);
    if (key === S.pendKey) return;
    S.pendKey = key;
    queueMicrotask(() => {
      for (const n of S.project.fileNames()) editor.setPendingLines(n, pend.get(n) || []);
    });
  }

  let bpSyncTimer = null;
  function scheduleBpSync() {
    clearTimeout(bpSyncTimer);
    bpSyncTimer = setTimeout(() => dbg.sync(), 150);
  }

  /* Linhas sem código: o breakpoint vai para a próxima linha com código. */
  function resolveBreakpoints(move) {
    if (move && S.built && S.built.version === S.version) {
      const info = S.built.result.info;
      for (const [file, lines] of [...S.project.breakpoints]) {
        const next = [];
        let changed = false;
        for (const line of lines) {
          const r = AsmTools.resolveBreakpoint(info, file, line);
          if (r && r.moved) {
            changed = true;
            next.push(r.line);
            S.bpMoved.set(file + ':' + r.line, line);
            status('breakpoint movido de ' + file + ':' + line + ' para a linha ' + r.line + ' (a linha ' + line + ' não gera código)');
          } else next.push(line);
        }
        if (changed) {
          S.project.setBreakpoints(file, next);
          editor.setBreakpoints(file, S.project.breakpoints.get(file) || []);
          scheduleSave();
        }
      }
    }
    dbg.sync();
    if (S.disRows.length) renderDisasm();
  }

  function onEditorBreakpoints(file, lines) {
    const old = S.project.breakpoints.get(file) || [];
    for (const l of lines) if (!old.includes(l)) S.bpMoved.delete(file + ':' + l);
    S.project.setBreakpoints(file, lines);
    scheduleSave();
    resolveBreakpoints(true);
  }

  function addAddrBreakpoint(addr) {
    /* o desassembly do painel é o da última montagem (mesmo sem imagem
     * carregada); a linha dela vai para a linha atual do fonte */
    const run = S.ksxMode || S.imageSource === 'ksx' && S.loaded ? null : S.built;
    const loc = run && run.result.info.addrLine.get(addr >>> 0);
    const line = loc ? toCurLine(run, loc.file, loc.line) : null;
    if (line !== null) {
      const lines = (S.project.breakpoints.get(loc.file) || []).concat([line]);
      S.project.setBreakpoints(loc.file, lines);
      editor.setBreakpoints(loc.file, S.project.breakpoints.get(loc.file));
      scheduleSave();
      return;
    }
    dbg.bps.add(addr >>> 0);
  }

  function removeBreakpoint(b) {
    if (!b.file) { dbg.bps.delete(b.addr); return; }
    const lines = (S.project.breakpoints.get(b.file) || []).filter((l) => l !== b.line);
    S.project.setBreakpoints(b.file, lines);
    editor.setBreakpoints(b.file, lines);
    scheduleSave();
  }

  function clearBreakpoints() {
    for (const f of [...S.project.breakpoints.keys()]) { S.project.setBreakpoints(f, []); editor.setBreakpoints(f, []); }
    scheduleSave();
  }

  /* ---- execução ---- */

  function loadImage(bytes, name, autoRun) {
    S.image = bytes;
    S.imageName = name;
    S.loaded = false;
    S.pendingRun = !!autoRun;
    $('#prog-name').textContent = name;
    updateStatusBar();
    if (!S.worker || !S.ready) { S.pendingLoad = true; return; }
    sys('carregando ' + name + ' (' + bytes.length + ' bytes)');
    const copy = bytes.slice();
    send({ type: 'load', image: copy.buffer, opts: runOpts() }, [copy.buffer]);
  }

  async function startProgram(stopAtEntry) {
    S.debugSession = stopAtEntry;
    S.stopAtEntry = stopAtEntry;
    if (S.ksxMode && S.imageSource === 'ksx') {
      if ($('#opt-clear').checked) term.clear();
      layout.showPanel('terminal');
      loadImage(S.image, S.imageName, !stopAtEntry);
      return;
    }
    const r = S.built && S.built.version === S.version ? S.built.result : await build(true);
    if (!r) return;
    S.imageSource = 'build';
    S.imageVersion = S.built.version;
    S.run = S.built;
    if ($('#opt-clear').checked) term.clear();
    if (stopAtEntry) { layout.collapse('right', false); layout.showRight('debugger'); }
    else layout.showPanel('terminal');
    loadImage(r.image, S.project.main.replace(/\.[^./]*$/, '') + '.ksx', !stopAtEntry);
  }

  function run() {
    if (isStopped() && S.vmState !== 'ready') { cont(); return; }
    if (isStopped() && S.vmState === 'ready' && S.imageSource && (S.imageSource === 'ksx' || S.imageVersion === S.version)) { cont(); return; }
    if (isActive()) return;
    startProgram(false);
  }
  function cont() {
    if (!isStopped()) return;
    layout.showPanel('terminal');
    term.el.focus({ preventScroll: true });
    editor.setDebugLine(null, null);
    send({ type: 'run', slice: runOpts().slice });
  }
  function pause() { if (isActive()) send({ type: 'pause' }); }
  function debugStart() { if (!isActive()) startProgram(true); }
  function restart() { if (isActive()) send({ type: 'pause' }); startProgram(S.debugSession); }
  function stepMode(mode) {
    if (!S.loaded || S.vmState === 'done' || S.vmState === 'idle') { startProgram(true); return; }
    if (isActive() && S.vmState !== 'waiting') return;
    send({ type: 'step', mode, n: 1 });
  }
  function stepN(n) { if (S.loaded && S.vmState !== 'done') send({ type: 'step', n }); }

  function sendInput(str) {
    if (!S.loaded) return;
    const b = enc.encode(str);
    send({ type: 'input', bytes: b.buffer }, [b.buffer]);
  }
  function sendEof() { if (S.loaded) send({ type: 'eof' }); }

  function memRead(addr, len) {
    return new Promise((resolve) => {
      const id = ++S.memSeq;
      S.memWait.set(id, resolve);
      send({ type: 'mem', addr: addr >>> 0, len, id });
      setTimeout(() => { if (S.memWait.delete(id)) resolve(null); }, 1500);
    });
  }

  /* ---- modo simples: .ksx sem fonte ---- */

  function openKsx(bytes, name) {
    S.ksxMode = true;
    S.imageSource = 'ksx';
    S.run = null;
    S.image = bytes;
    S.imageName = name;
    S.debugSession = false;
    S.stopAtEntry = false;
    $('#editor').hidden = true;
    $('#ksx-view').hidden = false;
    $('#ksx-name').textContent = name;
    $('#file-name').textContent = name;
    $('#sb-file').textContent = name;
    renderTabs();
    renderExplorer();
    editor.setDebugLine(null, null);
    if ($('#opt-clear').checked) term.clear();
    layout.showPanel('terminal');
    disassembleImage(bytes);
    loadImage(bytes, name, $('#opt-autorun').checked);
  }

  function leaveKsx() {
    if (!S.ksxMode) return;
    S.ksxMode = false;
    $('#editor').hidden = false;
    $('#ksx-view').hidden = true;
    if (S.built) disassembleImage(S.built.result.image);
  }

  /* ---- projeto, explorador e abas ---- */

  /* S.dirty: esta aba alterou o projeto desde o último salvamento. Só
   * então trocar de projeto ou fechar a página salva (flushSave): uma aba
   * ociosa não sobrescreve o que outra aba da IDE salvou no mesmo banco. */
  function scheduleSave(now) {
    S.dirty = true;
    clearTimeout(S.saveTimer);
    const doSave = async () => {
      S.dirty = false;
      try {
        await S.store.save(S.project);
        await S.store.setMeta('last', S.project.id);
        if (now) status('projeto salvo (' + S.store.kind + ')');
      } catch (e) { S.dirty = true; status('não consegui salvar: ' + e.message, true); }
    };
    if (now) return doSave();
    S.saveTimer = setTimeout(doSave, 400);
    return null;
  }

  function flushSave() {
    clearTimeout(S.saveTimer);
    return S.dirty && S.project && S.store ? scheduleSave(true) : Promise.resolve();
  }

  function onEdit(name, text) {
    if (!S.project.has(name)) return;
    if (S.project.setText(name, text)) {
      S.version++;
      scheduleSave();
      scheduleLint();
      updateStale();
    }
  }

  function setProject(p) {
    for (const n of [...editor.states.keys()]) editor.forget(n);
    editor.deactivate();
    S.project = p;
    S.dirty = false;                 /* p é o que está no banco */
    S.version++;
    S.lint = null;
    S.built = null;
    S.run = null;
    S.pendKey = null;
    S.diags = new Map();
    S.codeLines = new Map();
    S.bpMoved = new Map();
    S.disRows = [];
    dbg.bps.clear();
    leaveKsx();
    $('#proj-name').textContent = p.name;
    if (!p.open.length && p.main) p.open = [p.main];
    const first = p.active && p.has(p.active) ? p.active : p.open[0];
    if (first) openTab(first);
    else { renderTabs(); renderExplorer(); }
    S.watches = loadWatches();
    dbg.setWatches(S.watches);
    $('#asm-output').textContent = '(monte o projeto: Ctrl+B)';
    renderDisasm();
    renderProblems([]);
    dbg.sync();
    setState(S.vmState);
    scheduleLint(0);
    S.store.setMeta('last', p.id);
  }

  function openTab(name) {
    if (!S.project.has(name)) return;
    if (editor.active !== name) note('aba ' + name);
    leaveKsx();
    const fresh = !editor.has(name);
    S.project.openFile(name);
    editor.open(name, S.project.text(name));
    if (fresh) {
      editor.setBreakpoints(name, S.project.breakpoints.get(name) || []);
      if (S.diags.get(name)) editor.setDiagnostics(name, S.diags.get(name));
      if (S.codeLines.get(name)) editor.setCodeLines(name, S.codeLines.get(name));
      S.pendKey = null;                  /* reaplica as marcas de pendente */
      if (dbg) dbg.renderBreakpoints();
    }
    $('#file-name').textContent = name;
    $('#sb-file').textContent = name;
    renderTabs();
    renderExplorer();
  }

  function closeTab(name) {
    S.project.closeFile(name);
    if (editor.active === name) {
      const next = S.project.active;
      if (next) openTab(next);
      else { editor.deactivate(); $('#file-name').textContent = '—'; }
    }
    renderTabs();
    scheduleSave();
  }

  function renderTabs() {
    const box = $('#tabs');
    box.textContent = '';
    for (const n of S.project.open) {
      const sel = !S.ksxMode && n === editor.active;
      const t = h('div', { class: 'tab', role: 'tab', 'aria-selected': sel ? 'true' : 'false', tabindex: sel ? '0' : '-1', title: n },
        n === S.project.main ? h('span', { class: 'main-mark', title: 'principal' }, '★') : null,
        h('span', {}, n),
        (S.diags.get(n) || []).length ? h('span', { class: 'dot', title: 'erros' }, '●') : null,
        h('button', { class: 'x', 'aria-label': 'fechar ' + n, title: 'fechar', onclick: (e) => { e.stopPropagation(); closeTab(n); } }, '×'));
      t.addEventListener('click', () => openTab(n));
      t.addEventListener('auxclick', (e) => { if (e.button === 1) closeTab(n); });
      t.addEventListener('keydown', (e) => { if (e.key === 'Enter') openTab(n); });
      box.append(t);
    }
    if (S.ksxMode) box.append(h('div', { class: 'tab', role: 'tab', 'aria-selected': 'true' }, h('span', {}, S.imageName + ' (desassembly)')));
    $('#welcome').hidden = !!(S.project.open.length || S.ksxMode);
    if (!S.project.open.length && !S.ksxMode) {
      $('#welcome').textContent = S.project.files.size ? 'Abra um arquivo no explorador.' : 'Projeto vazio: crie um arquivo (＋) ou importe .ksasm/.zip.';
      $('#editor').hidden = true;
    } else if (!S.ksxMode) $('#editor').hidden = false;
  }

  function renderExplorer() {
    const ul = $('#explorer');
    ul.textContent = '';
    const p = S.project;
    for (const n of p.fileNames()) {
      const slash = n.lastIndexOf('/');
      const errs = (S.diags.get(n) || []).length;
      const li = h('li', { role: 'treeitem', tabindex: '0', class: n === editor.active && !S.ksxMode ? 'active' : '', 'aria-selected': n === editor.active ? 'true' : 'false', title: n + (n === p.main ? ' (principal)' : '') },
        h('span', { class: 'fname' }, slash >= 0 ? h('span', { class: 'dir' }, n.slice(0, slash + 1)) : null, n.slice(slash + 1)),
        n === p.main ? h('span', { class: 'main-mark', title: 'arquivo principal (montado)' }, '★') : null,
        errs ? h('span', { class: 'err-mark', title: errs + ' erro(s)' }, '✖' + errs) : null,
        h('span', { class: 'ops' },
          n !== p.main ? h('button', { title: 'tornar principal', 'aria-label': 'tornar ' + n + ' principal', onclick: (e) => { e.stopPropagation(); setMain(n); } }, '★') : null,
          h('button', { title: 'renomear (F2)', 'aria-label': 'renomear ' + n, onclick: (e) => { e.stopPropagation(); startRename(li, n); } }, '✎'),
          h('button', { title: 'duplicar', 'aria-label': 'duplicar ' + n, onclick: (e) => { e.stopPropagation(); duplicateFile(n); } }, '⧉'),
          h('button', { title: 'excluir (Delete)', 'aria-label': 'excluir ' + n, onclick: (e) => { e.stopPropagation(); deleteFile(n); } }, '🗑')));
      li.addEventListener('click', () => openTab(n));
      li.addEventListener('keydown', (e) => {
        if (e.target !== li) return;
        if (e.key === 'Enter') openTab(n);
        else if (e.key === 'F2') { e.preventDefault(); startRename(li, n); }
        else if (e.key === 'Delete') deleteFile(n);
        else if (e.key === 'ArrowDown' && li.nextElementSibling) li.nextElementSibling.focus();
        else if (e.key === 'ArrowUp' && li.previousElementSibling) li.previousElementSibling.focus();
      });
      ul.append(li);
    }
    if (S.imageSource === 'ksx' && S.imageName) {
      const li = h('li', { class: 'ksx' + (S.ksxMode ? ' active' : ''), tabindex: '0', title: 'imagem carregada (sem fonte)' }, h('span', { class: 'fname' }, S.imageName));
      li.addEventListener('click', () => { if (!S.ksxMode) { S.ksxMode = true; $('#editor').hidden = true; $('#ksx-view').hidden = false; disassembleImage(S.image); renderTabs(); renderExplorer(); } });
      ul.append(li);
    }
    $('#explorer-foot').textContent = p.files.size + ' arquivo(s)' + (S.store ? ' · salvo em ' + S.store.kind : '');
  }

  function startRename(li, name) {
    const inp = h('input', { value: name, 'aria-label': 'novo nome de ' + name });
    li.replaceChildren(inp);
    inp.focus();
    inp.setSelectionRange(name.lastIndexOf('/') + 1, name.replace(/\.[^./]*$/, '').length);
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      const to = inp.value.trim();
      if (ok && to && to !== name) {
        try {
          S.project.renameFile(name, to);
          editor.rename(name, to);
          for (const run of [S.built, S.run]) if (run && run.texts.has(name)) { run.texts.set(to, run.texts.get(name)); run.changes.set(to, null); }
          for (const k of [S.diags, S.codeLines]) if (k.has(name)) { k.set(to, k.get(name)); k.delete(name); }
          S.version++;
          scheduleSave();
          scheduleLint(0);
          if (editor.active === to) $('#file-name').textContent = to;
          status('renomeado: ' + name + ' → ' + to + (/\.include/.test([...S.project.files.values()].join('\n')) ? ' (confira os .include)' : ''));
        } catch (e) { status(e.message, true); }
      }
      renderExplorer();
      renderTabs();
    };
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') finish(true); else if (e.key === 'Escape') finish(false); });
    inp.addEventListener('blur', () => finish(true));
  }

  function newFile() {
    const base = S.project.uniqueName('novo.ksasm');
    try {
      S.project.addFile(base, '; ' + base + '\n        .text\n');
    } catch (e) { status(e.message, true); return; }
    S.version++;
    scheduleSave();
    openTab(base);
    const li = [...$('#explorer').children].find((x) => x.title.startsWith(base));
    if (li) startRename(li, base);
  }

  function duplicateFile(n) {
    const d = S.project.duplicateFile(n);
    S.version++;
    scheduleSave();
    openTab(d);
  }

  function deleteFile(n) {
    if (!confirm('Excluir ' + n + '? (não dá para desfazer)')) return;
    S.project.deleteFile(n);
    editor.forget(n);
    S.diags.delete(n);
    S.codeLines.delete(n);
    S.version++;
    scheduleSave();
    if (!editor.active && S.project.active) openTab(S.project.active);
    renderTabs();
    renderExplorer();
    scheduleLint(0);
    setState(S.vmState);
  }

  function setMain(n) {
    S.project.setMain(n);
    S.version++;
    scheduleSave();
    renderExplorer();
    renderTabs();
    scheduleLint(0);
    status(n + ' é o arquivo principal (é ele que o ksas monta)');
  }

  function watchKey() { return 'ksweb-ide:watch:' + (S.project ? S.project.id : ''); }
  function loadWatches() { try { return JSON.parse(localStorage.getItem(watchKey()) || '[]'); } catch (e) { return []; } }
  function saveWatches(list) { S.watches = list; try { localStorage.setItem(watchKey(), JSON.stringify(list)); } catch (e) { /* sem localStorage */ } }

  async function renderProjectMenu() {
    const box = $('#menu-projects');
    box.textContent = '';
    box.append(h('div', { class: 'menu-label' }, 'Abrir projeto'));
    for (const p of await S.store.list()) {
      const b = h('button', { role: 'menuitem', class: p.id === S.project.id ? 'current' : '' },
        p.name + ' ', h('span', { class: 'muted small' }, '(' + p.files + ' arq., ' + new Date(p.updated).toLocaleString('pt-BR') + ')'));
      b.addEventListener('click', async () => { closeMenu(); await switchProject(p.id); });
      box.append(b);
    }
  }

  async function switchProject(id) {
    if (id === S.project.id) return;
    await flushSave();
    const p = await S.store.load(id);
    if (p) { setProject(p); status('projeto ' + p.name + ' aberto'); }
  }

  async function newProject(name, files, main, example) {
    await flushSave();
    const p = Project.create(name, files, main);
    p.example = example || null;
    await S.store.save(p);
    setProject(p);
    return p;
  }

  async function openExample(ex) {
    if (!ex.files) {                         /* sem fonte: só a imagem */
      openKsx(b64ToBytes(ex.b64), ex.name + '.ksx');
      return;
    }
    await flushSave();
    const list = await S.store.list();
    const found = list.find((p) => p.example === ex.name);
    let p = found ? await S.store.load(found.id) : null;
    if (!p) p = await newProject('exemplo: ' + ex.name, ex.files, ex.main, ex.name);
    else setProject(p);
    if ($('#opt-clear').checked) term.clear();
    if (ex.desc) sys(ex.desc);
    if (ex.stdin) sys('este exemplo lê da entrada: digite no terminal (Enter envia a linha; Ctrl+D = EOF).');
    if ($('#opt-autorun').checked) {
      S.debugSession = false;
      const r = await build(true);
      if (r) {
        S.imageSource = 'build';
        S.imageVersion = S.built.version;
        S.run = S.built;
        layout.showPanel('terminal');
        loadImage(r.image, ex.name + '.ksx', true);
      }
    }
  }

  async function importFiles(fileList) {
    const files = [...fileList];
    for (const f of files) {
      const bytes = await readFile(f);
      if (/\.ksx$/i.test(f.name) || (bytes[0] === 0x4B && bytes[1] === 0x53 && bytes[2] === 0x58)) {
        openKsx(bytes, f.name);
        continue;
      }
      if (/\.zip$/i.test(f.name)) {
        try {
          const p = await KsProject.projectFromZip(bytes, f.name.replace(/\.zip$/i, ''));
          await flushSave();
          await S.store.save(p);
          setProject(p);
          status('projeto importado de ' + f.name + ': ' + p.files.size + ' arquivo(s)');
        } catch (e) { status(f.name + ': ' + e.message, true); }
        continue;
      }
      const text = new TextDecoder().decode(bytes);
      const name = f.name.replace(/[^\p{L}\p{N}_.\-]/gu, '_');
      if (S.project.has(name)) {
        if (!confirm(name + ' já existe no projeto. Substituir?')) continue;
        S.project.setText(name, text);
        editor.setText(name, text);
      } else {
        try { S.project.addFile(name, text); } catch (e) { status(name + ': ' + e.message, true); continue; }
      }
      S.version++;
      openTab(name);
      status('importado: ' + name);
    }
    scheduleSave();
    scheduleLint(0);
  }

  function exportZip() {
    download(S.project.name.replace(/[^\p{L}\p{N}_.\-]+/gu, '_') + '.zip', KsProject.projectToZip(S.project), 'application/zip');
    status('projeto exportado (.zip)');
  }

  function exportFiles() {
    const names = S.project.fileNames();
    names.forEach((n, i) => setTimeout(() => download(n.replace(/\//g, '_'), S.project.text(n)), i * 250));
    status(names.length + ' arquivo(s) baixados');
  }

  async function exportKsx() {
    const r = S.built && S.built.version === S.version ? S.built.result : await build(true);
    if (r) download(S.project.main.replace(/\.[^./]*$/, '').replace(/\//g, '_') + '.ksx', r.image, 'application/octet-stream');
  }

  /* ---- menu, diálogos ---- */

  function closeMenu() { $('#menu').hidden = true; $('#btn-menu').setAttribute('aria-expanded', 'false'); }

  async function menuAction(act) {
    closeMenu();
    switch (act) {
      case 'new-project': {
        const name = prompt('Nome do novo projeto:', 'projeto');
        if (name) await newProject(name.trim() || 'projeto', { 'main.ksasm': DEFAULT_MAIN }, 'main.ksasm');
        break;
      }
      case 'rename-project': renameProject(); break;
      case 'delete-project': {
        if (!confirm('Excluir o projeto "' + S.project.name + '"? (não dá para desfazer)')) break;
        const id = S.project.id;
        await S.store.remove(id);
        const rest = await S.store.list();
        if (rest.length) setProject(await S.store.load(rest[0].id));
        else await newProject('meu-projeto', { 'main.ksasm': DEFAULT_MAIN }, 'main.ksasm');
        break;
      }
      case 'import-files': $('#file').click(); break;
      case 'export-zip': exportZip(); break;
      case 'export-files': exportFiles(); break;
      case 'export-ksx': exportKsx(); break;
      case 'open-ksx': $('#file-ksx').click(); break;
      case 'new-file': newFile(); break;
      default: break;
    }
  }

  function renameProject() {
    const el = $('#proj-name');
    el.contentEditable = 'true';
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    const finish = (ok) => {
      el.contentEditable = 'false';
      el.removeEventListener('keydown', onKey);
      el.removeEventListener('blur', onBlur);
      const v = el.textContent.trim();
      if (ok && v) { S.project.name = v; S.project.touch(); scheduleSave(); }
      el.textContent = S.project.name;
    };
    const onKey = (e) => { if (e.key === 'Enter') { e.preventDefault(); finish(true); } else if (e.key === 'Escape') finish(false); };
    const onBlur = () => finish(true);
    el.addEventListener('keydown', onKey);
    el.addEventListener('blur', onBlur);
  }

  /* ---- ajuda ao passar o mouse ---- */

  function symbolInfo(name) {
    const info = (S.lint && S.lint.result.info) || (S.built && S.built.result.info);
    return info ? info.symByName.get(name) : null;
  }

  /* Número nas bases (tooltip e painel Ajuda). */
  function numberInto(box, word) {
    const s = word.replace(/_/g, '');
    const v = /^0[bB]/.test(s) ? parseInt(s.slice(2), 2) : Number(s);
    if (!Number.isFinite(v)) return false;
    const u = v >>> 0;
    box.append(h('div', { class: 't' }, word),
      h('div', { class: 'x' }, '0x' + u.toString(16).toUpperCase() + ' · ' + u + ' · ' + (u | 0) + ' (com sinal) · 0b' + u.toString(2)));
    return true;
  }

  /* Valor atual de um registrador (se há programa carregado). */
  function regValueTable(name) {
    const r = KSWEB_ISA.registers.find((x) => x.name === name);
    if (!r || !dbg.cpu || !S.loaded) return null;
    const v = r.index === 0 ? 0 : dbg.cpu.r[r.index] >>> 0;
    return h('table', { class: 'ktip-rows' }, h('tr', {}, h('td', { class: 'k' }, 'valor'), h('td', {}, hex8(v) + ' = ' + (v | 0) + (dbg.regChanged(r.index) ? '  (alterado)' : ''))),
      h('tr', {}, h('td', { class: 'k' }, 'float'), h('td', {}, F.f32Str(v))));
  }

  /* Tooltip do editor (mouse e Ctrl+K Ctrl+I): ficha compacta do isa.json,
   * rótulo com endereço/seção/conteúdo, número nas bases. */
  async function hover(q) {
    const box = h('div', { class: 'ks-hover' });
    const t = KsasmLang.target(q.word, q.type);
    if (!t) return null;
    if (t.kind === 'number') return numberInto(box, q.word) ? box : null;
    if (t.kind === 'label') return (await labelInto(box, q.word, q.file)) ? box : null;
    const c = IsaRef.card(KSWEB_ISA, t);
    if (!c) return null;
    const tip = IsaRef.renderTip(document, c, { onRef: (r) => openReference(r), hint: q.cursor ? 'Esc fecha' : 'Ctrl+Shift+H' });
    if (t.kind === 'register') { const tb = regValueTable(t.key); if (tb) tip.append(tb); }
    return tip;
  }

  /* Rótulo: endereço, seção, onde foi definido e (com a VM parada) o
   * conteúdo da memória. false se o rótulo não existe. */
  async function labelInto(box, word, file, goto) {
    const s = symbolInfo(word);
    const local = KsasmLang.scanLabels(editor.getText(file) || '').find((l) => l.name === word);
    if (!s && !local) return false;
    box.append(h('div', { class: 't' }, word + (s ? '  ' + (s.kind === 'equ' ? '= ' : '@ ') + hex8(s.addr) : '')));
    const where = s && s.file ? s.file + ':' + s.line : local ? file + ':' + local.line : '';
    box.append(h('div', { class: 'x' }, (s ? (s.kind === 'equ' ? 'constante' : 'rótulo em ' + s.kind) + (s.global ? ' (global)' : '') : 'rótulo (monte para ver o endereço)') + (where ? ' · definido em ' + where : '')));
    if (goto && where) {
      const [wf, wl] = s && s.file ? [s.file, s.line] : [file, local.line];
      box.append(h('p', { class: 'kcard-links' }, h('button', { type: 'button', class: 'link', onclick: () => { openTab(wf); editor.gotoLine(wf, wl, 1); } }, 'Ir para a definição →')));
    }
    if (s && s.kind !== 'equ' && S.loaded && S.imageSource === 'build' && (!isActive() || S.vmState === 'waiting')) {
      const m = await memRead(s.addr, 32);
      if (m && m.mask[0]) {
        const b = m.bytes, ok4 = m.mask[3];
        const w = ok4 ? (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0 : null;
        let n = 0;
        while (n < 32 && m.mask[n] && b[n]) n++;
        const str = new TextDecoder().decode(b.slice(0, n)).replace(/\n/g, '\\n').replace(/[\x00-\x1f]/g, '.');
        const t = h('table', {});
        if (w !== null) t.append(h('tr', {}, h('td', {}, 'word'), h('td', {}, hex8(w) + ' = ' + (w | 0) + ' · float ' + F.f32Str(w))));
        t.append(h('tr', {}, h('td', {}, 'bytes'), h('td', {}, Array.from(b.slice(0, 8)).map((x) => x.toString(16).toUpperCase().padStart(2, '0')).join(' '))));
        if (str) t.append(h('tr', {}, h('td', {}, 'texto'), h('td', {}, '"' + str + '"')));
        box.append(t);
      }
    }
    return true;
  }

  /* ---- painel Ajuda (coluna direita) e referência da ISA ---- */

  const HELP = { timer: null, key: null };
  let ref = null;

  function helpVisible() { return layout && layout.isOpen('right') && layout.rightTab === 'help'; }

  /* Debounce: só consulta o isa.json depois que o cursor para (nada é montado). */
  function scheduleHelp() {
    if (!helpVisible()) return;
    clearTimeout(HELP.timer);
    HELP.timer = setTimeout(() => updateHelp(false), 120);
  }

  function updateHelp(force) {
    HELP.timer = null;
    if (!helpVisible()) return;
    const ci = S.ksxMode ? null : editor.cursorInfo();
    const t = ci ? KsasmLang.helpAt(ci.lineText, ci.col, { line: true }) : null;
    const box = $('#help-card');
    if (!t) {                                        /* fica a última ficha */
      if (HELP.key === null || force) {
        HELP.key = '';
        box.replaceChildren(h('p', { class: 'muted help-empty' }, 'Posicione o cursor sobre uma instrução, pseudo-instrução, diretiva, registrador, condição de desvio (beq, b.lt…), syscall ou rótulo.'));
      }
      return;
    }
    const key = t.kind + ':' + t.key + (t.kind === 'label' ? '@' + ci.file : '');
    if (!force && key === HELP.key) return;
    HELP.key = key;
    if (t.kind === 'number' || t.kind === 'label') {
      const b = h('div', { class: 'ks-hover help-misc' });
      box.replaceChildren(b);
      if (t.kind === 'number') numberInto(b, t.key);
      else labelInto(b, t.key, ci.file, true).then((okk) => { if (!okk && HELP.key === key) b.append(h('p', { class: 'muted' }, 'Rótulo "' + t.key + '" não definido.')); });
      return;
    }
    const c = IsaRef.card(KSWEB_ISA, t);
    if (!c) { box.replaceChildren(); return; }
    const card = IsaRef.renderCard(document, c, { onRef: (r) => openReference(r), onInsert: insertExample, onCopy: copyText, headingLevel: 3 });
    if (t.kind === 'register') { const tb = regValueTable(t.key); if (tb) card.append(tb); }
    box.replaceChildren(card);
  }

  function ensureRef() {
    if (!ref) ref = new IsaRef.Reference($('#ref-root'), { doc: document, isa: KSWEB_ISA, onInsert: insertExample, onCopy: copyText });
    return ref;
  }

  /* Abre a referência no painel inferior, posicionada em target ({kind,
   * key} ou {section, key}); sem target, na busca. */
  function openReference(target) {
    editor.hideCursorTip();
    layout.showPanel('reference');
    layout.ensureBottom(Math.min(340, Math.round(window.innerHeight * 0.45)));
    const r = ensureRef();
    if (target && r.show(target)) return;
    r.focusSearch();
  }

  /* Ctrl+Shift+H: a ficha da palavra sob o cursor, se o foco está no editor. */
  function cursorTarget() {
    if (S.ksxMode || !editor.view.hasFocus) return null;
    const ci = editor.cursorInfo();
    const t = ci && KsasmLang.helpAt(ci.lineText, ci.col);
    return t && t.kind !== 'label' && t.kind !== 'number' ? t : null;
  }

  function insertExample(text) {
    if (S.ksxMode || !editor.active) { status('abra um arquivo do projeto para inserir o exemplo'); return; }
    editor.insertLine(text);
    status('exemplo inserido em ' + editor.active);
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => status('copiado: ' + text.trim()), () => status('não foi possível copiar (permissão do navegador)'));
    } else status('a área de transferência não está disponível');
  }

  /* Rótulos para o autocomplete: os do arquivo e os símbolos da montagem. */
  function labelsFor(name, text, line) {
    const out = KsasmLang.labelCompletions(text, '', line);
    const info = S.lint && S.lint.result.info;
    if (info) {
      const seen = new Set(out.map((l) => l.name));
      for (const l of out) { const s = info.symByName.get(l.name); if (s) l.addr = s.addr; }
      for (const s of info.symbols) {
        if (seen.has(s.name) || !s.file) continue;
        out.push({ name: s.name, line: s.line, file: s.file, kind: s.kind === 'equ' ? 'equ' : 'label', addr: s.addr });
      }
    }
    return out;
  }

  /* ---- atalhos ---- */

  function doShortcut(act) {
    switch (act) {
      case 'run': run(); break;
      case 'toggleRun': if (isActive()) pause(); else run(); break;
      case 'stop': pause(); break;
      case 'restart': restart(); break;
      case 'breakpoint': if (!S.ksxMode) editor.toggleBreakpoint(); break;
      case 'debugger': layout.collapse('right'); break;
      case 'step': stepMode('over'); break;
      case 'stepInto': stepMode('into'); break;
      case 'stepOut': stepMode('out'); break;
      case 'build': build(false); break;
      case 'save': scheduleSave(true); break;
      case 'help': if (!$('#dlg-help').open) $('#dlg-help').showModal(); break;
      case 'reference': openReference(cursorTarget()); break;
      default: break;
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
      if (ex) openExample(ex);
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
      if (e.dataTransfer.files && e.dataTransfer.files.length) importFiles(e.dataTransfer.files);
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

  /* Opções lembradas entre sessões (localStorage). */
  function setupOptions() {
    const KEY = 'ksweb-ide:options';
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (e) { saved = {}; }
    const inputs = [...document.querySelectorAll('#dlg-options input, #dlg-options select')];
    for (const i of inputs) {
      if (!(i.id in saved)) continue;
      if (i.type === 'checkbox') i.checked = !!saved[i.id]; else i.value = saved[i.id];
    }
    const store = () => {
      const o = {};
      for (const i of inputs) o[i.id] = i.type === 'checkbox' ? i.checked : i.value;
      try { localStorage.setItem(KEY, JSON.stringify(o)); } catch (e) { /* sem localStorage */ }
    };
    for (const i of inputs) i.addEventListener('change', store);
  }

  async function init() {
    term = new TerminalView($('#term'), {
      cols: 80, rows: 24, scrollback: 5000,
      onData: (s) => sendInput(s),
      onEof: () => sendEof(),
      onInterrupt: () => { pause(); sys('VM interrompida (Ctrl+Alt+C)'); },
      onTitle: (t) => { $('#term-title').textContent = t; },
      onResize: (c, r) => { $('#term-size').textContent = c + '×' + r; }
    });
    dbg = new DebuggerPanel($('#debugger'), {
      send, step: (n) => stepN(n), breakpoints: breakpointList, addAddrBreakpoint, removeBreakpoint, clearBreakpoints,
      gotoSource: (f, l) => { openTab(f); editor.gotoLine(f, l, 1); },
      watchesChanged: saveWatches
    });
    editor = new KsEditor($('#editor'), {
      onChange: onEdit,
      onCursor: (l, c) => { $('#sb-pos').textContent = 'Ln ' + l + ', Col ' + c; scheduleHelp(); },
      onBreakpoints: onEditorBreakpoints,
      onDocChanges,
      labels: labelsFor,
      hover,
      keys: { 'Mod-b': () => doShortcut('build'), 'Mod-s': () => doShortcut('save') }
    });
    layout = new KsLayout({
      onPanel: (name) => {
        if (name === 'terminal') setTimeout(() => term.fitToContainer(), 0);
        if (name === 'disasm') setTimeout(() => renderDisasmPc(S.loaded && !isActive() ? S.pc : null), 0);
        if (name === 'reference') ensureRef();
      },
      onRight: (name) => { if (name === 'help') setTimeout(() => updateHelp(true), 0); }
    });

    $('#btn-build').addEventListener('click', () => build(false));
    $('#btn-run').addEventListener('click', run);
    $('#btn-debug').addEventListener('click', debugStart);
    $('#btn-stop').addEventListener('click', pause);
    $('#btn-restart').addEventListener('click', restart);
    $('#btn-continue').addEventListener('click', cont);
    $('#btn-step-over').addEventListener('click', () => stepMode('over'));
    $('#btn-step-into').addEventListener('click', () => stepMode('into'));
    $('#btn-step-out').addEventListener('click', () => stepMode('out'));
    $('#btn-stale-build').addEventListener('click', restart);
    $('#btn-import').addEventListener('click', () => $('#file').click());
    $('#btn-export').addEventListener('click', exportZip);
    $('#btn-options').addEventListener('click', () => $('#dlg-options').showModal());
    $('#btn-help').addEventListener('click', () => $('#dlg-help').showModal());
    $('#btn-ref').addEventListener('click', () => openReference(null));
    $('#btn-help-ref').addEventListener('click', () => openReference(null));
    $('#btn-open-ref').addEventListener('click', () => { $('#dlg-help').close(); openReference(null); });
    $('#btn-menu').addEventListener('click', async (e) => {
      e.stopPropagation();
      const m = $('#menu');
      if (!m.hidden) { closeMenu(); return; }
      await renderProjectMenu();
      m.hidden = false;
      $('#btn-menu').setAttribute('aria-expanded', 'true');
      const first = m.querySelector('button');
      if (first) first.focus();
    });
    document.addEventListener('click', (e) => { if (!$('#menu').hidden && !$('#menu').contains(e.target)) closeMenu(); });
    $('#menu').addEventListener('keydown', (e) => {
      const items = [...$('#menu').querySelectorAll('button')];
      const i = items.indexOf(document.activeElement);
      if (e.key === 'Escape') { closeMenu(); $('#btn-menu').focus(); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
    });
    for (const b of document.querySelectorAll('[data-act]')) b.addEventListener('click', () => menuAction(b.dataset.act));
    $('#proj-name').addEventListener('click', renameProject);
    $('#proj-name').addEventListener('keydown', (e) => { if (e.key === 'Enter' && $('#proj-name').contentEditable !== 'true') { e.preventDefault(); renameProject(); } });
    $('#file').addEventListener('change', (e) => { const f = e.target.files; if (f && f.length) importFiles(f); e.target.value = ''; });
    $('#file-ksx').addEventListener('change', async (e) => {
      const f = e.target.files[0];
      e.target.value = '';
      if (f) openKsx(await readFile(f), f.name);
    });
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
    setupOptions();
    $('#opt-mode').addEventListener('change', (e) => {
      term.setLineMode(e.target.value === 'line');
      $('#mode-hint').textContent = e.target.value === 'line' ? 'linha (eco local)' : 'raw';
    });
    term.setLineMode($('#opt-mode').value === 'line');
    $('#mode-hint').textContent = $('#opt-mode').value === 'line' ? 'linha (eco local)' : 'raw';
    $('#opt-bs').addEventListener('change', (e) => { term.backspace = e.target.value === 'bs' ? '\b' : '\x7f'; });
    $('#opt-poll').addEventListener('change', (e) => send({ type: 'config', stdinBlock: !e.target.checked }));
    $('#opt-slice').addEventListener('change', () => send({ type: 'config', slice: runOpts().slice }));
    $('#opt-lint').addEventListener('change', () => scheduleLint(0));
    $('#opt-g').addEventListener('change', () => { S.lint = null; S.version++; scheduleLint(0); updateStale(); });
    $('#btn-copy-all').addEventListener('click', () => {
      const t = term.allText();
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(t).then(() => sys('terminal copiado'), () => download('terminal.txt', t));
      } else download('terminal.txt', t);
    });
    document.addEventListener('keydown', (e) => {
      if (e.defaultPrevented || e.isComposing) return;
      if (document.querySelector('dialog[open]') && e.key !== 'F1') return;
      const act = ideShortcut(e);
      if (!act) return;
      e.preventDefault();
      doShortcut(act);
    });
    window.addEventListener('beforeunload', () => { if (S.dirty && S.project && S.store) S.store.save(S.project); });
    setupExamples();
    setupDrop();
    setupTermSize();

    S.store = new ProjectStore();
    const kind = await S.store.open();
    $('#sb-store').textContent = kind === 'indexeddb' ? 'IndexedDB' : kind === 'localstorage' ? 'localStorage' : 'sem persistência';
    let p = null;
    try {
      const last = await S.store.getMeta('last');
      if (last) p = await S.store.load(last);
      if (!p) { const l = await S.store.list(); if (l.length) p = await S.store.load(l[0].id); }
    } catch (e) { p = null; }
    if (!p) {
      p = Project.create('meu-projeto', { 'main.ksasm': DEFAULT_MAIN }, 'main.ksasm');
      await S.store.save(p);
    } else status('projeto ' + p.name + ' recuperado (' + kind + ')');
    setProject(p);
    setState('idle');
    boot();
  }

  /* API para testes de navegador e depuração no console. */
  window.ksweb = {
    get state() { return S; }, get editor() { return editor; }, get layout() { return layout; },
    get reference() { return ref; },
    build, run, cont, pause, restart, stepMode, openTab, openKsx, setMain, breakpoints: breakpointList,
    openReference, updateHelp
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
