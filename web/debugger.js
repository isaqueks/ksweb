/*
 * debugger.js — painel "Depurador" (DOM). Mostra o retrato que o worker
 * manda a cada parada (registradores, disassembly ao redor do pc, pilha,
 * trace) e pede ao worker a janela de memória do hexdump. Os
 * breakpoints e as opções de parada vivem no laço C (ksweb_run); este
 * painel só mantém a lista e a reenvia. Fechado, o depurador desliga
 * trace e checagens (o laço volta ao caminho rápido).
 *
 * Formatação: format.js (KsFormat), testada em Node.
 */
(function (root) {
  'use strict';
  /* global KsFormat */
  const F = () => root.KsFormat;
  const $ = (sel, el) => (el || document).querySelector(sel);

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

  class DebuggerPanel {
    /* app: {send(msg), step(n), run(), pause(), restart()} */
    constructor(el, app) {
      this.el = el;
      this.app = app;
      this.open = false;
      this.bps = new Set();
      this.prevCpu = null;
      this.cpu = null;
      this.header = null;
      this.regions = [];
      this.symbols = [];
      this.symByAddr = new Map();
      this.names = {};
      this.memAddr = 0;
      this.memPrev = null;
      this.memId = 0;
      this.showFloat = false;
      this.trace = [];
      this.traceTotal = 0;
      this._build();
    }

    _build() {
      const el = this.el;
      el.innerHTML = '';
      el.append(
        h('div', { class: 'dbg-head' },
          h('strong', {}, 'Depurador'),
          h('span', { class: 'dbg-stats', id: 'dbg-stats' }, '')),
        h('section', { class: 'dbg-sec' },
          h('div', { class: 'row' },
            h('button', { onclick: () => this.app.run(), title: 'Continuar (F8)' }, 'Continuar'),
            h('button', { onclick: () => this.app.pause(), title: 'Parar (Ctrl+Alt+C)' }, 'Parar'),
            h('button', { onclick: () => this.app.step(1), title: 'Uma instrução (F10)' }, 'Passo'),
            h('button', { onclick: () => this.app.step(this._stepN()) }, 'Passo N'),
            h('input', { id: 'dbg-stepn', type: 'number', min: '1', value: '100', class: 'num', title: 'N' }),
            h('button', { onclick: () => this.app.restart() }, 'Reiniciar')),
          h('div', { class: 'row' },
            h('label', {}, h('input', { type: 'checkbox', id: 'dbg-brk', checked: 'checked', onchange: () => this._sendCfg() }), ' parar em BRK'),
            h('label', {}, h('input', { type: 'checkbox', id: 'dbg-sys', onchange: () => this._sendCfg() }), ' parar em syscall'),
            h('label', {}, h('input', { type: 'checkbox', id: 'dbg-trace', checked: 'checked', onchange: () => this._sendCfg() }), ' trace'),
            h('input', { id: 'dbg-tracen', type: 'number', min: '1', max: '65536', value: '1000', class: 'num', title: 'registros guardados', onchange: () => this._sendCfg() })),
          h('div', { class: 'dbg-reason', id: 'dbg-reason' }, '')),
        this._section('Registradores', 'regs',
          h('label', { class: 'small' }, h('input', { type: 'checkbox', onchange: (e) => { this.showFloat = e.target.checked; this._renderRegs(); } }), ' float'),
          h('div', { id: 'dbg-regs', class: 'dbg-regs' })),
        this._section('Disassembly', 'dis', null,
          h('div', { id: 'dbg-dis', class: 'dbg-list mono', title: 'clique numa linha para ligar/desligar breakpoint' })),
        this._section('Breakpoints', 'bp', null,
          h('div', { class: 'row' },
            h('input', { id: 'dbg-bp-in', placeholder: '0x1C, rótulo, pc+8', class: 'addr', onkeydown: (e) => { if (e.key === 'Enter') this._addBpFromInput(); } }),
            h('button', { onclick: () => this._addBpFromInput() }, 'Adicionar'),
            h('button', { onclick: () => { this.bps.clear(); this._sendCfg(); this._renderBps(); this._renderDis(); } }, 'Limpar')),
          h('ul', { id: 'dbg-bps', class: 'dbg-bps mono' })),
        this._section('Pilha', 'stack', null, h('div', { id: 'dbg-stack', class: 'dbg-list mono' })),
        this._section('Memória', 'mem', null,
          h('div', { class: 'row' },
            h('input', { id: 'dbg-mem-in', placeholder: 'endereço', class: 'addr', onkeydown: (e) => { if (e.key === 'Enter') this._gotoInput(); } }),
            h('button', { onclick: () => this._gotoInput() }, 'Ir'),
            h('button', { onclick: () => this._memGo(this.memAddr - 256) }, '◀'),
            h('button', { onclick: () => this._memGo(this.memAddr + 256) }, '▶')),
          h('div', { class: 'row', id: 'dbg-mem-jumps' }),
          h('div', { id: 'dbg-mem', class: 'dbg-hex mono' }),
          h('div', { class: 'legend small' },
            h('span', { class: 'rg-code' }, 'CODE'), ' ', h('span', { class: 'rg-data' }, '.data'), ' ',
            h('span', { class: 'rg-bss' }, '.bss'), ' ', h('span', { class: 'rg-heap' }, 'heap'), ' ',
            h('span', { class: 'rg-stack' }, 'pilha'), ' ', h('span', { class: 'chg' }, 'alterado'))),
        this._section('Trace', 'trace',
          h('span', {},
            h('button', { onclick: () => this.app.send({ type: 'trace-export' }), title: 'mesmo formato do ksvm --trace' }, 'Exportar .txt')),
          h('pre', { id: 'dbg-trace', class: 'dbg-trace mono' }))
      );
      const jumps = $('#dbg-mem-jumps', el);
      for (const [label, fn] of [
        ['pc', () => this.cpu && this.cpu.pc], ['sp', () => this.cpu && this.cpu.r[31]], ['fp', () => this.cpu && this.cpu.r[30]],
        ['CODE', () => 0], ['RAM', () => this.header && this.header.ramBase],
        ['.data', () => this.header && this.header.ramBase],
        ['.bss', () => this.header && this.header.ramBase + this.header.dataSize],
        ['heap', () => this.header && this.header.heapStart]]) {
        jumps.append(h('button', { class: 'small', onclick: () => { const a = fn(); if (a !== undefined && a !== null) this._memGo(a & ~15); } }, label));
      }
    }

    _section(title, id, extra, ...body) {
      return h('details', { class: 'dbg-sec', open: 'open', id: 'dbg-sec-' + id },
        h('summary', {}, title, extra ? h('span', { class: 'sum-extra' }, extra) : null), ...body);
    }

    _stepN() { return Math.max(1, parseInt($('#dbg-stepn', this.el).value, 10) || 1); }

    config() {
      return {
        on: this.open,
        bps: Array.from(this.bps),
        stopBrk: $('#dbg-brk', this.el).checked,
        stopSyscall: $('#dbg-sys', this.el).checked,
        traceN: $('#dbg-trace', this.el).checked ? Math.max(1, Math.min(65536, parseInt($('#dbg-tracen', this.el).value, 10) || 1000)) : 0
      };
    }

    _sendCfg() { this.app.send({ type: 'debug', debug: this.config() }); }

    setOpen(on) {
      this.open = on;
      this.el.hidden = !on;
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
      $('#dbg-trace', this.el).textContent = '';
      $('#dbg-reason', this.el).textContent = '';
      this._renderBps();
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
      this._renderDis();
      this._renderStack();
      this._renderTrace();
      this._memGo(this.memAddr);
    }

    _renderRegs() {
      const box = $('#dbg-regs', this.el);
      if (!this.cpu) { box.textContent = ''; return; }
      const fmt = F();
      const rows = fmt.regRows(this.cpu, this.prevCpu);
      /* duas colunas: r0..r15 | r16..r31; título de cada célula = sem sinal e float */
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

    _renderDis() {
      const box = $('#dbg-dis', this.el);
      box.textContent = '';
      if (!this.window) return;
      let curEl = null;
      for (const ins of this.window) {
        for (const name of this.symByAddr.get(ins.addr) || []) box.append(h('div', { class: 'lbl' }, name + ':'));
        const bp = this.bps.has(ins.addr);
        const faulted = this.fault && ins.current;
        const line = h('div', {
          class: 'dl' + (ins.current ? ' cur' : '') + (bp ? ' bp' : '') + (faulted ? ' fault' : ''),
          onclick: () => this.toggleBp(ins.addr)
        }, h('span', { class: 'dot' }, bp ? '●' : ' '), h('span', { class: 'ad' }, F().hex(ins.addr)), '  ', ins.text);
        box.append(line);
        if (ins.current) curEl = line;
      }
      /* rola só a lista (scrollIntoView rolaria o painel inteiro) */
      if (curEl) box.scrollTop = curEl.offsetTop - box.clientHeight / 2;
    }

    toggleBp(addr) {
      addr >>>= 0;
      if (this.bps.has(addr)) this.bps.delete(addr); else this.bps.add(addr);
      this._sendCfg();
      this._renderBps();
      this._renderDis();
    }

    _addBpFromInput() {
      const inp = $('#dbg-bp-in', this.el);
      const a = F().parseAddress(inp.value, this.cpu, this.names);
      if (a === null || (a & 3)) { inp.classList.add('bad'); return; }
      inp.classList.remove('bad');
      inp.value = '';
      this.bps.add(a);
      this._sendCfg();
      this._renderBps();
      this._renderDis();
    }

    _renderBps() {
      const ul = $('#dbg-bps', this.el);
      ul.textContent = '';
      for (const a of Array.from(this.bps).sort((x, y) => x - y)) {
        const names = this.symByAddr.get(a);
        ul.append(h('li', {}, '0x' + F().hex(a) + (names ? '  ' + names.join(', ') : ''), ' ',
          h('button', { class: 'small', title: 'remover', onclick: () => this.toggleBp(a) }, '×')));
      }
      if (!this.bps.size) ul.append(h('li', { class: 'muted' }, 'nenhum'));
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

    /* Resposta do worker a 'mem'. */
    memData(m) {
      if (m.id !== this.memId || !this.open) return;
      const fmt = F();
      /* "alterado" = diferente do que se viu neste endereço na parada anterior */
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

  root.DebuggerPanel = DebuggerPanel;
})(typeof self !== 'undefined' ? self : this);
