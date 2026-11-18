#!/usr/bin/env node
/* test_lineedit.js — teclado -> bytes e editor de linha (web/input.js),
 * com o eco passando pelo emulador VT (web/vt.js) para conferir a tela. */
'use strict';
const { keyToBytes, LineEditor } = require('../web/input.js');
const { VtScreen } = require('../web/vt.js');

let total = 0, failed = 0;
function test(name, fn) {
  total++;
  try { fn(); } catch (e) { failed++; console.log('FALHA [' + name + '] ' + e.message); }
}
function eq(a, b, what) {
  const sa = JSON.stringify(a), sb = JSON.stringify(b);
  if (sa !== sb) throw new Error((what || 'valor') + ': ' + sa + ' != esperado ' + sb);
}
const K = (key, mods) => Object.assign({ key, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false }, mods || {});

test('teclas-xterm', () => {
  eq(keyToBytes(K('ArrowUp')), '\x1b[A');
  eq(keyToBytes(K('ArrowLeft')), '\x1b[D');
  eq(keyToBytes(K('ArrowUp'), { appCursor: true }), '\x1bOA', 'DECCKM');
  eq(keyToBytes(K('ArrowRight', { ctrlKey: true })), '\x1b[1;5C');
  eq(keyToBytes(K('ArrowDown', { shiftKey: true })), '\x1b[1;2B');
  eq(keyToBytes(K('Home')), '\x1b[H');
  eq(keyToBytes(K('End')), '\x1b[F');
  eq(keyToBytes(K('PageUp')), '\x1b[5~');
  eq(keyToBytes(K('PageDown')), '\x1b[6~');
  eq(keyToBytes(K('Insert')), '\x1b[2~');
  eq(keyToBytes(K('Delete')), '\x1b[3~');
  eq(keyToBytes(K('Delete', { shiftKey: true })), '\x1b[3;2~');
  eq(['F1', 'F2', 'F3', 'F4'].map((k) => keyToBytes(K(k))), ['\x1bOP', '\x1bOQ', '\x1bOR', '\x1bOS']);
  eq(['F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12'].map((k) => keyToBytes(K(k))),
    ['\x1b[15~', '\x1b[17~', '\x1b[18~', '\x1b[19~', '\x1b[20~', '\x1b[21~', '\x1b[23~', '\x1b[24~']);
});

test('teclas-controle', () => {
  eq(keyToBytes(K('Enter')), '\r', 'Enter no modo raw');
  eq(keyToBytes(K('Backspace')), '\x7f');
  eq(keyToBytes(K('Backspace'), { backspace: '\b' }), '\b', 'opção \\b');
  eq(keyToBytes(K('Tab')), '\t');
  eq(keyToBytes(K('Tab', { shiftKey: true })), '\x1b[Z');
  eq(keyToBytes(K('Escape')), '\x1b');
  eq(keyToBytes(K('c', { ctrlKey: true })), '\x03');
  eq(keyToBytes(K('D', { ctrlKey: true, shiftKey: true })), '\x04');
  eq(keyToBytes(K('a', { ctrlKey: true })), '\x01');
  eq(keyToBytes(K('z', { ctrlKey: true })), '\x1a');
  eq(keyToBytes(K('[', { ctrlKey: true })), '\x1b');
  eq(keyToBytes(K('\\', { ctrlKey: true })), '\x1c');
  eq(keyToBytes(K(' ', { ctrlKey: true })), '\x00');
  eq(keyToBytes(K('x', { altKey: true })), '\x1bx', 'Alt = ESC + tecla');
  eq(keyToBytes(K('ç')), 'ç');
  eq(keyToBytes(K('Shift')), null);
  eq(keyToBytes(K('Dead')), null);
  eq(keyToBytes(K('v', { metaKey: true })), null, 'Cmd+V fica para o navegador');
});

function setup() {
  const scr = new VtScreen({ cols: 40, rows: 5 });
  const sent = [];
  let eofs = 0;
  const ed = new LineEditor({ echo: (s) => scr.write(s), send: (s) => sent.push(s), eof: () => eofs++ });
  const type = (str) => { for (const ch of str) ed.key(K(ch)); };
  return { scr, sent, ed, type, eofs: () => eofs };
}

test('linha-com-eco-e-enter', () => {
  const t = setup();
  t.scr.write('> ');
  t.type('abc');
  eq(t.scr.lineText(0), '> abc', 'eco local');
  eq(t.sent, [], 'nada enviado antes do Enter');
  t.ed.key(K('Enter'));
  eq(t.sent, ['abc\n']); eq(t.scr.y, 1);
});

test('linha-edicao', () => {
  const t = setup();
  t.type('helo');
  t.ed.key(K('ArrowLeft'));
  t.type('l');
  eq(t.scr.lineText(0), 'hello', 'inserção no meio');
  t.ed.key(K('Home'));
  t.ed.key(K('Delete'));
  eq(t.scr.lineText(0), 'ello');
  t.ed.key(K('End'));
  t.ed.key(K('Backspace'));
  t.ed.key(K('Backspace'));
  eq(t.scr.lineText(0), 'el');
  t.type(' mundo cruel');
  t.ed.key(K('w', { ctrlKey: true }));
  eq(t.scr.lineText(0), 'el mundo', 'Ctrl+W');
  t.ed.key(K('Enter'));
  eq(t.sent, ['el mundo \n'], 'Ctrl+W deixa o espaço, como no tty');
  t.type('xyz');
  t.ed.key(K('u', { ctrlKey: true }));
  eq(t.scr.lineText(1), '', 'Ctrl+U apaga a linha');
  eq(t.ed.text(), '');
});

test('ctrl-d-eof-e-flush', () => {
  const t = setup();
  t.ed.key(K('d', { ctrlKey: true }));
  eq(t.eofs(), 1, 'linha vazia = EOF');
  t.type('ab');
  t.ed.key(K('d', { ctrlKey: true }));
  eq(t.sent, ['ab'], 'com texto: envia sem \\n');
  eq(t.eofs(), 1);
});

test('ctrl-c-envia-0x03', () => {
  const t = setup();
  t.type('abc');
  t.ed.key(K('c', { ctrlKey: true }));
  eq(t.sent, ['\x03']); eq(t.scr.lineText(0), 'abc^C'); eq(t.ed.text(), '');
});

test('colar-varias-linhas', () => {
  const t = setup();
  t.ed.paste('um\r\ndois\ntres');
  eq(t.sent, ['um\n', 'dois\n']); eq(t.ed.text(), 'tres');
  eq(t.scr.lineText(2), 'tres');
});

test('utf8-na-linha', () => {
  const t = setup();
  t.type('çã');
  t.ed.key(K('Backspace'));
  eq(t.ed.text(), 'ç'); eq(t.scr.lineText(0), 'ç');
});

console.log('test_lineedit: ' + total + ' casos, ' + failed + ' falhas');
process.exit(failed ? 1 : 0);
