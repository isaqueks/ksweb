/*
 * debugger.js — painel "Depurador" da coluna direita da IDE (DOM). Mostra o
 * retrato que o worker manda a cada parada (registradores, pilha, trace),
 * pede ao worker a janela de memória do hexdump e as leituras do watch, e
 * lista os breakpoints. O disassembly com breakpoints por endereço fica no
 * painel inferior (ksweb.js, a partir do ksdis); os breakpoints de fonte,
 * no gutter do editor. A tabela de breakpoints e as opções de parada vivem
 * no laço C (ksweb_run): este painel monta a configuração e a reenvia.
 *
 * app: {send(msg), step(n), breakpoints() -> [{addr, file, line, moved}],
 *       addAddrBreakpoint(addr), removeBreakpoint(bp), gotoSource(file, line),
 *       watchesChanged(list)}
 *
 * Formatação: format.js (KsFormat), testada em Node.
 */
(function (root) {
  'use strict';
  /* global KsFormat */
  const F = () => root.KsFormat;
  const $ = (sel, el) => (el || document).querySelector(sel);
  const WATCH_ID0 = 1000000;

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

  /* Texto C (até o primeiro 0) com escapes, no máximo n caracteres. */
  function cString(bytes, mask, n) {
    let end = 0;
    while (end < bytes.length && mask[end] && bytes[end] !== 0) end++;
    const closed = end < bytes.length && mask[end] && bytes[end] === 0;
    const text = new TextDecoder().decode(bytes.subarray(0, end));
    let s = '';
    for (const ch of text) {
      if (s.length >= n) return '"' + s + '…';
      const c = ch.codePointAt(0);
      s += c === 10 ? '\\n' : c === 9 ? '\\t' : c === 13 ? '\\r' : c === 34 ? '\\"' : c === 92 ? '\\\\' : c < 32 || c === 127 ? '\\x' + c.toString(16).padStart(2, '0') : ch;
    }
    return '"' + s + (closed ? '"' : end < bytes.length && !mask[end] ? '…?' : '…');
  }

  class DebuggerPanel {
    constructor(el, app) {
      this.el = el;
      this.app = app;
      this.open = true;
      this.bps = new Set();          /* breakpoints por endereço sem fonte (ex.: .ksx carregado) */
      this.prevCpu = null;
      this.cpu = null;
      this.header = null;
      this.regions = [];
      this.symbols = [];
      this.symByAddr = new Map();
      this.names = {};
      this.memAddr = 0;
      this.memId = 0;
      this.showFloat = false;
      this.trace = [];
      this.traceTotal = 0;
      this.watches = [];             /* [{expr, addr, prev, cur, err}] */
      this._build();
    }

    _build() {
      const el = this.el;
      el.innerHTML = '';
      el.append(
        h('div', { class: 'dbg-head' },
          h('span', { class: 'dbg-reason', id: 'dbg-reason' }, ''),
          h('span', { class: 'dbg-stats', id: 'dbg-stats' }, '')),
        h('section', { class: 'dbg-sec' },
          h('div', { class: 'row' },
            h('button', { class: 'small', onclick: () => this.app.step(this._stepN()), title: 'Executa N instruções, respeitando breakpoints' }, 'Passo N'),
            h('input', { id: 'dbg-stepn', type: 'number', min: '1', value: '100', class: 'num', 'aria-label': 'N instruções' }),
            h('label', { class: 'small' }, h('input', { type: 'checkbox', id: 'dbg-brk', checked: 'checked', onchange: () => this._sendCfg() }), ' parar em BRK'),
            h('label', { class: 'small' }, h('input', { type: 'checkbox', id: 'dbg-sys', onchange: () => this._sendCfg() }), ' parar em syscall'))),
        this._section('Registradores', 'regs',
          h('label', { class: 'small' }, h('input', { type: 'checkbox', onchange: (e) => { this.showFloat = e.target.checked; this._renderRegs(); } }), ' float'),
          h('div', { id: 'dbg-regs', class: 'dbg-regs' })),
        this._section('Watch', 'watch', null,
          h('div', { class: 'row' },
            h('input', { id: 'dbg-watch-in', placeholder: 'rótulo, 0x1000, sp+8', class: 'addr', 'aria-label': 'Expressão do watch', onkeydown: (e) => { if (e.key === 'Enter') this._addWatchFromInput(); } }),
            h('button', { class: 'small', onclick: () => this._addWatchFromInput() }, 'Adicionar')),
          h('table', { id: 'dbg-watch', class: 'watch' })),
        this._section('Breakpoints', 'bp', null,
          h('div', { class: 'row' },
            h('input', { id: 'dbg-bp-in', placeholder: '0x1C, rótulo, pc+8', class: 'addr', 'aria-label': 'Endereço do breakpoint', onkeydown: (e) => { if (e.key === 'Enter') this._addBpFromInput(); } }),
            h('button', { class: 'small', onclick: () => this._addBpFromInput() }, 'Adicionar'),
            h('button', { class: 'small', onclick: () => { this.bps.clear(); if (this.app.clearBreakpoints) this.app.clearBreakpoints(); this._sendCfg(); this.renderBreakpoints(); } }, 'Limpar')),
          h('ul', { id: 'dbg-bps', class: 'dbg-bps mono' })),
        this._section('Pilha', 'stack', null, h('div', { id: 'dbg-stack', class: 'dbg-list mono' })),
        this._section('Memória', 'mem', null,
          h('div', { class: 'row' },
            h('input', { id: 'dbg-mem-in', placeholder: 'endereço', class: 'addr', 'aria-label': 'Ir para o endereço', onkeydown: (e) => { if (e.key === 'Enter') this._gotoInput(); } }),
            h('button', { class: 'small', onclick: () => this._gotoInput() }, 'Ir'),
            h('button', { class: 'small', 'aria-label': 'Página anterior', onclick: () => this._memGo(this.memAddr - 256) }, '◀'),
            h('button', { class: 'small', 'aria-label': 'Próxima página', onclick: () => this._memGo(this.memAddr + 256) }, '▶')),
          h('div', { class: 'row', id: 'dbg-mem-jumps' }),
          h('div', { id: 'dbg-mem', class: 'dbg-hex mono' }),
          h('div', { class: 'legend small' },
            h('span', { class: 'rg-code' }, 'CODE'), ' ', h('span', { class: 'rg-data' }, '.data'), ' ',
            h('span', { class: 'rg-bss' }, '.bss'), ' ', h('span', { class: 'rg-heap' }, 'heap'), ' ',
            h('span', { class: 'rg-stack' }, 'pilha'), ' ', h('span', { class: 'chg' }, 'alterado'))),
        this._section('Trace', 'trace',
          h('span', { class: 'row' },
            h('label', { class: 'small' }, h('input', { type: 'checkbox', id: 'dbg-trace', checked: 'checked', onchange: () => this._sendCfg() }), ' ligado'),
            h('input', { id: 'dbg-tracen', type: 'number', min: '1', max: '65536', value: '1000', class: 'num', title: 'registros guardados', 'aria-label': 'Registros de trace guardados', onchange: () => this._sendCfg() }),
            h('button', { class: 'small', onclick: () => this.app.send({ type: 'trace-export' }), title: 'mesmo formato do ksvm --trace' }, 'Exportar .txt')),
          h('pre', { id: 'dbg-trace', class: 'dbg-trace mono' }))
      );
      const jumps = $('#dbg-mem-jumps', el);
      for (const [label, fn] of [
        ['pc', () => this.cpu && this.cpu.pc], ['sp', () => this.cpu && this.cpu.r[31]], ['fp', () => this.cpu && this.cpu.r[30]],
        ['CODE', () => 0], ['.data', () => this.header && this.header.ramBase],
        ['.bss', () => this.header && this.header.ramBase + this.header.dataSize],
        ['heap', () => this.header && this.header.heapStart]]) {
        jumps.append(h('button', { class: 'small', onclick: () => { const a = fn(); if (a !== undefined && a !== null) this._memGo(a & ~15); } }, label));
      }
      this.renderBreakpoints();
      this._renderWatch();
    }

    _section(title, id, extra, ...body) {
      return h('details', { class: 'dbg-sec', open: 'open', id: 'dbg-sec-' + id },
        h('summary', {}, title, extra ? h('span', { class: 'sum-extra' }, extra) : null), ...body);
    }

    _stepN() { return Math.max(1, parseInt($('#dbg-stepn', this.el).value, 10) || 1); }

    /* Endereços de todos os breakpoints: os da IDE (fonte) e os daqui. */
    bpAddrs() {
      const s = new Set(this.bps);
      if (this.app.breakpoints) for (const b of this.app.breakpoints()) if (b.addr !== null && b.addr !== undefined) s.add(b.addr >>> 0);
      return [...s];
    }

    config() {
      return {
        on: this.open,
        bps: this.bpAddrs(),
        stopBrk: $('#dbg-brk', this.el).checked,
        stopSyscall: $('#dbg-sys', this.el).checked,
        traceN: $('#dbg-trace', this.el).checked ? Math.max(1, Math.min(65536, parseInt($('#dbg-tracen', this.el).value, 10) || 1000)) : 0
      };
    }

    _sendCfg() { this.app.send({ type: 'debug', debug: this.config() }); }
    sync() { this._sendCfg(); this.renderBreakpoints(); }

    setOpen(on) {
      this.open = on;
      this._sendCfg();
    }

    /* Nova imagem carregada. */
    setImage(header, regions, symbols) {
      this.header = header;
      this.regions = regions;
      this.symbols = symbols || [];
      this.symByAddr = new Map();
      this.names = {};
      for (const s of this.symbols) {
        if (!this.symByAddr.has(s.addr)) this.symByAddr.set(s.addr, []);
        this.symByAddr.get(s.addr).push(s.name);
        this.names[s.name.toLowerCase()] = s.addr;
      }
      this.map = F().memoryMap(header);
      this.prevCpu = null;
      this.cpu = null;
      this.seenPrev = new Map();
      this.seenCur = new Map();
      this.seenKey = null;
      this.memAddr = header.ramBase & ~15;
      this.trace = [];
      for (const w of this.watches) { w.prev = null; w.cur = null; }
      $('#dbg-trace', this.el).textContent = '';
      $('#dbg-reason', this.el).textContent = '';
      this.renderBreakpoints();
      this._renderWatch();
    }

    stats(insns, ips) {
      $('#dbg-stats', this.el).textContent = insns.toLocaleString('pt-BR') + ' instr' +
        (ips ? ' · ' + (ips >= 1e6 ? (ips / 1e6).toFixed(1) + ' M' : ips.toLocaleString('pt-BR') + ' ') + 'instr/s' : '');
    }

    reason(text) { $('#dbg-reason', this.el).textContent = text || ''; }

    /* Retrato enviado pelo worker em cada parada. */
    snapshot(s) {
      if (this.cpu && (this.cpu.insns !== s.cpu.insns || this.cpu.pc !== s.cpu.pc)) this.prevCpu = this.cpu;
      this.cpu = s.cpu;
      this.window = s.window;
      this.stack = s.stack;
      this.fault = s.fault;
      this.trace = s.trace || [];
      this.traceTotal = s.traceTotal;
      if (!this.open) return;
      this._renderRegs();
      this._renderStack();
      this._renderTrace();
      this._memGo(this.memAddr);
      this._readWatches();
    }

    _renderRegs() {
      const box = $('#dbg-regs', this.el);
      if (!this.cpu) { box.textContent = ''; return; }
      const fmt = F();
      const rows = fmt.regRows(this.cpu, this.prevCpu);
      const t = h('table', { class: 'regs mono' });
      const cols = this.showFloat ? ['', 'hex', 'dec', 'f32'] : ['', 'hex', 'dec'];
      t.append(h('tr', {}, ...cols.concat(cols).map((c) => h('th', {}, c))));
      const cells = (r) => {
        const attrs = (cls) => ({ class: (cls || '') + (r.changed ? ' chg' : ''), title: r.name + ' = ' + r.hex + ' = ' + r.udec + ' (sem sinal) = ' + r.f32 + ' (float)' });
        const list = [h('td', attrs('rn'), r.name), h('td', attrs(), r.hex), h('td', attrs(), r.dec)];
        if (this.showFloat) list.push(h('td', attrs(), r.f32));
        return list;
      };
      for (let i = 0; i < 16; i++) t.append(h('tr', {}, ...cells(rows[i]), ...cells(rows[i + 16])));
      const pcChanged = this.prevCpu && this.prevCpu.pc !== this.cpu.pc ? ' chg' : '';
      const flChanged = this.prevCpu && this.prevCpu.flags !== this.cpu.flags ? ' chg' : '';
      const fl = h('td', { colspan: String(cols.length - 1), class: flChanged });
      for (const f of fmt.flagsList(this.cpu.flags)) fl.append(h('span', { class: 'flag' + (f.set ? ' on' : '') }, f.name));
      t.append(h('tr', {},
        h('td', { class: 'rn' + pcChanged }, 'pc'), h('td', { class: pcChanged }, '0x' + fmt.hex(this.cpu.pc)),
        h('td', { class: pcChanged, colspan: String(cols.length - 2) }, String(this.cpu.pc >>> 0)),
        h('td', { class: 'rn' + flChanged }, 'flags'), fl));
      box.replaceChildren(t);
    }

    /* Registrador alterado desde a parada anterior? (para a ajuda do editor) */
    regChanged(i) { return !!(this.prevCpu && this.cpu && this.prevCpu.r[i] !== this.cpu.r[i]); }

    toggleBp(addr) {
      addr >>>= 0;
      const src = this.app.breakpoints ? this.app.breakpoints().find((b) => b.addr === addr) : null;
      if (src && this.app.removeBreakpoint) this.app.removeBreakpoint(src);
      else if (this.bps.has(addr)) this.bps.delete(addr);
      else if (this.app.addAddrBreakpoint) this.app.addAddrBreakpoint(addr);
      else this.bps.add(addr);
      this.sync();
    }

    hasBp(addr) { return this.bpAddrs().includes(addr >>> 0); }

    _addBpFromInput() {
      const inp = $('#dbg-bp-in', this.el);
      const a = F().parseAddress(inp.value, this.cpu, this.names);
      if (a === null || (a & 3)) { inp.classList.add('bad'); return; }
      inp.classList.remove('bad');
      inp.value = '';
      if (!this.hasBp(a)) this.toggleBp(a);
    }

    renderBreakpoints() {
      const ul = $('#dbg-bps', this.el);
      ul.textContent = '';
      const list = (this.app.breakpoints ? this.app.breakpoints() : []).map((b) => Object.assign({ kind: 'src' }, b));
      for (const a of this.bps) if (!list.some((b) => b.addr === a)) list.push({ addr: a, kind: 'addr' });
      list.sort((x, y) => (x.addr === null ? 1e12 : x.addr) - (y.addr === null ? 1e12 : y.addr) || String(x.file).localeCompare(String(y.file)) || (x.line || 0) - (y.line || 0));
      for (const b of list) {
        const names = b.addr !== null && b.addr !== undefined ? this.symByAddr.get(b.addr) : null;
        const li = h('li', {},
          h('span', {}, b.addr !== null && b.addr !== undefined ? '0x' + F().hex(b.addr) : b.pending ? '(pendente)' : '(sem código)'),
          b.file ? h('a', { onclick: () => this.app.gotoSource && this.app.gotoSource(b.file, b.line), title: 'ir para o fonte' }, b.file + ':' + b.line) : null,
          names ? h('span', { class: 'src' }, names.join(', ')) : null,
          b.moved ? h('span', { class: 'src', title: 'a linha marcada não gera código' }, '(movido da ' + b.moved + ')') : null,
          b.pending ? h('span', { class: 'src', title: 'a linha é nova desde a montagem da imagem carregada: o breakpoint vale depois de remontar (Executar/Reiniciar)' }, 'linha nova: remonte') : null,
          h('button', { class: 'small', title: 'remover', 'aria-label': 'remover breakpoint', onclick: () => {
            if (b.kind === 'addr') this.bps.delete(b.addr); else if (this.app.removeBreakpoint) this.app.removeBreakpoint(b);
            this.sync();
          } }, '×'));
        ul.append(li);
      }
      if (!list.length) ul.append(h('li', { class: 'muted' }, 'nenhum (F9 ou clique no gutter do editor)'));
    }

    _renderStack() {
      const box = $('#dbg-stack', this.el);
      box.textContent = '';
      if (!this.stack || !this.cpu) return;
      const rows = F().stackRows(this.stack.sp, this.stack.words, this.stack.readable, this.cpu, this.header ? this.header.codeSize : 0);
      for (const r of rows) {
        const names = r.marks.includes('ret?') ? this._nearestSym(r.value) : '';
        box.append(h('div', { class: 'sl' + (r.marks.includes('fp') ? ' fp' : '') },
          h('span', { class: 'ad' }, F().hex(r.addr)), '  ', r.hex, '  ',
          h('span', { class: 'marks' }, r.marks.join(' ') + (names ? ' ' + names : ''))));
      }
    }

    _nearestSym(addr) {
      let best = null;
      for (const s of this.symbols) if (s.addr <= addr && s.addr < (this.header ? this.header.codeSize : 0) && (!best || s.addr > best.addr)) best = s;
      return best ? '<' + best.name + (addr - best.addr ? '+0x' + (addr - best.addr).toString(16) : '') + '>' : '';
    }

    _renderTrace() {
      const pre = $('#dbg-trace', this.el);
      if (!this.trace.length) {
        pre.textContent = this.config().traceN ? '(vazio)' : '(trace desligado)';
        return;
      }
      pre.textContent = (this.traceTotal > this.trace.length ? '... ' + (this.traceTotal - this.trace.length) + ' registros antes\n' : '') +
        this.trace.map((t) => t.line).join('');
      pre.scrollTop = pre.scrollHeight;
    }

    _gotoInput() {
      const inp = $('#dbg-mem-in', this.el);
      const a = F().parseAddress(inp.value, this.cpu, this.names);
      if (a === null) { inp.classList.add('bad'); return; }
      inp.classList.remove('bad');
      this._memGo(a & ~15);
    }

    _memGo(addr) {
      this.memAddr = addr >>> 0;
      this.app.send({ type: 'mem', addr: this.memAddr, len: 256, id: ++this.memId });
    }

    /* ---- watch ---- */

    setWatches(list) {
      this.watches = (list || []).map((expr) => ({ expr, addr: null, prev: null, cur: null, err: null }));
      this._renderWatch();
      this._readWatches();
    }

    _addWatchFromInput() {
      const inp = $('#dbg-watch-in', this.el);
      const expr = inp.value.trim();
      if (!expr) return;
      inp.value = '';
      this.watches.push({ expr, addr: null, prev: null, cur: null, err: null });
      if (this.app.watchesChanged) this.app.watchesChanged(this.watches.map((w) => w.expr));
      this._renderWatch();
      this._readWatches();
    }

    _readWatches() {
      if (!this.header) return;
      this.watches.forEach((w, i) => {
        const a = F().parseAddress(w.expr, this.cpu, this.names);
        w.addr = a;
        w.err = a === null ? 'expressão inválida' : null;
        if (a !== null) this.app.send({ type: 'mem', addr: a >>> 0, len: 64, id: WATCH_ID0 + i });
      });
      this._renderWatch();
    }

    _watchData(i, m) {
      const w = this.watches[i];
      if (!w) return;
      const b = m.bytes, k = m.mask;
      const ok4 = k[0] && k[1] && k[2] && k[3];
      const word = ok4 ? (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0 : null;
      const key = this.cpu ? this.cpu.insns + ':' + this.cpu.pc : '';
      if (w.curKey !== key) { w.prev = w.cur; w.curKey = key; }
      w.cur = { word, byte: k[0] ? b[0] : null, str: cString(b, k, 40) };
      this._renderWatch();
    }

    _renderWatch() {
      const t = $('#dbg-watch', this.el);
      if (!t) return;
      t.textContent = '';
      if (!this.watches.length) { t.append(h('tr', {}, h('td', { class: 'muted' }, 'digite um rótulo ou endereço: mostra word, byte, float e string'))); return; }
      t.append(h('tr', {}, h('th', {}, 'expr'), h('th', {}, 'valor'), h('th', {}, '')));
      const fmt = F();
      this.watches.forEach((w, i) => {
        let val, cls = 'wv';
        if (w.err) { val = w.err; cls += ' bad'; }
        else if (!w.cur) val = w.addr !== null ? '@0x' + fmt.hex(w.addr) : '';
        else if (w.cur.word === null && w.cur.byte === null) { val = '@0x' + fmt.hex(w.addr) + ' ilegível'; cls += ' bad'; }
        else {
          const c = w.cur;
          const parts = ['@0x' + fmt.hex(w.addr)];
          if (c.word !== null) parts.push('word 0x' + fmt.hex(c.word) + ' = ' + (c.word | 0), 'float ' + fmt.f32Str(c.word));
          if (c.byte !== null) parts.push('byte 0x' + c.byte.toString(16).toUpperCase().padStart(2, '0') + ' = ' + c.byte + (c.byte >= 32 && c.byte < 127 ? " '" + String.fromCharCode(c.byte) + "'" : ''));
          parts.push('str ' + c.str);
          val = parts.join(' · ');
        }
        const changed = w.prev && w.cur && w.prev.word !== w.cur.word;
        t.append(h('tr', { class: changed ? 'chg' : '' },
          h('td', { class: 'wn' }, w.expr), h('td', { class: cls }, val),
          h('td', {}, h('button', { class: 'small', 'aria-label': 'remover watch ' + w.expr, onclick: () => {
            this.watches.splice(i, 1);
            if (this.app.watchesChanged) this.app.watchesChanged(this.watches.map((x) => x.expr));
            this._renderWatch();
          } }, '×'))));
      });
    }

    /* Resposta do worker a 'mem' (hexdump ou watch). */
    memData(m) {
      if (m.id >= WATCH_ID0) { this._watchData(m.id - WATCH_ID0, m); return; }
      if (m.id !== this.memId || !this.open) return;
      const fmt = F();
      const key = this._stopKey();
      if (key !== this.seenKey) {
        this.seenPrev = new Map([...(this.seenPrev || []), ...(this.seenCur || [])]);
        this.seenCur = new Map();
        this.seenKey = key;
      }
      const rows = fmt.hexdumpRows(m.addr, m.bytes, m.mask, { regions: this.map });
      for (const r of rows) {
        for (const c of r.cells) {
          if (!c || !c.readable) continue;
          const old = this.seenPrev.get(c.addr);
          c.changed = old !== undefined && old !== c.byte;
          this.seenCur.set(c.addr, c.byte);
        }
      }
      const box = $('#dbg-mem', this.el);
      const frag = document.createDocumentFragment();
      const pc = this.cpu ? this.cpu.pc : -1, sp = this.cpu ? this.cpu.r[31] : -1;
      for (const r of rows) {
        const line = h('div', { class: 'hl' }, h('span', { class: 'ad' }, fmt.hex(r.addr)), ' ');
        r.cells.forEach((c, j) => {
          if (!c) { line.append('   '); return; }
          const cls = ['hb'];
          if (c.region) cls.push('rg-' + c.region);
          if (c.changed) cls.push('chg');
          if (!c.readable) cls.push('unr');
          if (c.addr === pc) cls.push('at-pc');
          if (c.addr === sp) cls.push('at-sp');
          line.append(h('span', { class: cls.join(' '), title: '0x' + fmt.hex(c.addr) + (c.region ? ' ' + c.region : '') }, c.text), j === 7 ? '  ' : ' ');
        });
        line.append(' ', h('span', { class: 'asc' }, r.ascii));
        frag.append(line);
      }
      box.replaceChildren(frag);
    }

    _stopKey() { return this.cpu ? this.cpu.insns + ':' + this.cpu.pc : ''; }
  }

  DebuggerPanel.WATCH_ID0 = WATCH_ID0;
  root.DebuggerPanel = DebuggerPanel;
})(typeof self !== 'undefined' ? self : this);
