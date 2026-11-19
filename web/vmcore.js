/*
 * vmcore.js — invólucro do módulo ksvm.wasm, sem DOM.
 *
 * Usado pelo Web Worker (worker.js) e pelos testes em Node. Define:
 *   KsCore     a instância do wasm com imports (js_putc, js_millis,
 *              js_micros) e métodos para cada export de ksweb.c
 *   KsSession  a lógica de uma execução: fatias, limite de instruções,
 *              fila de entrada, término com a convenção de códigos do
 *              runner nativo (ksvm_main.c). Quem agenda as fatias
 *              (setTimeout/MessageChannel no worker, laço síncrono nos
 *              testes) fica de fora.
 *
 * Script clássico (sem módulos ES) para funcionar em importScripts, num
 * Blob (ksweb-single.html) e em require() do Node.
 */
(function (root) {
  'use strict';

  const STATE = Object.freeze({
    RUNNING: 0, HALT: 1, FAULT: 2, YIELD: 3, WAIT_INPUT: 4, BREAK: 5, NOT_LOADED: 6
  });
  const STATE_NAME = ['RUNNING', 'HALT', 'FAULT', 'YIELD', 'WAIT_INPUT', 'BREAK', 'NOT_LOADED'];
  const STOP_NAME = ['', 'breakpoint', 'BRK', 'syscall', 'step'];
  const FRAME_OFF = 0x7FFFFFFF;
  /* Códigos de saída do runner nativo (ksvm_main.c). */
  const EXIT = Object.freeze({
    USAGE: 64, IMAGE: 65, NOINPUT: 66, NOMEM: 69, FAULT_BASE: 70, LIMIT: 124, QUIT: 130
  });
  const ERR_NOMEM = -100;
  const TEXT_BUF = 4096;
  const INPUT_STAGE = 4096;
  const REG_NAMES = [];
  for (let i = 0; i < 32; i++) REG_NAMES.push(i === 0 ? 'zr' : i === 30 ? 'fp' : i === 31 ? 'sp' : 'r' + i);

  const hex8 = (v) => (v >>> 0).toString(16).toUpperCase().padStart(8, '0');

  function nowMs() {
    return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  }

  class KsCore {
    /* bytes: ArrayBuffer/Uint8Array do ksvm.wasm. opts.onPutc(byte) opcional;
     * sem ele a saída se acumula e sai por takeOutput(). opts.clock(): ms. */
    static async create(bytes, opts) {
      const core = new KsCore(opts);
      const { instance } = await WebAssembly.instantiate(bytes, core._imports());
      core._attach(instance);
      return core;
    }

    static createSync(bytes, opts) {
      const core = new KsCore(opts);
      const instance = new WebAssembly.Instance(new WebAssembly.Module(bytes), core._imports());
      core._attach(instance);
      return core;
    }

    constructor(opts) {
      opts = opts || {};
      this.onPutc = opts.onPutc || null;
      this.clock = opts.clock || nowMs;
      this.t0 = this.clock();
      this.out = new Uint8Array(4096);
      this.outLen = 0;
      this.image = null;
    }

    _imports() {
      return {
        env: {
          js_putc: (c) => {
            if (this.onPutc) { this.onPutc(c & 0xFF); return; }
            if (this.outLen === this.out.length) {
              const n = new Uint8Array(this.out.length * 2);
              n.set(this.out);
              this.out = n;
            }
            this.out[this.outLen++] = c & 0xFF;
          },
          js_millis: () => (Math.floor(this.clock() - this.t0) >>> 0),
          js_micros: () => (Math.floor((this.clock() - this.t0) * 1000) >>> 0)
        }
      };
    }

    _attach(instance) {
      this.x = instance.exports;
      this.mem = this.x.memory;
      this._u8 = null;
      this.textBuf = this.x.ksweb_text_buf();
      this.inputBuf = this.x.ksweb_input_buf();
    }

    /* Vistas recriadas quando memory.grow troca o ArrayBuffer. */
    get u8() {
      if (!this._u8 || this._u8.buffer !== this.mem.buffer) this._u8 = new Uint8Array(this.mem.buffer);
      return this._u8;
    }

    u32(ptr) {
      const b = this.u8;
      return (b[ptr] | (b[ptr + 1] << 8) | (b[ptr + 2] << 16) | (b[ptr + 3] << 24)) >>> 0;
    }

    cstr(ptr, max) {
      const b = this.u8;
      let s = '';
      for (let i = 0; i < (max || TEXT_BUF) && b[ptr + i] !== 0; i++) s += String.fromCharCode(b[ptr + i]);
      return s;
    }

    /* Saída acumulada desde a última chamada (cópia). */
    takeOutput() {
      const r = this.out.slice(0, this.outLen);
      this.outLen = 0;
      return r;
    }

    /* ---- ciclo de vida ---- */

    /* VM nova: MILLIS/MICROS contam a partir daqui ("desde o boot"). */
    init(ramSize, stackSize) {
      this.image = null;
      this.t0 = this.clock();
      return this.x.ksweb_init(ramSize >>> 0, (stackSize || 0) >>> 0);
    }

    load(bytes) {
      const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      const ptr = this.x.ksweb_alloc(Math.max(data.length, 1));
      if (ptr === 0) return ERR_NOMEM;
      this.u8.set(data, ptr);
      const err = this.x.ksweb_load(ptr, data.length);
      if (err === 0) this.image = data.slice();
      return err;
    }

    errName(err) { return this.cstr(this.x.ksweb_err_name(err)); }
    faultName(code) { return this.cstr(this.x.ksweb_fault_name(code)); }
    version() {
      const v = this.x.ksweb_version();
      return (v >>> 16) + '.' + ((v >>> 8) & 0xFF) + '.' + (v & 0xFF);
    }

    /* ---- execução ---- */

    run(maxInsns) { return this.x.ksweb_run(maxInsns >>> 0); }
    step() { return this.x.ksweb_step(); }
    status() { return this.x.ksweb_status(); }
    exitCode() { return this.x.ksweb_exit_code() >>> 0; }
    sleepMs() { return this.x.ksweb_sleep_ms() >>> 0; }
    stopReason() { return this.x.ksweb_stop_reason(); }
    insnCount() { return this.x.ksweb_insn_count() >>> 0; }

    faultInfo() {
      const p = this.x.ksweb_fault_info();
      const code = this.u32(p);
      return { code, name: this.faultName(code), pc: this.u32(p + 4), addr: this.u32(p + 8) };
    }

    /* ---- entrada ---- */

    /* Entrega o que couber de bytes no anel; devolve quantos foram aceitos. */
    feed(bytes) {
      let done = 0;
      while (done < bytes.length) {
        const n = Math.min(bytes.length - done, INPUT_STAGE, this.x.ksweb_input_space());
        if (n === 0) break;
        this.u8.set(bytes.subarray(done, done + n), this.inputBuf);
        const got = this.x.ksweb_feed(n);
        done += got;
        if (got < n) break;
      }
      return done;
    }

    feedByte(b) { return this.x.ksweb_feed_input(b & 0xFF); }
    inputEof() { this.x.ksweb_input_eof(); }
    inputSpace() { return this.x.ksweb_input_space(); }
    inputPending() { return this.x.ksweb_input_pending(); }
    setStdinBlock(on) { this.x.ksweb_set_stdin_block(on ? 1 : 0); }

    /* ---- registradores, disassembly, memória ---- */

    reg(i) { return this.x.ksweb_reg(i) >>> 0; }
    pc() { return this.x.ksweb_pc() >>> 0; }
    flags() { return this.x.ksweb_flags() >>> 0; }

    cpu() {
      const p = this.x.ksweb_cpu_ptr();
      const r = new Array(32);
      for (let i = 0; i < 32; i++) r[i] = this.u32(p + 4 * i);
      return { r, pc: this.u32(p + 128), flags: this.u32(p + 132), insns: this.insnCount() };
    }

    disasmAt(pc) {
      const len = this.x.ksweb_disasm_at(pc >>> 0, this.textBuf, TEXT_BUF);
      return { len, text: len ? this.cstr(this.textBuf) : '' };
    }

    /* {bytes, mask, readable} de [addr, addr+len) (len <= 1 MiB), em pedaços
     * de 2 KiB pelo buffer de texto do wasm (não consome a arena). */
    memRead(addr, len) {
      len = Math.max(0, Math.min(len | 0, 1 << 20));
      const bytes = new Uint8Array(len), mask = new Uint8Array(len), half = TEXT_BUF / 2;
      let readable = 0;
      for (let off = 0; off < len; off += half) {
        const n = Math.min(half, len - off);
        readable += this.x.ksweb_mem_read((addr + off) >>> 0, n, this.textBuf, this.textBuf + half);
        bytes.set(this.u8.subarray(this.textBuf, this.textBuf + n), off);
        mask.set(this.u8.subarray(this.textBuf + half, this.textBuf + half + n), off);
      }
      return { bytes, mask, readable };
    }

    regions() {
      const dst = this.textBuf;
      const n = this.x.ksweb_regions(dst);
      const r = [];
      for (let i = 0; i < n; i++) {
        const p = dst + 20 * i;
        const perm = this.u32(p + 8), kind = this.u32(p + 12);
        r.push({
          base: this.u32(p), size: this.u32(p + 4), perm, kind,
          kindName: ['RAM', 'ROM', 'MMIO'][kind] || '?',
          permStr: (perm & 1 ? 'R' : '-') + (perm & 2 ? 'W' : '-') + (perm & 4 ? 'X' : '-'),
          host: this.u32(p + 16)
        });
      }
      return r.sort((a, b) => a.base - b.base);   /* o barramento guarda RAM primeiro */
    }

    header() {
      const p = this.x.ksweb_header();
      const w = (i) => this.u32(p + 4 * i);
      return {
        verMajor: w(0), verMinor: w(1), flags: w(2), entry: w(3), codeOff: w(4), codeSize: w(5),
        dataOff: w(6), dataSize: w(7), bssSize: w(8), ramBaseFile: w(9), ramMin: w(10),
        stackSize: w(11), symOff: w(12), symSize: w(13), checksum: w(14), ramBase: w(15),
        ramSize: w(16), sp0: w(17), stackLimit: w(18), heapStart: w(19), imageSize: w(20),
        loaded: w(21) === 1,
        flagNames: [(w(2) & 1) ? 'PIC' : '', (w(2) & 2) ? 'SYMS' : ''].filter(Boolean)
      };
    }

    /* ---- depurador ---- */

    bpSet(addr) { return this.x.ksweb_bp_set(addr >>> 0); }
    bpClear(addr) { return this.x.ksweb_bp_clear(addr >>> 0); }
    bpClearAll() { this.x.ksweb_bp_clear_all(); }
    bpList() {
      const n = this.x.ksweb_bp_count(), r = [];
      for (let i = 0; i < n; i++) r.push(this.x.ksweb_bp_get(i) >>> 0);
      return r.sort((a, b) => a - b);
    }
    setStopFlags(onBrk, onSyscall) { this.x.ksweb_set_stop_flags((onBrk ? 1 : 0) | (onSyscall ? 2 : 0)); }
    /* Passo por cima (0, a partir de um CALL) e sair da função (-1): para
     * depois do RET que deixa a profundidade de chamadas nesse valor. */
    frameStop(depth) { this.x.ksweb_frame_stop(depth | 0); }
    frameOff() { this.x.ksweb_frame_stop(FRAME_OFF); }
    frameDepth() { return this.x.ksweb_frame_depth() | 0; }
    traceEnable(n) { return this.x.ksweb_trace_enable(n >>> 0); }
    traceClear() { this.x.ksweb_trace_clear(); }
    traceCount() { return this.x.ksweb_trace_count(); }
    traceTotal() { return this.x.ksweb_trace_total() >>> 0; }

    /* Texto dos registros [from, count) no formato do "ksvm --trace". */
    traceText(from, max) {
      const n = this.traceCount();
      const start = Math.max(0, from || 0), end = Math.min(n, max === undefined ? n : start + max);
      const parts = [];
      for (let i = start; i < end; i++) {
        const len = this.x.ksweb_trace_line(i, this.textBuf, TEXT_BUF);
        parts.push(this.cstr(this.textBuf, len + 1));
      }
      return parts.join('');
    }

    /* Registros recentes como objetos {pc, line} (painel do depurador). */
    traceTail(count) {
      const n = this.traceCount(), start = Math.max(0, n - count), r = [];
      for (let i = start; i < n; i++) {
        const len = this.x.ksweb_trace_line(i, this.textBuf, TEXT_BUF);
        r.push({ pc: this.x.ksweb_trace_pc(i) >>> 0, line: this.cstr(this.textBuf, len + 1) });
      }
      return r;
    }

    /* Mensagem e código de término na convenção do runner nativo. */
    finishInfo(state, limit) {
      if (limit) {
        return {
          code: EXIT.LIMIT, kind: 'limit',
          message: 'limite de ' + limit + ' instruções atingido (pc=0x' + hex8(this.pc()) + ')'
        };
      }
      if (state === STATE.FAULT) {
        const f = this.faultInfo();
        return {
          code: EXIT.FAULT_BASE + f.code, kind: 'fault', fault: f,
          message: 'fault: ' + f.name + ' at pc=0x' + hex8(f.pc) + ' addr=0x' + hex8(f.addr)
        };
      }
      if (state === STATE.HALT) {
        const code = this.exitCode();
        return { code: code & 0xFF, kind: 'halt', rawCode: code, message: 'código de saída ' + (code & 0xFF) };
      }
      return null;
    }
  }

  /* Símbolos da imagem: registros "u32 addr, u8 kind, u8 len, name" (doc 05). */
  function parseSymbols(image, symOff, symSize) {
    const syms = [];
    if (!image || !symOff || !symSize || symOff + symSize > image.length) return syms;
    let p = symOff;
    const end = symOff + symSize;
    while (p + 6 <= end) {
      const addr = (image[p] | (image[p + 1] << 8) | (image[p + 2] << 16) | (image[p + 3] << 24)) >>> 0;
      const kind = image[p + 4], len = image[p + 5];
      if (p + 6 + len > end) break;
      let name = '';
      for (let i = 0; i < len; i++) name += String.fromCharCode(image[p + 6 + i]);
      syms.push({ addr, kind, name });
      p += 6 + len;
    }
    return syms;
  }

  /*
   * Uma execução. opts: ramSize, stackSize, maxInsns (0 = sem limite),
   * slice (instruções por ksweb_run), stdinBlock.
   * tick() roda uma fatia e devolve {action, state, ...}:
   *   'continue'  fatia esgotada, chame de novo
   *   'sleep'     YIELD: retome após ms milissegundos
   *   'wait'      WAIT_INPUT: entregue entrada (pushInput/eof) e retome
   *   'break'     parada do depurador (reason)
   *   'done'      terminou: info = {code, kind, message}
   */
  class KsSession {
    constructor(core, opts) {
      this.core = core;
      this.opts = Object.assign({ ramSize: 1 << 20, stackSize: 0, maxInsns: 0, slice: 200000, stdinBlock: true }, opts || {});
      this.pending = [];        /* fila de Uint8Array ainda não entregues ao anel */
      this.eofPending = false;
      this.executed = 0;        /* instruções contadas para o limite */
      this.finished = null;
    }

    /* Prepara a VM e carrega a imagem. Devolve null ou {code, kind:'load', message}. */
    load(image) {
      const c = this.core, o = this.opts;
      const e1 = c.init(o.ramSize, o.stackSize);
      if (e1 !== 0) {
        this.finished = e1 === ERR_NOMEM
          ? { code: EXIT.NOMEM, kind: 'load', message: 'sem memória para ' + o.ramSize + ' bytes de RAM' }
          : { code: EXIT.USAGE, kind: 'load', message: 'tamanho de RAM inválido: ' + o.ramSize };
        return this.finished;
      }
      c.setStdinBlock(o.stdinBlock);
      const e2 = c.load(image);
      if (e2 !== 0) {
        this.finished = e2 === ERR_NOMEM
          ? { code: EXIT.NOMEM, kind: 'load', message: 'sem memória para a imagem' }
          : { code: EXIT.IMAGE, kind: 'load', message: 'imagem inválida: ' + c.errName(e2), err: e2 };
        return this.finished;
      }
      return null;
    }

    pushInput(bytes) {
      if (bytes && bytes.length) this.pending.push(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
      this.flushInput();
    }

    eof() {
      this.eofPending = true;
      this.flushInput();
    }

    /* Move a fila para o anel do wasm até ele encher; EOF só depois da fila.
     * Devolve true se entregou algum byte ou o EOF. */
    flushInput() {
      let moved = false;
      while (this.pending.length) {
        const b = this.pending[0];
        const n = this.core.feed(b);
        if (n > 0) moved = true;
        if (n < b.length) { this.pending[0] = b.subarray(n); return moved; }
        this.pending.shift();
      }
      if (this.eofPending) { this.core.inputEof(); this.eofPending = false; this.eofSent = true; moved = true; }
      return moved;
    }

    hasInput() {
      return this.pending.length > 0 || this.core.inputPending() > 0 || this.eofSent === true;
    }

    _limitLeft() {
      return this.opts.maxInsns ? this.opts.maxInsns - this.executed : Infinity;
    }

    /* Uma fatia (ou um passo, se step). */
    tick(step) {
      const c = this.core;
      if (this.finished) return { action: 'done', info: this.finished };
      this.flushInput();
      let slice = step ? 1 : this.opts.slice;
      const left = this._limitLeft();
      if (left <= 0) return this._done(STATE.RUNNING, this.opts.maxInsns);
      if (left < slice) slice = left;
      const before = c.insnCount();
      const st = step ? c.step() : c.run(slice);
      this.executed += (c.insnCount() - before) >>> 0;
      switch (st) {
        case STATE.RUNNING:
          if (this._limitLeft() <= 0 && !step) return this._done(st, this.opts.maxInsns);
          return { action: 'continue', state: st };
        case STATE.YIELD:
          return { action: 'sleep', state: st, ms: c.sleepMs() };
        case STATE.WAIT_INPUT:
          /* A syscall esvaziou o anel e a fila ainda tem entrada (ou o EOF):
           * entrega e continua, sem esperar por uma nova mensagem. */
          if (this.flushInput()) return { action: 'continue', state: st };
          return { action: 'wait', state: st };
        case STATE.BREAK:
          return { action: 'break', state: st, reason: STOP_NAME[c.stopReason()] || '?' };
        case STATE.HALT:
        case STATE.FAULT:
          return this._done(st, 0);
        default:
          return this._done(st, 0);
      }
    }

    _done(state, limit) {
      this.finished = this.core.finishInfo(state, limit) ||
        { code: EXIT.IMAGE, kind: 'load', message: 'nenhuma imagem carregada' };
      return { action: 'done', state, info: this.finished };
    }

    /* Laço síncrono (testes): entrada toda de uma vez, EOF no fim, YIELD sem
     * espera real. Devolve {stdout, info, ticks, waits, sleeps}. */
    runSync(input, maxTicks) {
      if (input !== undefined && input !== null) {
        this.pushInput(typeof input === 'string' ? new TextEncoder().encode(input) : input);
        this.eof();
      }
      const stats = { ticks: 0, waits: 0, sleeps: [] };
      let r = this.finished ? { action: 'done', info: this.finished } : null;
      while (!r || r.action !== 'done') {
        if (++stats.ticks > (maxTicks || 1e7)) throw new Error('runSync: ticks demais');
        r = this.tick(false);
        if (r.action === 'wait') {
          stats.waits++;
          if (this.eofSent) throw new Error('WAIT_INPUT depois de EOF');
          if (this.eofPending) throw new Error('WAIT_INPUT com a entrada presa na fila (anel cheio)');
          this.eof();
        } else if (r.action === 'sleep') {
          stats.sleeps.push(r.ms);
        } else if (r.action === 'break') {
          return Object.assign(stats, { stdout: this.core.takeOutput(), info: null, brk: r });
        }
      }
      return Object.assign(stats, { stdout: this.core.takeOutput(), info: r.info });
    }
  }

  const api = { KsCore, KsSession, STATE, STATE_NAME, STOP_NAME, FRAME_OFF, EXIT, REG_NAMES, parseSymbols, hex8 };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else Object.assign(root, api);
})(typeof self !== 'undefined' ? self : this);
