/*
 * terminal.js — renderização de uma VtScreen (vt.js) no DOM e teclado.
 *
 * A tela é uma lista fixa de <div> (uma por linha) redesenhada só quando a
 * linha está suja; as linhas que rolam para fora viram <div> estáticos no
 * histórico acima dela, dentro do mesmo contêiner com rolagem (até
 * VtScreen.maxScrollback). Uma linha = <span>s com atributos iguais
 * agrupados. Selecionar com o mouse e copiar (Ctrl+C com seleção) funciona
 * porque é texto comum.
 *
 * Mensagens do runner (carga, fim, fault) passam por writeSystem: entram na
 * mesma grade com o atributo SYSTEM (cor própria, prefixo) e sem herdar as
 * cores do guest.
 *
 * Teclado: modo linha (LineEditor, eco local) ou raw (keyToBytes, cada
 * tecla vai direto). onData(string) recebe o que deve ir para o stdin.
 */
(function (root) {
  'use strict';
  /* global VtScreen, ATTR, palette256, keyToBytes, LineEditor */

  const SYSTEM = 1024;           /* bit extra de célula: mensagem do runner */

  function esc(s) {
    return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  function rgbCss(v) {
    if (v & 0x1000000) {
      return 'rgb(' + ((v >> 16) & 255) + ',' + ((v >> 8) & 255) + ',' + (v & 255) + ')';
    }
    const p = palette256(v);
    return p ? 'rgb(' + p.join(',') + ')' : null;
  }

  /* Classe/estilo de uma cor: -1 padrão, 0..15 classe do tema, resto inline. */
  function colorAttr(v, kind, cls, style) {
    if (v < 0) return;
    if (v < 16) { cls.push(kind + v); return; }
    const c = rgbCss(v);
    if (c) style.push((kind === 'f' ? 'color:' : 'background:') + c);
  }

  function cellStyle(c) {
    const cls = [], style = [];
    let fg = c.fg, bg = c.bg;
    const fl = c.fl;
    if (fl & SYSTEM) cls.push('sys');
    if (fl & ATTR.INVERSE) {
      [fg, bg] = [bg, fg];
      if (fg < 0) cls.push('inv-f');
      if (bg < 0) cls.push('inv-b');
    }
    if ((fl & ATTR.BOLD) && fg >= 0 && fg < 8) fg += 8;    /* negrito clareia, como no xterm */
    colorAttr(fg, 'f', cls, style);
    colorAttr(bg, 'b', cls, style);
    if (fl & ATTR.BOLD) cls.push('bo');
    if (fl & ATTR.DIM) cls.push('dim');
    if (fl & ATTR.ITALIC) cls.push('it');
    if (fl & ATTR.UNDERLINE) cls.push(fl & ATTR.STRIKE ? 'ul-st' : 'ul');
    else if (fl & ATTR.STRIKE) cls.push('st');
    if (fl & ATTR.BLINK) cls.push('bl');
    if (fl & ATTR.HIDDEN) cls.push('hid');
    return { key: cls.join(' ') + '|' + style.join(';'), cls: cls.join(' '), style: style.join(';') };
  }

  /* HTML de uma linha; cursorX >= 0 desenha o cursor nessa coluna. */
  function lineHTML(line, cursorX, cursorCls) {
    let html = '', runKey = null, runText = '', runSt = null;
    const flush = () => {
      if (runText === '') return;
      if (runSt.cls || runSt.style) {
        html += '<span' + (runSt.cls ? ' class="' + runSt.cls + '"' : '') +
          (runSt.style ? ' style="' + runSt.style + '"' : '') + '>' + runText + '</span>';
      } else {
        html += runText;
      }
      runText = '';
    };
    const cells = line.cells;
    let last = cells.length;
    /* espaços finais sem atributo não precisam virar texto (cópia limpa) */
    while (last > 0 && last - 1 !== cursorX) {
      const c = cells[last - 1];
      if (c.c !== ' ' || c.bg >= 0 || (c.fl & (ATTR.INVERSE | ATTR.UNDERLINE | ATTR.STRIKE))) break;
      last--;
    }
    for (let x = 0; x < last; x++) {
      const c = cells[x];
      if (c.fl & ATTR.WIDE_CONT) continue;
      const st = cellStyle(c);
      let text = esc(c.c === '' ? ' ' : c.c);
      if (c.fl & ATTR.WIDE) text = '<span class="w2">' + text + '</span>';
      if (x === cursorX) {
        flush();
        runKey = null;
        html += '<span class="' + cursorCls + (st.cls ? ' ' + st.cls : '') + '"' +
          (st.style ? ' style="' + st.style + '"' : '') + '>' + text + '</span>';
        continue;
      }
      if (st.key !== runKey) { flush(); runKey = st.key; runSt = st; }
      runText += text;
    }
    flush();
    return html || '';
  }

  class TerminalView {
    constructor(container, opts) {
      opts = opts || {};
      this.el = container;
      this.el.classList.add('term');
      this.el.tabIndex = 0;
      this.history = document.createElement('div');
      this.history.className = 'term-history';
      this.screenEl = document.createElement('div');
      this.screenEl.className = 'term-screen';
      this.el.appendChild(this.history);
      this.el.appendChild(this.screenEl);
      this.onData = opts.onData || (() => {});
      this.onEof = opts.onEof || (() => {});
      this.onInterrupt = opts.onInterrupt || (() => {});
      this.onTitle = opts.onTitle || (() => {});
      this.onResize = opts.onResize || (() => {});
      this.lineMode = true;
      this.backspace = '\x7f';
      this.fit = opts.fit !== false;
      this.screen = new VtScreen({
        cols: opts.cols || 80, rows: opts.rows || 24, scrollback: opts.scrollback || 5000,
        onResponse: (s) => this.onData(s), onTitle: (t) => this.onTitle(t), onBell: () => this._bell()
      });
      this.editor = new LineEditor({
        echo: (s) => { this.screen.write(s); this._queue(); },
        send: (s) => this.onData(s),
        eof: () => this.onEof()
      });
      this.rowEls = [];
      this.historyIds = new Set();
      this.cursorRow = -1;
      this.focused = false;
      this.pending = false;
      this._buildRows();
      this._bindEvents();
      if (this.fit && typeof ResizeObserver !== 'undefined') {
        this.ro = new ResizeObserver(() => this.fitToContainer());
        this.ro.observe(this.el);
      }
      this._queue();
    }

    _buildRows() {
      this.screenEl.textContent = '';
      this.rowEls = [];
      for (let y = 0; y < this.screen.rows; y++) {
        const d = document.createElement('div');
        d.className = 'tl';
        this.screenEl.appendChild(d);
        this.rowEls.push(d);
      }
      this.screen.allDirty = true;
    }

    _bindEvents() {
      this.el.addEventListener('keydown', (e) => this._keydown(e));
      this.el.addEventListener('focus', () => { this.focused = true; this._dirtyCursor(); });
      this.el.addEventListener('blur', () => { this.focused = false; this._dirtyCursor(); });
      /* No document: alguns navegadores entregam o paste ao body quando o
       * foco está num elemento não editável. */
      document.addEventListener('paste', (e) => {
        if (document.activeElement !== this.el) return;
        const t = (e.clipboardData || window.clipboardData).getData('text');
        if (t) { e.preventDefault(); this.paste(t); }
      });
    }

    _bell() {
      this.el.classList.remove('bell');
      void this.el.offsetWidth;
      this.el.classList.add('bell');
    }

    _dirtyCursor() {
      if (this.cursorRow >= 0 && this.cursorRow < this.screen.rows) this.screen.lines[this.cursorRow].dirty = true;
      this._queue();
    }

    _keydown(e) {
      if (e.isComposing || e.keyCode === 229) return;
      /* Interromper a VM: Ctrl+Alt+C ou Pause/Break. */
      if ((e.ctrlKey && e.altKey && (e.key === 'c' || e.key === 'C')) || e.key === 'Pause' || e.key === 'Cancel') {
        e.preventDefault();
        this.onInterrupt();
        return;
      }
      /* Ctrl+C com seleção: copiar (comportamento normal do navegador). */
      const sel = window.getSelection ? window.getSelection() : null;
      if (e.ctrlKey && !e.altKey && (e.key === 'c' || e.key === 'C') && sel && !sel.isCollapsed &&
          this.el.contains(sel.anchorNode)) return;
      if ((e.ctrlKey || e.metaKey) && (e.key === 'v' || e.key === 'V') && !e.altKey) return;  /* colar */
      if (e.metaKey) return;
      if (e.shiftKey && (e.key === 'PageUp' || e.key === 'PageDown')) {
        e.preventDefault();
        this.el.scrollTop += (e.key === 'PageUp' ? -1 : 1) * this.el.clientHeight * 0.9;
        return;
      }
      if (this.lineMode) {
        if (this.editor.key(e)) { e.preventDefault(); this._scrollToBottom(); }
        return;
      }
      const ev = { key: e.key, ctrlKey: e.ctrlKey, altKey: e.altKey, shiftKey: e.shiftKey, metaKey: e.metaKey,
        altGraph: e.getModifierState && e.getModifierState('AltGraph') };
      const s = keyToBytes(ev, { appCursor: this.screen.appCursor, backspace: this.backspace });
      if (s !== null) {
        e.preventDefault();
        this.onData(s);
        this._scrollToBottom();
      }
    }

    paste(text) {
      if (this.lineMode) {
        this.editor.paste(text);
      } else {
        const t = text.replace(/\r?\n/g, '\r');
        this.onData(this.screen.bracketedPaste ? '\x1b[200~' + t + '\x1b[201~' : t);
      }
    }

    setLineMode(on) {
      this.lineMode = on;
      this.editor.clear();
    }

    /* Saída do guest (bytes UTF-8). */
    write(bytes) {
      this.screen.write(bytes);
      this._queue();
    }

    /* Mensagem do runner: linha própria, cor própria, sem as cores do guest. */
    writeSystem(text, kind) {
      const s = this.screen;
      const save = { fg: s.fg, bg: s.bg, fl: s.fl, g: s.g.slice(), gl: s.gl, autowrap: s.autowrap };
      if (s.x !== 0 || s.wrapPending) s.write('\r\n');
      s.fg = kind === 'error' ? 1 : kind === 'ok' ? 2 : -1;
      s.bg = -1;
      s.fl = SYSTEM | (kind === 'error' ? ATTR.BOLD : 0);
      s.g = ['B', 'B']; s.gl = 0; s.autowrap = true;
      for (const line of String(text).split('\n')) s.write('[ksweb] ' + line + '\r\n');
      s.fg = save.fg; s.bg = save.bg; s.fl = save.fl; s.g = save.g; s.gl = save.gl; s.autowrap = save.autowrap;
      this.editor.clear();
      this._queue();
    }

    clear() {
      this.screen.reset();
      this.screen.scrollback = [];
      this.screen.takeScrolledOut();
      this.history.textContent = '';
      this.screen.allDirty = true;
      this.editor.clear();
      this._queue();
    }

    resize(cols, rows) {
      if (cols === this.screen.cols && rows === this.screen.rows) return;
      this.screen.resize(cols, rows);
      this._buildRows();
      this.onResize(cols, rows);
      this._queue();
    }

    /* Tamanho de uma célula medido com o tema atual. */
    cellSize() {
      const probe = document.createElement('span');
      probe.textContent = 'MMMMMMMMMM';
      probe.style.visibility = 'hidden';
      probe.style.position = 'absolute';
      this.screenEl.appendChild(probe);
      const r = probe.getBoundingClientRect();
      probe.remove();
      const lh = this.rowEls[0] ? this.rowEls[0].getBoundingClientRect().height : r.height;
      return { w: r.width / 10 || 8, h: lh || 16 };
    }

    fitToContainer() {
      if (!this.fit) return;
      const cs = this.cellSize();
      const st = getComputedStyle(this.el);
      const w = this.el.clientWidth - parseFloat(st.paddingLeft) - parseFloat(st.paddingRight) - 2;
      const h = this.el.clientHeight - parseFloat(st.paddingTop) - parseFloat(st.paddingBottom);
      const cols = Math.max(20, Math.min(400, Math.floor(w / cs.w)));
      const rows = Math.max(5, Math.min(200, Math.floor(h / cs.h)));
      this.resize(cols, rows);
    }

    _queue() {
      if (this.pending) return;
      this.pending = true;
      const raf = typeof requestAnimationFrame !== 'undefined' ? requestAnimationFrame : (f) => setTimeout(f, 16);
      raf(() => { this.pending = false; this.render(); });
    }

    _atBottom() {
      return this.el.scrollHeight - this.el.scrollTop - this.el.clientHeight < 4;
    }

    _scrollToBottom() { this.el.scrollTop = this.el.scrollHeight; }

    render() {
      const s = this.screen;
      const stick = this._atBottom();
      if (s.scrollbackCleared) { this.history.textContent = ''; s.scrollbackCleared = false; }
      const gone = s.takeScrolledOut();
      if (gone.length) {
        const frag = document.createDocumentFragment();
        for (const l of gone) {
          const d = document.createElement('div');
          d.className = 'tl';
          d.innerHTML = lineHTML(l, -1, '');
          frag.appendChild(d);
        }
        this.history.appendChild(frag);
        let extra = this.history.childElementCount - s.maxScrollback;
        while (extra-- > 0) this.history.firstChild.remove();
      }
      this.history.hidden = s.altActive;
      const cy = s.cursorVisible ? s.y : -1;
      if (this.cursorRow !== cy) {
        if (this.cursorRow >= 0 && this.cursorRow < s.rows) s.lines[this.cursorRow].dirty = true;
        if (cy >= 0) s.lines[cy].dirty = true;
      } else if (cy >= 0) {
        s.lines[cy].dirty = true;           /* coluna pode ter mudado */
      }
      const cursorCls = 'cur' + (this.focused ? '' : ' cur-blur');
      for (let y = 0; y < s.rows; y++) {
        const l = s.lines[y];
        if (!l.dirty && !s.allDirty) continue;
        this.rowEls[y].innerHTML = lineHTML(l, y === cy ? s.x : -1, cursorCls);
        l.dirty = false;
      }
      this.cursorRow = cy;
      s.allDirty = false;
      if (stick || gone.length) this._scrollToBottom();
    }

    /* Texto da tela + histórico (para copiar tudo). */
    allText() {
      const s = this.screen;
      const lines = s.scrollback.map((l) => VtScreen.lineToText(l).replace(/\s+$/, ''));
      for (let y = 0; y < s.rows; y++) lines.push(s.lineText(y));
      return lines.join('\n').replace(/\n+$/, '\n');
    }
  }

  TerminalView.lineHTML = lineHTML;
  TerminalView.SYSTEM = SYSTEM;
  root.TerminalView = TerminalView;
})(typeof self !== 'undefined' ? self : this);
