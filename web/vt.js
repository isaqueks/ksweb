/*
 * vt.js — emulador de terminal VT100/xterm puro (sem DOM).
 *
 *   Utf8Decoder  bytes -> code points, com estado entre chamadas (um
 *                caractere multibyte pode chegar partido entre fatias)
 *   VtScreen     parser de escape (máquina de estados no estilo do
 *                diagrama de Paul Williams em vt100.net) + modelo de tela:
 *                grade de células, cursor, atributos SGR, região de
 *                rolagem, tela alternativa, conjuntos de caracteres G0/G1
 *                (ASCII e DEC special graphics), tabulações, histórico
 *                (scrollback) e linhas sujas para o renderizador
 *
 * Sequências suportadas: docs/06-terminal.md. Sequências desconhecidas são
 * consumidas inteiras sem aparecer na tela.
 *
 * Células: {c, fg, bg, fl}. c é a string exibida ('' na metade direita de
 * um caractere largo); fg/bg: -1 = padrão, 0..255 = paleta, 0x1000000|rgb
 * = truecolor; fl = bits de VtScreen.ATTR.
 */
(function (root) {
  'use strict';

  const ATTR = Object.freeze({
    BOLD: 1, DIM: 2, ITALIC: 4, UNDERLINE: 8, BLINK: 16, INVERSE: 32, HIDDEN: 64, STRIKE: 128,
    WIDE: 256, WIDE_CONT: 512
  });
  const RGB = 0x1000000;

  /* DEC special graphics: 0x5F..0x7E -> desenho de linhas e símbolos. */
  const DEC_GRAPHICS = {
    0x5F: ' ', 0x60: '◆', 0x61: '▒', 0x62: '␉', 0x63: '␌', 0x64: '␍',
    0x65: '␊', 0x66: '°', 0x67: '±', 0x68: '␤', 0x69: '␋', 0x6A: '┘',
    0x6B: '┐', 0x6C: '┌', 0x6D: '└', 0x6E: '┼', 0x6F: '⎺', 0x70: '⎻',
    0x71: '─', 0x72: '⎼', 0x73: '⎽', 0x74: '├', 0x75: '┤', 0x76: '┴',
    0x77: '┬', 0x78: '│', 0x79: '≤', 0x7A: '≥', 0x7B: 'π', 0x7C: '≠',
    0x7D: '£', 0x7E: '·'
  };

  /* ---- UTF-8 ---------------------------------------------------------- */

  class Utf8Decoder {
    constructor() { this.need = 0; this.cp = 0; this.min = 0; }

    /* Devolve um array de code points; bytes inválidos viram U+FFFD. */
    decode(bytes) {
      const out = [];
      for (let i = 0; i < bytes.length; i++) {
        const b = bytes[i];
        if (this.need) {
          if ((b & 0xC0) === 0x80) {
            this.cp = (this.cp << 6) | (b & 0x3F);
            if (--this.need === 0) {
              const cp = this.cp;
              out.push(cp < this.min || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF) ? 0xFFFD : cp);
            }
            continue;
          }
          out.push(0xFFFD);       /* sequência interrompida: reprocessa b */
          this.need = 0;
        }
        if (b < 0x80) out.push(b);
        else if ((b & 0xE0) === 0xC0) { this.need = 1; this.cp = b & 0x1F; this.min = 0x80; }
        else if ((b & 0xF0) === 0xE0) { this.need = 2; this.cp = b & 0x0F; this.min = 0x800; }
        else if ((b & 0xF8) === 0xF0) { this.need = 3; this.cp = b & 0x07; this.min = 0x10000; }
        else out.push(0xFFFD);
      }
      return out;
    }
  }

  /* ---- largura de caractere (wcwidth simplificado) -------------------- */

  function isCombining(cp) {
    return (cp >= 0x0300 && cp <= 0x036F) || (cp >= 0x1AB0 && cp <= 0x1AFF) ||
      (cp >= 0x1DC0 && cp <= 0x1DFF) || (cp >= 0x20D0 && cp <= 0x20FF) ||
      (cp >= 0xFE20 && cp <= 0xFE2F) || cp === 0x200D || (cp >= 0xFE00 && cp <= 0xFE0F) ||
      (cp >= 0x200B && cp <= 0x200F);
  }

  function isWide(cp) {
    return (cp >= 0x1100 && cp <= 0x115F) || cp === 0x2329 || cp === 0x232A ||
      (cp >= 0x2E80 && cp <= 0x303E) || (cp >= 0x3041 && cp <= 0x33FF) ||
      (cp >= 0x3400 && cp <= 0x4DBF) || (cp >= 0x4E00 && cp <= 0x9FFF) ||
      (cp >= 0xA000 && cp <= 0xA4CF) || (cp >= 0xAC00 && cp <= 0xD7A3) ||
      (cp >= 0xF900 && cp <= 0xFAFF) || (cp >= 0xFE30 && cp <= 0xFE4F) ||
      (cp >= 0xFF00 && cp <= 0xFF60) || (cp >= 0xFFE0 && cp <= 0xFFE6) ||
      (cp >= 0x1F300 && cp <= 0x1F64F) || (cp >= 0x1F900 && cp <= 0x1F9FF) ||
      (cp >= 0x1F680 && cp <= 0x1F6FF) || (cp >= 0x20000 && cp <= 0x3FFFD);
  }

  /* ---- linhas e células ----------------------------------------------- */

  function blankCell(bg) { return { c: ' ', fg: -1, bg: bg === undefined ? -1 : bg, fl: 0 }; }

  function newLine(cols, bg) {
    const cells = new Array(cols);
    for (let i = 0; i < cols; i++) cells[i] = blankCell(bg);
    return { cells, dirty: true, wrapped: false, id: 0 };
  }

  /* ---- parser + tela -------------------------------------------------- */

  const S = { GROUND: 0, ESC: 1, ESC_INT: 2, CSI: 3, CSI_IGNORE: 4, OSC: 5, STR: 6, STR_ESC: 7, OSC_ESC: 8 };
  const OSC_MAX = 4096;

  class VtScreen {
    constructor(opts) {
      opts = opts || {};
      this.cols = Math.max(2, opts.cols || 80);
      this.rows = Math.max(2, opts.rows || 24);
      this.maxScrollback = opts.scrollback === undefined ? 5000 : opts.scrollback;
      this.onResponse = opts.onResponse || null;   /* respostas (DSR, DA) -> stdin */
      this.onBell = opts.onBell || null;
      this.onTitle = opts.onTitle || null;
      this.newlineMode = opts.newlineMode !== false;  /* LF = CR+LF (ONLCR de um tty) */
      this.decoder = new Utf8Decoder();
      this.nextLineId = 1;
      this.scrollback = [];
      this.scrolledOut = [];         /* linhas que entraram no histórico desde takeScrolledOut */
      this.scrollbackCleared = false;
      this.reset();
    }

    /* RIS: estado inicial (o histórico é mantido, como no xterm). */
    reset() {
      this.main = this._blankScreen();
      this.alt = null;
      this.lines = this.main;
      this.altActive = false;
      this.x = 0;
      this.y = 0;
      this.wrapPending = false;
      this.fg = -1; this.bg = -1; this.fl = 0;
      this.top = 0;
      this.bottom = this.rows - 1;
      this.autowrap = true;
      this.originMode = false;
      this.insertMode = false;
      this.cursorVisible = true;
      this.appCursor = false;
      this.appKeypad = false;
      this.bracketedPaste = false;
      this.g = ['B', 'B'];
      this.gl = 0;
      this.saved = null;
      this.savedMain = null;
      this.title = '';
      this.lastChar = null;
      this.tabs = this._defaultTabs(this.cols);
      this.state = S.GROUND;
      this.params = '';
      this.inter = '';
      this.oscBuf = '';
      this.bellCount = 0;
      this.allDirty = true;
    }

    _blankScreen() {
      const s = [];
      for (let i = 0; i < this.rows; i++) s.push(this._newLine());
      return s;
    }

    _newLine(bg) {
      const l = newLine(this.cols, bg);
      l.id = this.nextLineId++;
      return l;
    }

    _defaultTabs(cols) {
      const t = new Uint8Array(cols);
      for (let i = 8; i < cols; i += 8) t[i] = 1;
      return t;
    }

    /* ---- entrada ---- */

    /* Aceita Uint8Array/Array de bytes (UTF-8) ou string. */
    write(data) {
      let cps;
      if (typeof data === 'string') {
        cps = [];
        for (const ch of data) cps.push(ch.codePointAt(0));
      } else {
        cps = this.decoder.decode(data);
      }
      for (let i = 0; i < cps.length; i++) this._feed(cps[i]);
    }

    _feed(cp) {
      /* CAN/SUB abortam qualquer sequência; ESC recomeça (exceto em strings). */
      if (cp === 0x18 || cp === 0x1A) { this.state = S.GROUND; return; }
      switch (this.state) {
        case S.GROUND:
          if (cp < 0x20 || cp === 0x7F) this._control(cp);
          else if (cp >= 0x80 && cp < 0xA0) { /* C1 de 8 bits: ignorado em UTF-8 */ }
          else this._print(cp);
          return;
        case S.ESC:
          this._escChar(cp);
          return;
        case S.ESC_INT:
          if (cp === 0x1B) { this.state = S.ESC; return; }
          if (cp < 0x20) { this._control(cp); return; }
          if (cp >= 0x20 && cp <= 0x2F) { this.inter += String.fromCharCode(cp); return; }
          this._escDispatch(this.inter, cp);
          this.state = S.GROUND;
          return;
        case S.CSI:
          if (cp === 0x1B) { this.state = S.ESC; return; }
          if (cp < 0x20) { this._control(cp); return; }
          if ((cp >= 0x30 && cp <= 0x3F)) {
            if (this.inter) { this.state = S.CSI_IGNORE; return; }
            if (this.params.length < 256) this.params += String.fromCharCode(cp);
            return;
          }
          if (cp >= 0x20 && cp <= 0x2F) { this.inter += String.fromCharCode(cp); return; }
          if (cp >= 0x40 && cp <= 0x7E) {
            this.state = S.GROUND;
            this._csiDispatch(this.params, this.inter, String.fromCharCode(cp));
            return;
          }
          this.state = S.CSI_IGNORE;
          return;
        case S.CSI_IGNORE:
          if (cp === 0x1B) { this.state = S.ESC; return; }
          if (cp < 0x20) { this._control(cp); return; }
          if (cp >= 0x40 && cp <= 0x7E) this.state = S.GROUND;
          return;
        case S.OSC:
          if (cp === 0x07) { this._oscDispatch(this.oscBuf); this.state = S.GROUND; return; }
          if (cp === 0x1B) { this.state = S.OSC_ESC; return; }
          if (cp < 0x20) return;
          if (this.oscBuf.length < OSC_MAX) this.oscBuf += String.fromCodePoint(cp);
          return;
        case S.OSC_ESC:
          if (cp === 0x5C) { this._oscDispatch(this.oscBuf); this.state = S.GROUND; return; }
          this.state = S.ESC;          /* ESC qualquer: OSC abortado, nova sequência */
          this._escChar(cp);
          return;
        case S.STR:                    /* DCS, SOS, PM, APC: ignorados até ST */
          if (cp === 0x1B) this.state = S.STR_ESC;
          else if (cp === 0x07) this.state = S.GROUND;
          return;
        case S.STR_ESC:
          this.state = cp === 0x5C ? S.GROUND : S.STR;
          return;
        default:
          this.state = S.GROUND;
      }
    }

    _escChar(cp) {
      this.params = '';
      this.inter = '';
      if (cp === 0x1B) { this.state = S.ESC; return; }
      if (cp < 0x20) { this._control(cp); return; }
      if (cp === 0x5B) { this.state = S.CSI; return; }               /* [ */
      if (cp === 0x5D) { this.state = S.OSC; this.oscBuf = ''; return; } /* ] */
      if (cp === 0x50 || cp === 0x58 || cp === 0x5E || cp === 0x5F) { this.state = S.STR; return; }
      if (cp >= 0x20 && cp <= 0x2F) { this.inter = String.fromCharCode(cp); this.state = S.ESC_INT; return; }
      this.state = S.GROUND;
      this._escDispatch('', cp);
    }

    /* ---- C0 ---- */

    _control(cp) {
      switch (cp) {
        case 0x07: this.bellCount++; if (this.onBell) this.onBell(); break;
        case 0x08: this._backspace(); break;
        case 0x09: this._tab(1); break;
        case 0x0A: case 0x0B: case 0x0C:
          this._index();
          if (this.newlineMode) this._cr();
          break;
        case 0x0D: this._cr(); break;
        case 0x0E: this.gl = 1; break;   /* SO */
        case 0x0F: this.gl = 0; break;   /* SI */
        case 0x1B: this.state = S.ESC; this.params = ''; this.inter = ''; break;
        default: break;
      }
    }

    _cr() { this.x = 0; this.wrapPending = false; }

    _backspace() {
      if (this.wrapPending) { this.wrapPending = false; }
      if (this.x > 0) this.x--;
    }

    _tab(n) {
      this.wrapPending = false;
      while (n-- > 0) {
        let x = this.x + 1;
        while (x < this.cols - 1 && !this.tabs[x]) x++;
        this.x = Math.min(x, this.cols - 1);
      }
    }

    _backTab(n) {
      this.wrapPending = false;
      while (n-- > 0 && this.x > 0) {
        let x = this.x - 1;
        while (x > 0 && !this.tabs[x]) x--;
        this.x = x;
      }
    }

    /* ---- impressão ---- */

    _print(cp) {
      if (this.g[this.gl] === '0' && DEC_GRAPHICS[cp]) {
        this._put(DEC_GRAPHICS[cp], 1);
        this.lastChar = cp;
        return;
      }
      if (isCombining(cp)) {
        this._combine(String.fromCodePoint(cp));
        return;
      }
      this._put(String.fromCodePoint(cp), isWide(cp) ? 2 : 1);
      this.lastChar = cp;
    }

    /* Acento/ZWJ/seletor de variação: junta ao caractere anterior. */
    _combine(s) {
      let x = this.wrapPending ? this.x : this.x - 1;
      let line = this.lines[this.y];
      if (x < 0) return;
      if (line.cells[x].fl & ATTR.WIDE_CONT && x > 0) x--;
      line.cells[x].c += s;
      line.dirty = true;
    }

    _put(ch, width) {
      if (this.wrapPending && this.autowrap) {
        this.lines[this.y].wrapped = true;
        this._index();
        this.x = 0;
        this.wrapPending = false;
      }
      if (width === 2 && this.x === this.cols - 1) {
        if (this.autowrap) {
          this._eraseCells(this.y, this.x, 1);
          this.lines[this.y].wrapped = true;
          this._index();
          this.x = 0;
        } else {
          width = 1;
        }
      }
      const line = this.lines[this.y];
      if (this.insertMode) this._insertCells(width);
      this._clearWideAt(line, this.x);
      if (width === 2) this._clearWideAt(line, this.x + 1);
      const cell = line.cells[this.x];
      cell.c = ch; cell.fg = this.fg; cell.bg = this.bg;
      cell.fl = this.fl | (width === 2 ? ATTR.WIDE : 0);
      if (width === 2) {
        const c2 = line.cells[this.x + 1];
        c2.c = ''; c2.fg = this.fg; c2.bg = this.bg; c2.fl = this.fl | ATTR.WIDE_CONT;
      }
      line.dirty = true;
      this.x += width;
      if (this.x >= this.cols) {
        this.x = this.cols - 1;
        this.wrapPending = this.autowrap;
      }
    }

    /* Sobrescrever metade de um caractere largo apaga a outra metade. */
    _clearWideAt(line, x) {
      if (x < 0 || x >= this.cols) return;
      const c = line.cells[x];
      if (c.fl & ATTR.WIDE && x + 1 < this.cols) {
        const n = line.cells[x + 1];
        n.c = ' '; n.fl &= ~ATTR.WIDE_CONT;
      } else if (c.fl & ATTR.WIDE_CONT && x > 0) {
        const p = line.cells[x - 1];
        p.c = ' '; p.fl &= ~ATTR.WIDE;
      }
      c.fl &= ~(ATTR.WIDE | ATTR.WIDE_CONT);
    }

    /* ---- rolagem ---- */

    /* IND: desce uma linha, rolando a região se estiver no fundo dela. */
    _index() {
      if (this.y === this.bottom) this._scrollUp(1);
      else if (this.y < this.rows - 1) this.y++;
    }

    /* RI: sobe uma linha, rolando para baixo se estiver no topo da região. */
    _reverseIndex() {
      this.wrapPending = false;
      if (this.y === this.top) this._scrollDown(1);
      else if (this.y > 0) this.y--;
    }

    _scrollUp(n) {
      n = Math.min(n, this.bottom - this.top + 1);
      for (let i = 0; i < n; i++) {
        const gone = this.lines.splice(this.top, 1)[0];
        this.lines.splice(this.bottom, 0, this._newLine(this.bg));
        if (this.top === 0 && !this.altActive && this.maxScrollback > 0) {
          this.scrollback.push(gone);
          this.scrolledOut.push(gone);
          if (this.scrollback.length > this.maxScrollback) this.scrollback.shift();
        }
      }
      this._dirtyRange(this.top, this.bottom);
    }

    _scrollDown(n) {
      n = Math.min(n, this.bottom - this.top + 1);
      for (let i = 0; i < n; i++) {
        this.lines.splice(this.bottom, 1);
        this.lines.splice(this.top, 0, this._newLine(this.bg));
      }
      this._dirtyRange(this.top, this.bottom);
    }

    _dirtyRange(a, b) {
      for (let i = a; i <= b; i++) this.lines[i].dirty = true;
    }

    /* ---- apagar / inserir ---- */

    _eraseCells(y, x0, n) {
      const line = this.lines[y];
      const end = Math.min(this.cols, x0 + n);
      if (x0 > 0) this._clearWideAt(line, x0);
      if (end < this.cols) this._clearWideAt(line, end);
      for (let x = Math.max(0, x0); x < end; x++) {
        const c = line.cells[x];
        c.c = ' '; c.fg = -1; c.bg = this.bg; c.fl = 0;
      }
      line.dirty = true;
    }

    _eraseLine(y) {
      this._eraseCells(y, 0, this.cols);
      this.lines[y].wrapped = false;
    }

    _insertCells(n) {
      const line = this.lines[this.y];
      n = Math.min(n, this.cols - this.x);
      for (let i = 0; i < n; i++) {
        line.cells.splice(this.cols - 1, 1);
        line.cells.splice(this.x, 0, blankCell(this.bg));
      }
      line.dirty = true;
    }

    _deleteCells(n) {
      const line = this.lines[this.y];
      n = Math.min(n, this.cols - this.x);
      for (let i = 0; i < n; i++) {
        line.cells.splice(this.x, 1);
        line.cells.push(blankCell(this.bg));
      }
      line.dirty = true;
    }

    _insertLines(n) {
      if (this.y < this.top || this.y > this.bottom) return;
      this.wrapPending = false;
      n = Math.min(n, this.bottom - this.y + 1);
      for (let i = 0; i < n; i++) {
        this.lines.splice(this.bottom, 1);
        this.lines.splice(this.y, 0, this._newLine(this.bg));
      }
      this._dirtyRange(this.y, this.bottom);
      this.x = 0;
    }

    _deleteLines(n) {
      if (this.y < this.top || this.y > this.bottom) return;
      this.wrapPending = false;
      n = Math.min(n, this.bottom - this.y + 1);
      for (let i = 0; i < n; i++) {
        this.lines.splice(this.y, 1);
        this.lines.splice(this.bottom, 0, this._newLine(this.bg));
      }
      this._dirtyRange(this.y, this.bottom);
      this.x = 0;
    }

    /* ---- cursor ---- */

    _moveTo(x, y) {
      this.wrapPending = false;
      const minY = this.originMode ? this.top : 0;
      const maxY = this.originMode ? this.bottom : this.rows - 1;
      this.x = Math.max(0, Math.min(this.cols - 1, x));
      this.y = Math.max(minY, Math.min(maxY, y));
    }

    /* CUU/CUD/CNL/CPL param na margem da região quando andam em direção a
     * ela (xterm CursorUp/CursorDown): para cima, na margem de cima se o
     * cursor não está acima da região; para baixo, na de baixo se ele não
     * está abaixo dela. */
    _moveVert(d) {
      this.wrapPending = false;
      const lo = (d < 0 && this.y >= this.top) ? this.top : 0;
      const hi = (d > 0 && this.y <= this.bottom) ? this.bottom : this.rows - 1;
      this.y = Math.max(lo, Math.min(hi, this.y + d));
    }

    _saveCursor() {
      return {
        x: this.x, y: this.y, fg: this.fg, bg: this.bg, fl: this.fl, g: this.g.slice(), gl: this.gl,
        originMode: this.originMode, wrapPending: this.wrapPending, autowrap: this.autowrap
      };
    }

    _restoreCursor(s) {
      if (!s) { this._moveTo(0, 0); this.fg = -1; this.bg = -1; this.fl = 0; return; }
      this.x = Math.min(s.x, this.cols - 1); this.y = Math.min(s.y, this.rows - 1);
      this.fg = s.fg; this.bg = s.bg; this.fl = s.fl; this.g = s.g.slice(); this.gl = s.gl;
      this.originMode = s.originMode; this.wrapPending = s.wrapPending; this.autowrap = s.autowrap;
    }

    /* ---- tela alternativa ---- */

    _enterAlt(clear) {
      if (this.altActive) { if (clear) this._eraseAll(); return; }
      if (!this.alt || clear) this.alt = this._blankScreen();
      this.lines = this.alt;
      this.altActive = true;
      this.allDirty = true;
    }

    _leaveAlt() {
      if (!this.altActive) return;
      this.lines = this.main;
      this.altActive = false;
      this.allDirty = true;
      this._dirtyRange(0, this.rows - 1);
    }

    _eraseAll() {
      for (let y = 0; y < this.rows; y++) this._eraseLine(y);
    }

    /* ---- ESC ---- */

    _escDispatch(inter, cp) {
      const f = String.fromCharCode(cp);
      if (inter === '(' || inter === ')' || inter === '*' || inter === '+') {
        const set = f === '0' ? '0' : 'B';
        if (inter === '(') this.g[0] = set;
        else if (inter === ')') this.g[1] = set;
        return;
      }
      if (inter === '#') {
        if (f === '8') {                               /* DECALN */
          for (let y = 0; y < this.rows; y++) {
            for (const c of this.lines[y].cells) { c.c = 'E'; c.fg = -1; c.bg = -1; c.fl = 0; }
            this.lines[y].dirty = true;
          }
          this.top = 0; this.bottom = this.rows - 1; this._moveTo(0, 0);
        }
        return;
      }
      if (inter) return;
      switch (f) {
        case '7': this.saved = this._saveCursor(); break;
        case '8': this._restoreCursor(this.saved); break;
        case 'c': this.reset(); this._dirtyRange(0, this.rows - 1); break;
        case 'D': this._index(); break;
        case 'M': this._reverseIndex(); break;
        case 'E': this._index(); this._cr(); break;
        case 'H': this.tabs[this.x] = 1; break;
        case '=': this.appKeypad = true; break;
        case '>': this.appKeypad = false; break;
        default: break;                                /* ESC \ (ST solto), ESC N/O, ... */
      }
    }

    /* ---- OSC ---- */

    _oscDispatch(s) {
      const semi = s.indexOf(';');
      const ps = semi < 0 ? s : s.slice(0, semi);
      const pt = semi < 0 ? '' : s.slice(semi + 1);
      if (ps === '0' || ps === '2') {
        this.title = pt;
        if (this.onTitle) this.onTitle(pt);
      }
    }

    /* ---- CSI ---- */

    _csiDispatch(paramStr, inter, f) {
      let priv = '';
      if (paramStr && /^[<=>?]/.test(paramStr)) { priv = paramStr[0]; paramStr = paramStr.slice(1); }
      const raw = paramStr === '' ? [] : paramStr.split(';');
      const p = raw.map((s) => {
        const n = parseInt(s.split(':')[0], 10);
        return isNaN(n) ? 0 : Math.min(n, 65535);
      });
      const p0 = (i, d) => (p[i] === undefined || p[i] === 0 ? d : p[i]);
      if (inter) {
        /* "CSI Ps SP q" (DECSCUSR), "CSI ! p" (DECSTR)... */
        if (inter === '!' && f === 'p') this._softReset();
        return;
      }
      if (priv === '?') { this._csiPrivate(p, f); return; }
      if (priv) return;
      switch (f) {
        case 'A': this._moveVert(-p0(0, 1)); break;
        case 'B': case 'e': this._moveVert(p0(0, 1)); break;
        case 'C': case 'a': this.wrapPending = false; this.x = Math.min(this.cols - 1, this.x + p0(0, 1)); break;
        case 'D': this.wrapPending = false; this.x = Math.max(0, this.x - p0(0, 1)); break;
        case 'E': this._moveVert(p0(0, 1)); this.x = 0; break;
        case 'F': this._moveVert(-p0(0, 1)); this.x = 0; break;
        case 'G': case '`': this.wrapPending = false; this.x = Math.min(this.cols - 1, p0(0, 1) - 1); break;
        case 'H': case 'f': {
          const off = this.originMode ? this.top : 0;
          this._moveTo(p0(1, 1) - 1, p0(0, 1) - 1 + off);
          break;
        }
        case 'd': {
          const off = this.originMode ? this.top : 0;
          this._moveTo(this.x, p0(0, 1) - 1 + off);
          break;
        }
        case 'J': this._eraseDisplay(p[0] || 0); break;
        case 'K': this._eraseInLine(p[0] || 0); break;
        case 'L': this._insertLines(p0(0, 1)); break;
        case 'M': this._deleteLines(p0(0, 1)); break;
        case 'P': this.wrapPending = false; this._deleteCells(p0(0, 1)); break;
        case '@': this.wrapPending = false; this._insertCells(p0(0, 1)); break;
        case 'X': this.wrapPending = false; this._eraseCells(this.y, this.x, p0(0, 1)); break;
        case 'S': this._scrollUp(p0(0, 1)); break;
        case 'T': if (p.length <= 1) this._scrollDown(p0(0, 1)); break;
        case 'I': this._tab(p0(0, 1)); break;
        case 'Z': this._backTab(p0(0, 1)); break;
        case 'b': {
          if (this.lastChar !== null) {
            const n = Math.min(p0(0, 1), this.cols * this.rows);
            for (let i = 0; i < n; i++) this._print(this.lastChar);
          }
          break;
        }
        case 'g':
          if ((p[0] || 0) === 0) this.tabs[this.x] = 0;
          else if (p[0] === 3) this.tabs.fill(0);
          break;
        case 'm': this._sgr(raw); break;
        case 'n':
          if (p[0] === 5) this._respond('\x1b[0n');
          else if (p[0] === 6) {
            const row = this.y - (this.originMode ? this.top : 0) + 1;
            this._respond('\x1b[' + row + ';' + (this.x + 1) + 'R');
          }
          break;
        case 'c': if ((p[0] || 0) === 0) this._respond('\x1b[?1;2c'); break;
        case 'r': {
          const t = p0(0, 1) - 1, b = p0(1, this.rows) - 1;
          if (t < b && b < this.rows) {
            this.top = t; this.bottom = b;
            this._moveTo(0, this.originMode ? this.top : 0);
          }
          break;
        }
        case 's': this.saved = this._saveCursor(); break;
        case 'u': this._restoreCursor(this.saved); break;
        case 'h': case 'l': {
          const on = f === 'h';
          for (const m of p) {
            if (m === 4) this.insertMode = on;
            else if (m === 20) this.newlineMode = on;
          }
          break;
        }
        default: break;
      }
    }

    _csiPrivate(p, f) {
      if (f !== 'h' && f !== 'l') return;      /* DECRQM etc.: ignorados */
      const on = f === 'h';
      for (const m of p) {
        switch (m) {
          case 1: this.appCursor = on; break;
          case 6: this.originMode = on; this._moveTo(0, on ? this.top : 0); break;
          case 7: this.autowrap = on; if (!on) this.wrapPending = false; break;
          case 25: this.cursorVisible = on; break;
          case 47: case 1047:
            if (on) this._enterAlt(m === 1047); else { if (m === 1047 && this.altActive) this._eraseAll(); this._leaveAlt(); }
            break;
          case 1048: if (on) this.savedMain = this._saveCursor(); else this._restoreCursor(this.savedMain); break;
          case 1049:
            if (on) { this.savedMain = this._saveCursor(); this._enterAlt(true); this._moveTo(0, 0); }
            else { this._leaveAlt(); this._restoreCursor(this.savedMain); }
            break;
          case 2004: this.bracketedPaste = on; break;
          default: break;                          /* 12 (blink), 1000-1006 (mouse), ... */
        }
      }
    }

    _softReset() {
      this.cursorVisible = true; this.originMode = false; this.autowrap = true; this.insertMode = false;
      this.top = 0; this.bottom = this.rows - 1; this.fg = -1; this.bg = -1; this.fl = 0;
      this.g = ['B', 'B']; this.gl = 0; this.saved = null;
    }

    _respond(s) { if (this.onResponse) this.onResponse(s); }

    _eraseDisplay(mode) {
      this.wrapPending = false;
      if (mode === 0) {
        this._eraseCells(this.y, this.x, this.cols - this.x);
        for (let y = this.y + 1; y < this.rows; y++) this._eraseLine(y);
      } else if (mode === 1) {
        for (let y = 0; y < this.y; y++) this._eraseLine(y);
        this._eraseCells(this.y, 0, this.x + 1);
      } else if (mode === 2) {
        this._eraseAll();
      } else if (mode === 3) {
        this.scrollback = [];
        this.scrollbackCleared = true;
      }
    }

    _eraseInLine(mode) {
      this.wrapPending = false;
      if (mode === 0) this._eraseCells(this.y, this.x, this.cols - this.x);
      else if (mode === 1) this._eraseCells(this.y, 0, this.x + 1);
      else if (mode === 2) this._eraseCells(this.y, 0, this.cols);
    }

    /* SGR: aceita 38;5;n / 38;2;r;g;b e as formas com ':' (38:5:n, 38:2::r:g:b). */
    _sgr(raw) {
      if (raw.length === 0) raw = ['0'];
      for (let i = 0; i < raw.length; i++) {
        const sub = raw[i].split(':').map((s) => (s === '' ? -1 : parseInt(s, 10)));
        const n = isNaN(sub[0]) || sub[0] < 0 ? 0 : sub[0];
        if (n === 38 || n === 48 || n === 58) {
          let color = null;
          if (sub.length > 1) {                       /* forma com ':' */
            if (sub[1] === 5) color = sub[2] >= 0 ? sub[2] & 255 : null;
            else if (sub[1] === 2) {
              const v = sub.length >= 6 ? sub.slice(3, 6) : sub.slice(2, 5);
              color = RGB | ((v[0] & 255) << 16) | ((v[1] & 255) << 8) | (v[2] & 255);
            }
          } else {
            const mode = parseInt(raw[i + 1], 10);
            if (mode === 5) { color = parseInt(raw[i + 2], 10) & 255; i += 2; }
            else if (mode === 2) {
              const r = parseInt(raw[i + 2], 10) & 255, g = parseInt(raw[i + 3], 10) & 255, b = parseInt(raw[i + 4], 10) & 255;
              color = RGB | (r << 16) | (g << 8) | b;
              i += 4;
            } else { i += 1; }
          }
          if (color !== null && !isNaN(color)) {
            if (n === 38) this.fg = color; else if (n === 48) this.bg = color;
          }
          continue;
        }
        if (n === 0) { this.fg = -1; this.bg = -1; this.fl = 0; }
        else if (n === 1) this.fl |= ATTR.BOLD;
        else if (n === 2) this.fl |= ATTR.DIM;
        else if (n === 3) this.fl |= ATTR.ITALIC;
        else if (n === 4) { if (sub[1] === 0) this.fl &= ~ATTR.UNDERLINE; else this.fl |= ATTR.UNDERLINE; }
        else if (n === 5 || n === 6) this.fl |= ATTR.BLINK;
        else if (n === 7) this.fl |= ATTR.INVERSE;
        else if (n === 8) this.fl |= ATTR.HIDDEN;
        else if (n === 9) this.fl |= ATTR.STRIKE;
        else if (n === 21) this.fl |= ATTR.UNDERLINE;
        else if (n === 22) this.fl &= ~(ATTR.BOLD | ATTR.DIM);
        else if (n === 23) this.fl &= ~ATTR.ITALIC;
        else if (n === 24) this.fl &= ~ATTR.UNDERLINE;
        else if (n === 25) this.fl &= ~ATTR.BLINK;
        else if (n === 27) this.fl &= ~ATTR.INVERSE;
        else if (n === 28) this.fl &= ~ATTR.HIDDEN;
        else if (n === 29) this.fl &= ~ATTR.STRIKE;
        else if (n >= 30 && n <= 37) this.fg = n - 30;
        else if (n === 39) this.fg = -1;
        else if (n >= 40 && n <= 47) this.bg = n - 40;
        else if (n === 49) this.bg = -1;
        else if (n >= 90 && n <= 97) this.fg = n - 90 + 8;
        else if (n >= 100 && n <= 107) this.bg = n - 100 + 8;
      }
    }

    /* ---- redimensionar ---- */

    resize(cols, rows) {
      cols = Math.max(2, cols | 0); rows = Math.max(2, rows | 0);
      if (cols === this.cols && rows === this.rows) return;
      const fix = (screen) => {
        for (const l of screen) {
          if (cols < this.cols) l.cells.length = cols;
          else for (let i = this.cols; i < cols; i++) l.cells.push(blankCell());
          l.dirty = true;
        }
      };
      const oldCols = this.cols;
      for (const scr of [this.main, this.alt]) if (scr) fix(scr);
      this.cols = cols;
      /* linhas: tira do topo (para o histórico) ou acrescenta embaixo */
      const fixRows = (screen, isMain) => {
        while (screen.length > rows) {
          if (screen === this.lines && this.y >= rows) {   /* cursor sairia: rola */
            const g = screen.shift();
            if (isMain) { this.scrollback.push(g); this.scrolledOut.push(g); }
            this.y--;
          } else {
            screen.pop();
          }
        }
        while (screen.length < rows) screen.push(this._newLine());
      };
      fixRows(this.main, true);
      if (this.alt) fixRows(this.alt, false);
      this.rows = rows;
      this.top = 0; this.bottom = rows - 1;
      this.x = Math.min(this.x, cols - 1);
      this.y = Math.min(this.y, rows - 1);
      this.wrapPending = false;
      const t = this._defaultTabs(cols);
      t.set(this.tabs.subarray(0, Math.min(oldCols, cols)));
      this.tabs = t;
      this.allDirty = true;
    }

    /* ---- inspeção (renderizador e testes) ---- */

    cell(x, y) { return this.lines[y].cells[x]; }

    lineText(y, trim) {
      const s = VtScreen.lineToText(this.lines[y]);
      return trim === false ? s : s.replace(/\s+$/, '');
    }

    screenText() {
      const out = [];
      for (let y = 0; y < this.rows; y++) out.push(this.lineText(y));
      return out.join('\n').replace(/\n+$/, '');
    }

    /* Linhas que entraram no histórico desde a última chamada. */
    takeScrolledOut() {
      const r = this.scrolledOut;
      this.scrolledOut = [];
      return r;
    }

    static lineToText(line) {
      let s = '';
      for (const c of line.cells) if (!(c.fl & ATTR.WIDE_CONT)) s += c.c === ' ' ? ' ' : c.c;
      return s;
    }
  }

  VtScreen.ATTR = ATTR;
  VtScreen.RGB = RGB;
  VtScreen.DEC_GRAPHICS = DEC_GRAPHICS;

  /* Paleta xterm de 256 cores (16 da tela vêm do CSS/tema). */
  function palette256(n) {
    if (n < 16) return null;
    if (n < 232) {
      const i = n - 16, v = [0, 95, 135, 175, 215, 255];
      return [v[Math.floor(i / 36)], v[Math.floor(i / 6) % 6], v[i % 6]];
    }
    const g = 8 + (n - 232) * 10;
    return [g, g, g];
  }

  const api = { VtScreen, Utf8Decoder, ATTR, palette256, isWide, isCombining };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else Object.assign(root, api);
})(typeof self !== 'undefined' ? self : this);
