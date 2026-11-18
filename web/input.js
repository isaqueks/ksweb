/*
 * input.js — teclado -> bytes para o stdin do guest, sem DOM.
 *
 *   keyToBytes(ev, opts)  tecla (objeto no formato de KeyboardEvent) ->
 *                         string a enviar no modo raw, ou null se a tecla
 *                         não gera nada (Shift sozinho, etc.). Sequências
 *                         do xterm: setas CSI A..D (SS3 com DECCKM), Home/End,
 *                         PgUp/PgDn, Insert/Delete, F1..F12, modificadores
 *                         ";2".. ";8", Ctrl+letra = código de controle,
 *                         Alt+tecla = ESC + tecla.
 *   pageShortcut(ev)      atalho da página (F8, F10, Ctrl+F9) ou null: o
 *                         terminal não manda essas teclas ao guest.
 *   LineEditor            modo linha ("cooked") com eco local: edita a linha
 *                         no terminal e só a envia no Enter (com "\n").
 *                         Ctrl+D numa linha vazia = EOF; com texto, envia o
 *                         que houver sem "\n" (como um tty Unix).
 */
(function (root) {
  'use strict';

  const ESC = '\x1b';

  function modParam(ev) {
    const m = 1 + (ev.shiftKey ? 1 : 0) + (ev.altKey ? 2 : 0) + (ev.ctrlKey ? 4 : 0);
    return m > 1 ? m : 0;
  }

  /* Ctrl + caractere -> C0 (ou null). */
  function ctrlChar(k) {
    if (k.length !== 1) return null;
    const c = k.toUpperCase().charCodeAt(0);
    if (c >= 0x40 && c <= 0x5F) return String.fromCharCode(c & 0x1F);   /* @ A-Z [ \ ] ^ _ */
    if (k === ' ' || k === '2') return '\x00';
    if (k === '/' || k === '-') return '\x1f';
    if (k === '?') return '\x7f';
    if (k >= '3' && k <= '7') return String.fromCharCode(0x1b + (k.charCodeAt(0) - 0x33)); /* 3..7 -> ESC..US */
    if (k === '8') return '\x7f';
    return null;
  }

  const CURSOR = { ArrowUp: 'A', ArrowDown: 'B', ArrowRight: 'C', ArrowLeft: 'D', Home: 'H', End: 'F' };
  const TILDE = { Insert: 2, Delete: 3, PageUp: 5, PageDown: 6, F5: 15, F6: 17, F7: 18, F8: 19, F9: 20, F10: 21, F11: 23, F12: 24 };
  const SS3F = { F1: 'P', F2: 'Q', F3: 'R', F4: 'S' };

  /* Atalhos tratados por ksweb.js no document; em qualquer modo do
   * teclado ficam com a página. */
  function pageShortcut(ev) {
    if (ev.key === 'F8') return 'run';
    if (ev.key === 'F10') return 'step';
    if (ev.key === 'F9' && ev.ctrlKey && !ev.shiftKey) return 'debugger';
    return null;
  }

  /* opts: {appCursor, backspace: '\x7f' | '\b', enter: '\r'} */
  function keyToBytes(ev, opts) {
    opts = opts || {};
    const k = ev.key;
    const m = modParam(ev);
    if (CURSOR[k]) {
      if (m) return ESC + '[1;' + m + CURSOR[k];
      return (opts.appCursor ? ESC + 'O' : ESC + '[') + CURSOR[k];
    }
    if (TILDE[k] !== undefined) return ESC + '[' + TILDE[k] + (m ? ';' + m : '') + '~';
    if (SS3F[k]) return m ? ESC + '[1;' + m + SS3F[k] : ESC + 'O' + SS3F[k];
    switch (k) {
      case 'Enter': return ev.altKey ? ESC + (opts.enter || '\r') : (opts.enter || '\r');
      case 'Backspace': {
        const b = ev.ctrlKey ? (opts.backspace === '\b' ? '\x7f' : '\b') : (opts.backspace || '\x7f');
        return ev.altKey ? ESC + b : b;
      }
      case 'Tab': return ev.shiftKey ? ESC + '[Z' : '\t';
      case 'Escape': return ESC;
      default: break;
    }
    if (k.length === 0 || [...k].length !== 1) return null;   /* Shift, Control, Dead, ... */
    if (ev.ctrlKey && !ev.altKey) return ctrlChar(k);
    if (ev.ctrlKey && ev.altKey) {                             /* AltGr no Windows chega assim */
      return ev.altGraph ? k : (ctrlChar(k) ? ESC + ctrlChar(k) : k);
    }
    if (ev.metaKey) return null;
    return ev.altKey ? ESC + k : k;
  }

  class LineEditor {
    /* echo(str): texto para o terminal; send(str): para o guest; eof(). */
    constructor(cb) {
      this.echo = cb.echo;
      this.send = cb.send;
      this.eof = cb.eof;
      this.buf = [];     /* code points como strings */
      this.pos = 0;
    }

    clear() { this.buf = []; this.pos = 0; }
    text() { return this.buf.join(''); }

    _rest() { return this.buf.slice(this.pos).join(''); }

    insert(str) {
      const chars = [...str];
      this.buf.splice(this.pos, 0, ...chars);
      this.pos += chars.length;
      const rest = this._rest();
      this.echo(chars.join('') + rest + (rest.length ? ESC + '[' + [...rest].length + 'D' : ''));
    }

    backspace() {
      if (this.pos === 0) return;
      this.pos--;
      this.buf.splice(this.pos, 1);
      const rest = this._rest(), n = [...rest].length;
      this.echo('\b' + rest + ' ' + ESC + '[' + (n + 1) + 'D');
    }

    del() {
      if (this.pos >= this.buf.length) return;
      this.buf.splice(this.pos, 1);
      const rest = this._rest(), n = [...rest].length;
      this.echo(rest + ' ' + ESC + '[' + (n + 1) + 'D');
    }

    left() { if (this.pos > 0) { this.pos--; this.echo(ESC + '[D'); } }
    right() { if (this.pos < this.buf.length) { this.pos++; this.echo(ESC + '[C'); } }
    home() { if (this.pos > 0) { this.echo(ESC + '[' + this.pos + 'D'); this.pos = 0; } }
    end() {
      const n = this.buf.length - this.pos;
      if (n > 0) { this.echo(ESC + '[' + n + 'C'); this.pos = this.buf.length; }
    }

    killLine() {
      this.home();
      const n = this.buf.length;
      this.buf = [];
      if (n) this.echo(' '.repeat(n) + ESC + '[' + n + 'D');
    }

    killWord() {
      let p = this.pos;
      while (p > 0 && this.buf[p - 1] === ' ') p--;
      while (p > 0 && this.buf[p - 1] !== ' ') p--;
      while (this.pos > p) this.backspace();
    }

    enter() {
      const line = this.text();
      this.end();
      this.echo('\r\n');
      this.clear();
      this.send(line + '\n');
    }

    /* Ctrl+D: EOF com a linha vazia; senão entrega o que há, sem '\n'. */
    ctrlD() {
      if (this.buf.length === 0) { this.eof(); return; }
      const line = this.text();
      this.clear();
      this.send(line);
    }

    ctrlC() {
      this.end();
      this.echo('^C\r\n');
      this.clear();
      this.send('\x03');
    }

    /* Colar: cada linha completa é enviada; o resto fica para editar. */
    paste(text) {
      const parts = text.replace(/\r\n?/g, '\n').split('\n');
      for (let i = 0; i < parts.length; i++) {
        if (parts[i]) this.insert(parts[i]);
        if (i < parts.length - 1) this.enter();
      }
    }

    /* Tecla (formato KeyboardEvent); true se consumida. */
    key(ev) {
      const k = ev.key;
      if (ev.ctrlKey && !ev.altKey) {
        const lk = k.toLowerCase();
        if (lk === 'd') { this.ctrlD(); return true; }
        if (lk === 'c') { this.ctrlC(); return true; }
        if (lk === 'u') { this.killLine(); return true; }
        if (lk === 'w') { this.killWord(); return true; }
        if (lk === 'a') { this.home(); return true; }
        if (lk === 'e') { this.end(); return true; }
        if (lk === 'h') { this.backspace(); return true; }
        if (lk === 'j' || lk === 'm') { this.enter(); return true; }
        return false;
      }
      switch (k) {
        case 'Enter': this.enter(); return true;
        case 'Backspace': this.backspace(); return true;
        case 'Delete': this.del(); return true;
        case 'ArrowLeft': this.left(); return true;
        case 'ArrowRight': this.right(); return true;
        case 'Home': this.home(); return true;
        case 'End': this.end(); return true;
        case 'Tab': this.insert('\t'); return true;
        default: break;
      }
      if (ev.metaKey || ev.altKey) return false;
      if ([...k].length === 1) { this.insert(k); return true; }
      return false;
    }
  }

  const api = { keyToBytes, pageShortcut, LineEditor };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else Object.assign(root, api);
})(typeof self !== 'undefined' ? self : this);
