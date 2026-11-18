#!/usr/bin/env node
/*
 * test_terminal.js — web/terminal.js (TerminalView) num DOM falso mínimo:
 * teclado no modo raw e no modo linha (o que vai ao stdin e o que fica com
 * a página), mensagens do runner (writeSystem) e o HTML gerado para a
 * saída do guest (escape, sem injeção).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let total = 0, failed = 0;
function test(name, fn) {
  total++;
  try { fn(); } catch (e) { failed++; console.log('FALHA [' + name + '] ' + e.message); }
}
function eq(a, b, what) {
  const sa = JSON.stringify(a), sb = JSON.stringify(b);
  if (sa !== sb) throw new Error((what || 'valor') + ': ' + sa + ' != esperado ' + sb);
}
function ok(c, what) { if (!c) throw new Error(what || 'condição falsa'); }

/* ---- DOM falso: só o que terminal.js usa ---- */
class FakeEl {
  constructor(tag) {
    this.tagName = tag; this.children = []; this.parent = null; this.listeners = {};
    this.style = {}; this.dataset = {}; this.className = ''; this._html = ''; this.hidden = false;
    this.scrollTop = 0; this.scrollHeight = 0; this.clientHeight = 0; this.clientWidth = 0; this.offsetWidth = 0;
    const cls = new Set();
    this.classList = {
      add: (c) => cls.add(c), remove: (c) => cls.delete(c), contains: (c) => cls.has(c),
      toggle: (c, on) => { if (on === undefined ? !cls.has(c) : on) cls.add(c); else cls.delete(c); }
    };
  }
  appendChild(c) { if (c.isFragment) { for (const x of c.children.slice()) this.appendChild(x); return c; } c.parent = this; this.children.push(c); return c; }
  remove() { if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = null; }
  get firstChild() { return this.children[0] || null; }
  get childElementCount() { return this.children.length; }
  set innerHTML(v) { this._html = v; this.children = []; }
  get innerHTML() { return this._html; }
  set textContent(v) { this._html = String(v); this.children = []; }
  addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); }
  dispatch(t, ev) { for (const f of this.listeners[t] || []) f(ev); }
  focus() {}
  contains() { return false; }
  getBoundingClientRect() { return { width: 80, height: 16 }; }
}
const documentListeners = {};
const document = {
  activeElement: null,
  createElement: (t) => new FakeEl(t),
  createDocumentFragment: () => Object.assign(new FakeEl('#fragment'), { isFragment: true }),
  addEventListener: (t, f) => { (documentListeners[t] = documentListeners[t] || []).push(f); }
};
const ctx = {
  document, console, setTimeout: () => 0,     /* render() é chamado à mão */
  window: { getSelection: () => ({ isCollapsed: true, anchorNode: null }) },
  getComputedStyle: () => ({ paddingLeft: '0', paddingRight: '0', paddingTop: '0', paddingBottom: '0' })
};
ctx.self = ctx;
vm.createContext(ctx);
for (const f of ['vt.js', 'input.js', 'terminal.js']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'web', f), 'utf8'), ctx, { filename: f });
}
const { TerminalView } = ctx;

function view(opts) {
  const sent = [], eofs = [], interrupts = [];
  const el = new FakeEl('div');
  const t = new TerminalView(el, Object.assign({
    cols: 30, rows: 5, fit: false,
    onData: (s) => sent.push(s), onEof: () => eofs.push(1), onInterrupt: () => interrupts.push(1)
  }, opts || {}));
  return { t, el, sent, eofs, interrupts };
}
function key(el, k, mods) {
  const ev = Object.assign({
    key: k, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, isComposing: false, keyCode: 0,
    defaultPrevented: false, getModifierState: () => false
  }, mods || {});
  ev.preventDefault = () => { ev.defaultPrevented = true; };
  el.dispatch('keydown', ev);
  return ev;
}

test('raw-atalhos-da-pagina-nao-vao-ao-guest', () => {
  /* F8 (executar/parar), F10 (passo) e Ctrl+F9 (depurador) são tratados
   * por ksweb.js no document; antes iam também ao stdin no modo raw. */
  const v = view();
  v.t.setLineMode(false);
  for (const [k, m] of [['F8'], ['F10'], ['F9', { ctrlKey: true }], ['F8', { shiftKey: true }]]) {
    const ev = key(v.el, k, m);
    eq(ev.defaultPrevented, false, k + ': fica para a página');
  }
  eq(v.sent, [], 'nada enviado');
  key(v.el, 'F9');
  key(v.el, 'F5');
  key(v.el, 'a');
  eq(v.sent, ['\x1b[20~', '\x1b[15~', 'a'], 'as outras teclas F e letras vão ao guest');
});

test('raw-interromper-e-ctrl-c', () => {
  const v = view();
  v.t.setLineMode(false);
  key(v.el, 'c', { ctrlKey: true, altKey: true });
  key(v.el, 'Pause');
  eq(v.interrupts.length, 2, 'Ctrl+Alt+C e Pause interrompem');
  key(v.el, 'c', { ctrlKey: true });
  eq(v.sent, ['\x03'], 'Ctrl+C sem seleção vai ao guest');
});

test('modo-linha-enter-ctrl-d-e-atalhos', () => {
  const v = view();
  for (const c of 'oi') key(v.el, c);
  key(v.el, 'F8');
  key(v.el, 'Enter');
  key(v.el, 'd', { ctrlKey: true });
  eq(v.sent, ['oi\n'], 'linha enviada no Enter');
  eq(v.eofs.length, 1, 'Ctrl+D na linha vazia = EOF');
});

test('write-system-depois-de-osc-aberto', () => {
  const v = view();
  v.t.write(Buffer.from('saida\x1b]0;titulo sem fim'));
  v.t.writeSystem('fim: código de saída 0', 'ok');
  eq(v.t.screen.lineText(1), '[ksweb] fim: código de saída 0', 'mensagem visível');
  v.t.write(Buffer.from('\x07depois'));
  eq(v.t.screen.lineText(2), 'depois', 'o guest continua depois do OSC');
  eq(v.t.screen.title, 'titulo sem fim', 'título do guest preservado');
});

test('html-da-saida-escapado', () => {
  const v = view({ cols: 60 });
  v.t.write(Buffer.from('<img src=x onerror=alert(1)>&"\x1b[38;2;1;2;3m<b>'));
  v.t.render();
  const html = v.t.rowEls[0].innerHTML;
  ok(!/<img|<b>/.test(html), 'sem tags do guest: ' + html);
  ok(html.includes('&lt;img src=x onerror=alert(1)&gt;&amp;&quot;'), 'texto escapado: ' + html);
  ok(html.includes('style="color:rgb(1,2,3)"'), 'truecolor inline: ' + html);
});

console.log('test_terminal: ' + total + ' casos, ' + failed + ' falhas');
process.exit(failed ? 1 : 0);
