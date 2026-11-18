#!/usr/bin/env node
/* test_vt.js — testes do emulador de terminal puro (web/vt.js). */
'use strict';
const { VtScreen, Utf8Decoder, ATTR, palette256 } = require('../web/vt.js');

let total = 0, failed = 0;
function test(name, fn) {
  total++;
  try { fn(); } catch (e) { failed++; console.log('FALHA [' + name + '] ' + e.message); }
}
function eq(a, b, what) {
  const sa = JSON.stringify(a), sb = JSON.stringify(b);
  if (sa !== sb) throw new Error((what || 'valor') + ': ' + sa + ' != esperado ' + sb);
}
function vt(cols, rows, opts) {
  return new VtScreen(Object.assign({ cols: cols || 20, rows: rows || 5 }, opts || {}));
}
const E = '\x1b';
const cur = (s) => [s.x, s.y];

/* ---- controle ---- */
test('texto-cr-lf', () => {
  const s = vt();
  s.write('abc\r\ndef');
  eq(s.lineText(0), 'abc'); eq(s.lineText(1), 'def'); eq(cur(s), [3, 1]);
});
test('lf-com-onlcr-padrao', () => {
  const s = vt();
  s.write('ab\ncd');
  eq(s.lineText(1), 'cd', 'LF volta à coluna 0 (newlineMode)');
});
test('lf-sem-onlcr', () => {
  const s = vt(20, 5, { newlineMode: false });
  s.write('ab\ncd');
  eq(s.lineText(1), '  cd', 'LF puro só desce');
  s.write(E + '[20h\nx');
  eq(s.lineText(2), 'x', 'LNM liga CR+LF');
});
test('vt-ff-como-lf', () => {
  const s = vt();
  s.write('a\x0bb\x0cc');
  eq([s.lineText(0), s.lineText(1), s.lineText(2)], ['a', 'b', 'c']);
});
test('bs-ht-bel', () => {
  const s = vt(30, 3);
  let bells = 0;
  s.onBell = () => bells++;
  s.write('abc\b\bX\tY\x07');
  eq(s.lineText(0), 'aXc     Y'); eq(bells, 1); eq(s.x, 9);
  s.write('\r\t\t\t\t\t');
  eq(s.x, 29, 'tab para na última coluna');
});
test('bs-com-wrap-pendente', () => {
  const s = vt(5, 2);
  s.write('abcde');
  eq(s.wrapPending, true);
  s.write('\bX');
  eq(s.lineText(0), 'abcXe', 'BS cancela o wrap e volta uma coluna');
});
test('cht-cbt-hts-tbc', () => {
  const s = vt(40, 2);
  s.write(E + '[2I');
  eq(s.x, 16);
  s.write(E + '[Z');
  eq(s.x, 8);
  s.write(E + '[3g\r' + E + '[5C' + E + 'H\r\t');
  eq(s.x, 5, 'tab definido com ESC H depois de limpar todos');
});

/* ---- wrap ---- */
test('autowrap', () => {
  const s = vt(5, 3);
  s.write('abcdefg');
  eq(s.lineText(0), 'abcde'); eq(s.lineText(1), 'fg'); eq(s.lines[0].wrapped, true);
});
test('wrap-pendente-na-ultima-coluna', () => {
  const s = vt(5, 3);
  s.write('abcde');
  eq(cur(s), [4, 0], 'cursor fica na última coluna'); eq(s.wrapPending, true);
  s.write('\r\n');
  eq(cur(s), [0, 1], 'CR LF não gera linha em branco extra');
});
test('sem-autowrap', () => {
  const s = vt(5, 3);
  s.write(E + '[?7labcdefg');
  eq(s.lineText(0), 'abcdg'); eq(s.lineText(1), '');
  s.write(E + '[?7h');
  eq(s.autowrap, true);
});

/* ---- cursor ---- */
test('cup-hvp-cha-vpa', () => {
  const s = vt(20, 10);
  s.write(E + '[3;5HX');
  eq(s.cell(4, 2).c, 'X');
  s.write(E + '[1;1fY');
  eq(s.cell(0, 0).c, 'Y');
  s.write(E + '[10GZ');
  eq(s.cell(9, 0).c, 'Z');
  s.write(E + '[7dW');
  eq(s.cell(10, 6).c, 'W');
  s.write(E + '[H');
  eq(cur(s), [0, 0], 'CUP sem parâmetros');
  s.write(E + '[99;99H');
  eq(cur(s), [19, 9], 'limitado à tela');
});
test('cuu-cud-cuf-cub-cnl-cpl', () => {
  const s = vt(20, 10);
  s.write(E + '[5;5H' + E + '[2A');
  eq(cur(s), [4, 2]);
  s.write(E + '[3B');
  eq(cur(s), [4, 5]);
  s.write(E + '[4C');
  eq(cur(s), [8, 5]);
  s.write(E + '[2D');
  eq(cur(s), [6, 5]);
  s.write(E + '[2E');
  eq(cur(s), [0, 7]);
  s.write(E + '[3C' + E + '[4F');
  eq(cur(s), [0, 3]);
  s.write(E + '[99A');
  eq(cur(s), [0, 0], 'CUU limitado');
  s.write(E + '[0B');
  eq(cur(s), [0, 1], 'parâmetro 0 vale 1');
});
test('scp-rcp-e-decsc-decrc', () => {
  const s = vt(20, 10);
  s.write(E + '[3;4H' + E + '[1;31m' + E + '7' + E + '[0m' + E + '[8;8H' + E + '8X');
  eq(s.cell(3, 2).c, 'X'); eq(s.cell(3, 2).fg, 1, 'cor restaurada'); eq(!!(s.cell(3, 2).fl & ATTR.BOLD), true);
  s.write(E + '[5;6H' + E + '[s' + E + '[1;1H' + E + '[uY');
  eq(s.cell(5, 4).c, 'Y');
});

/* ---- apagar / inserir ---- */
function filled(cols, rows) {
  const s = vt(cols, rows);
  for (let y = 0; y < rows; y++) s.write(E + '[' + (y + 1) + ';1H' + String.fromCharCode(65 + y).repeat(cols));
  return s;
}
test('ed-0-1-2', () => {
  let s = filled(5, 3);
  s.write(E + '[2;3H' + E + '[J');
  eq([s.lineText(0), s.lineText(1), s.lineText(2)], ['AAAAA', 'BB', '']);
  s = filled(5, 3);
  s.write(E + '[2;3H' + E + '[1J');
  eq([s.lineText(0, false), s.lineText(1, false), s.lineText(2)], ['     ', '   BB', 'CCCCC']);
  s = filled(5, 3);
  s.write(E + '[2J');
  eq(s.screenText(), '');
});
test('ed-3-limpa-historico', () => {
  const s = vt(5, 2);
  s.write('1\n2\n3\n4');
  eq(s.scrollback.length, 2);
  s.write(E + '[3J');
  eq(s.scrollback.length, 0); eq(s.lineText(1), '4', 'tela intacta');
});
test('el-0-1-2', () => {
  let s = filled(5, 1);
  s.write(E + '[1;3H' + E + '[K');
  eq(s.lineText(0), 'AA');
  s = filled(5, 1);
  s.write(E + '[1;3H' + E + '[1K');
  eq(s.lineText(0, false), '   AA');
  s = filled(5, 1);
  s.write(E + '[2K');
  eq(s.lineText(0), '');
});
test('il-dl', () => {
  let s = filled(3, 4);
  s.write(E + '[2;2H' + E + '[L');
  eq([0, 1, 2, 3].map((y) => s.lineText(y)), ['AAA', '', 'BBB', 'CCC']); eq(s.x, 0);
  s = filled(3, 4);
  s.write(E + '[2;1H' + E + '[2M');
  eq([0, 1, 2, 3].map((y) => s.lineText(y)), ['AAA', 'DDD', '', '']);
});
test('ich-dch-ech', () => {
  let s = vt(6, 1);
  s.write('abcdef' + E + '[1;2H' + E + '[2@');
  eq(s.lineText(0), 'a  bcd');
  s = vt(6, 1);
  s.write('abcdef' + E + '[1;2H' + E + '[2P');
  eq(s.lineText(0), 'adef');
  s = vt(6, 1);
  s.write('abcdef' + E + '[1;2H' + E + '[3X');
  eq(s.lineText(0), 'a   ef'); eq(s.x, 1, 'ECH não move o cursor');
});
test('su-sd', () => {
  let s = filled(3, 3);
  s.write(E + '[S');
  eq([0, 1, 2].map((y) => s.lineText(y)), ['BBB', 'CCC', '']);
  s = filled(3, 3);
  s.write(E + '[2T');
  eq([0, 1, 2].map((y) => s.lineText(y)), ['', '', 'AAA']);
});
test('rep', () => {
  const s = vt(20, 2);
  s.write('x' + E + '[4b');
  eq(s.lineText(0), 'xxxxx');
  s.write(E + '(0q' + E + '[2b' + E + '(B');
  eq(s.lineText(0), 'xxxxx───', 'REP repete o caractere já mapeado');
});
test('insert-mode', () => {
  const s = vt(8, 1);
  s.write('abcd\r' + E + '[4hXY' + E + '[4lZ');
  eq(s.lineText(0), 'XYZbcd');
});

/* ---- DSR / DA ---- */
test('dsr-5-6-e-da', () => {
  const resp = [];
  const s = vt(20, 10, { onResponse: (r) => resp.push(r) });
  s.write(E + '[5n' + E + '[4;7H' + E + '[6n' + E + '[c');
  eq(resp, ['\x1b[0n', '\x1b[4;7R', '\x1b[?1;2c']);
});

/* ---- região de rolagem ---- */
test('decstbm-rola-so-a-regiao', () => {
  const s = filled(3, 5);
  s.write(E + '[2;4r');
  eq(cur(s), [0, 0], 'DECSTBM leva o cursor ao início');
  s.write(E + '[4;1H\nX');
  eq([0, 1, 2, 3, 4].map((y) => s.lineText(y)), ['AAA', 'CCC', 'DDD', 'X', 'EEE']);
  eq(s.scrollback.length, 0, 'rolagem de região interna não vai para o histórico');
  s.write(E + '[2;1H' + E + 'M');
  eq([0, 1, 2, 3, 4].map((y) => s.lineText(y)), ['AAA', '', 'CCC', 'DDD', 'EEE'], 'RI no topo da região');
  s.write(E + '[r');
  eq([s.top, s.bottom], [0, 4], 'reset da região');
});
test('decstbm-cuu-cud-presos-na-regiao', () => {
  const s = vt(5, 10);
  s.write(E + '[3;6r' + E + '[4;1H' + E + '[9A');
  eq(s.y, 2); s.write(E + '[9B'); eq(s.y, 5);
});
test('origin-mode', () => {
  const s = vt(5, 10);
  s.write(E + '[3;6r' + E + '[?6h' + E + '[1;1HX' + E + '[6n');
  eq(s.cell(0, 2).c, 'X', 'CUP relativo ao topo da região');
});
test('scrollback-limite', () => {
  const s = vt(5, 2, { scrollback: 3 });
  for (let i = 0; i < 10; i++) s.write(i + '\n');
  eq(s.scrollback.length, 3); eq(VtScreen.lineToText(s.scrollback[2]).trim(), '8');
  eq(s.takeScrolledOut().length, 9); eq(s.takeScrolledOut().length, 0);
});
test('ind-ri-nel', () => {
  const s = filled(3, 3);
  s.write(E + '[3;2H' + E + 'D');
  eq(s.lineText(0), 'BBB', 'IND no fundo rola'); eq(cur(s), [1, 2]);
  s.write(E + 'E');
  eq(cur(s), [0, 2], 'NEL');
  s.write(E + '[1;1H' + E + 'M');
  eq(s.lineText(0), '', 'RI no topo rola para baixo'); eq(s.lineText(1), 'CCC');
});

/* ---- SGR ---- */
test('sgr-atributos', () => {
  const s = vt(30, 2);
  const codes = [[1, ATTR.BOLD], [2, ATTR.DIM], [3, ATTR.ITALIC], [4, ATTR.UNDERLINE], [5, ATTR.BLINK],
    [7, ATTR.INVERSE], [8, ATTR.HIDDEN], [9, ATTR.STRIKE]];
  codes.forEach(([n, bit], i) => {
    s.write(E + '[' + n + 'm' + String.fromCharCode(97 + i) + E + '[0m');
    eq(s.cell(i, 0).fl, bit, 'SGR ' + n);
  });
  s.write('\r\n' + E + '[1;2;3;4;5;7;8;9m' + E + '[22;23;24;25;27;28;29mz');
  eq(s.cell(0, 1).fl, 0, 'SGR 22..29 desligam');
});
test('sgr-cores', () => {
  const s = vt(30, 2);
  s.write(E + '[31;42ma' + E + '[93;104mb' + E + '[39;49mc');
  eq([s.cell(0, 0).fg, s.cell(0, 0).bg], [1, 2]);
  eq([s.cell(1, 0).fg, s.cell(1, 0).bg], [11, 12]);
  eq([s.cell(2, 0).fg, s.cell(2, 0).bg], [-1, -1]);
  s.write(E + '[38;5;208;48;5;17md');
  eq([s.cell(3, 0).fg, s.cell(3, 0).bg], [208, 17]);
  s.write(E + '[38;2;10;20;30;48;2;255;0;128me');
  eq([s.cell(4, 0).fg, s.cell(4, 0).bg], [VtScreen.RGB | 0x0A141E, VtScreen.RGB | 0xFF0080]);
  s.write(E + '[38:5:99m' + 'f' + E + '[48:2::1:2:3mg');
  eq(s.cell(5, 0).fg, 99, '38:5:n'); eq(s.cell(6, 0).bg, VtScreen.RGB | 0x010203, '48:2::r:g:b');
  s.write(E + '[m' + E + '[1;31mh' + E + '[mi');
  eq(s.cell(8, 0).fg, -1, 'CSI m = reset');
});
test('erase-usa-cor-de-fundo-atual', () => {
  const s = vt(5, 2);
  s.write(E + '[44m' + E + '[2K');
  eq(s.cell(2, 0).bg, 4);
});
test('paleta-256', () => {
  eq(palette256(16), [0, 0, 0]); eq(palette256(231), [255, 255, 255]); eq(palette256(232), [8, 8, 8]);
  eq(palette256(196), [255, 0, 0]);
});

/* ---- modos privados ---- */
test('cursor-visivel', () => {
  const s = vt();
  s.write(E + '[?25l'); eq(s.cursorVisible, false);
  s.write(E + '[?25h'); eq(s.cursorVisible, true);
});
test('tela-alternativa-1049', () => {
  const s = vt(10, 3);
  s.write('principal' + E + '[2;3H');
  s.write(E + '[?1049h');
  eq(s.altActive, true); eq(s.screenText(), '', 'alternativa limpa');
  s.write('alt' + E + '[3;1Hfundo\n\n\n');
  eq(s.scrollback.length, 0, 'tela alternativa não alimenta o histórico');
  s.write(E + '[?1049l');
  eq(s.altActive, false); eq(s.lineText(0), 'principal'); eq(cur(s), [2, 1], 'cursor restaurado');
});
test('tela-alternativa-47', () => {
  const s = vt(10, 3);
  s.write('main' + E + '[?47hALT' + E + '[?47l');
  eq(s.lineText(0), 'main');
  s.write(E + '[?47h');
  eq(s.lineText(0), '    ALT', '47 não limpa a alternativa (nem move o cursor)');
});
test('modos-aceitos-e-ignorados', () => {
  const s = vt();
  s.write(E + '[?12h' + E + '[?12l' + E + '[?2004h' + E + '[?1000h' + E + '[?1006h' + E + '[?1hok');
  eq(s.lineText(0), 'ok'); eq(s.bracketedPaste, true); eq(s.appCursor, true);
});

/* ---- ESC simples ---- */
test('ris', () => {
  const s = vt(10, 3);
  s.write(E + '[31m' + E + '[?25l' + E + '(0' + 'abc' + E + 'c');
  eq(s.screenText(), ''); eq(s.cursorVisible, true); eq(s.fg, -1); eq(s.g[0], 'B'); eq(cur(s), [0, 0]);
});
test('dec-special-graphics', () => {
  const s = vt(20, 3);
  s.write(E + '(0lqqk\r\nx  x\r\nmqqj' + E + '(Bq');
  eq(s.lineText(0), '┌──┐');
  eq(s.lineText(1), '│  │');
  eq(s.lineText(2), '└──┘q', 'ESC ( B volta ao ASCII');
  s.write('\r' + E + '(0tuvwn' + E + '(B');
  eq(s.lineText(2).slice(0, 5), '├┤┴┬┼');
});
test('g1-com-so-si', () => {
  const s = vt(10, 2);
  s.write(E + ')0a\x0eq\x0fq');
  eq(s.lineText(0), 'a─q');
});
test('decaln', () => {
  const s = vt(3, 2);
  s.write(E + '#8');
  eq(s.screenText(), 'EEE\nEEE');
});

/* ---- OSC e strings ---- */
test('osc-titulo-bel-e-st', () => {
  const titles = [];
  const s = vt(20, 2, { onTitle: (t) => titles.push(t) });
  s.write(E + ']0;Meu título\x07a' + E + ']2;outro' + E + '\\b');
  eq(titles, ['Meu título', 'outro']); eq(s.lineText(0), 'ab');
});
test('osc-desconhecido-consumido', () => {
  const s = vt(20, 2);
  s.write(E + ']52;c;SGVsbG8=\x07x' + E + ']8;;http://a\x1b\\y' + E + ']777;notify;a;b' + E + '\\z');
  eq(s.lineText(0), 'xyz'); eq(s.title, '');
});
test('dcs-pm-apc-consumidos', () => {
  const s = vt(20, 2);
  s.write(E + 'P1$r0m' + E + '\\a' + E + '^privado' + E + '\\b' + E + '_apc' + E + '\\c');
  eq(s.lineText(0), 'abc');
});
test('sequencias-desconhecidas-nao-vazam', () => {
  const s = vt(30, 2);
  s.write(E + '[>0c' + E + '[1 q' + E + '[?u' + E + '[=5h' + E + '[!p' + E + '[99;99;99y' + E + 'N' + E + 'Oa' +
    E + '[12;5;' + E + '[1mB' + E + '[\x18C' + E + '%G' + 'D');
  eq(s.lineText(0), 'aBCD');
});
test('controle-dentro-de-csi-executa', () => {
  const s = vt(10, 3);
  s.write('ab' + E + '[\r2Cx');
  eq(s.lineText(0), 'abx', 'CR executado no meio do CSI, depois CUF 2');
});
test('parametros-enormes-limitados', () => {
  const s = vt(10, 3);
  s.write(E + '[' + '9'.repeat(400) + 'Cx');
  eq(s.cell(9, 0).c, 'x');
});

/* ---- UTF-8 e largura ---- */
const enc = (str) => Array.from(Buffer.from(str, 'utf8'));
test('utf8-partido-entre-escritas', () => {
  const s = vt(10, 2);
  const b = enc('ção€😀');
  for (const byte of b) s.write([byte]);
  eq(s.lineText(0), 'ção€😀');
});
test('utf8-invalido-vira-fffd', () => {
  const d = new Utf8Decoder();
  eq(d.decode([0x61, 0xFF, 0x62, 0xC3, 0x41, 0xE2, 0x82]), [0x61, 0xFFFD, 0x62, 0xFFFD, 0x41]);
  eq(d.decode([0xAC]), [0x20AC], 'continua a sequência pendente');
  eq(new Utf8Decoder().decode([0xC0, 0x80]), [0xFFFD], 'overlong');
});
test('largura-dupla-cjk-e-emoji', () => {
  const s = vt(6, 2);
  s.write('a中b');
  eq(s.x, 4); eq(s.cell(1, 0).c, '中'); eq(s.cell(2, 0).c, ''); eq(!!(s.cell(2, 0).fl & ATTR.WIDE_CONT), true);
  eq(s.lineText(0), 'a中b');
  s.write('x😀');
  eq(s.lineText(0), 'a中bx', 'não cabe na última coluna: quebra');
  eq(s.lineText(1), '😀');
  s.write('\r中');
  s.write('\rZ');
  eq(s.lineText(1), 'Z', 'sobrescrever metade apaga o largo');
});
test('combinantes-juntam', () => {
  const s = vt(6, 2);
  s.write('éx');
  eq(s.cell(0, 0).c, 'é'); eq(s.x, 2);
});

/* ---- regressões (revisão) ---- */
test('cuu-cud-fora-da-regiao-param-na-margem', () => {
  /* xterm (CursorUp/CursorDown): abaixo da região, CUU para na margem de
   * cima; acima dela, CUD para na margem de baixo. */
  const s = vt(5, 10);
  s.write(E + '[3;6r' + E + '[9;1H' + E + '[20A');
  eq(s.y, 2, 'CUU de baixo da região para no topo dela');
  s.write(E + '[1;1H' + E + '[20B');
  eq(s.y, 5, 'CUD de cima da região para no fundo dela');
  s.write(E + '[8;1H' + E + '[1A');
  eq(s.y, 6, 'CUU curto abaixo da região anda normalmente');
  s.write(E + '[9;1H' + E + '[5B');
  eq(s.y, 9, 'CUD abaixo da região vai até a última linha');
  s.write(E + '[2;1H' + E + '[20F');
  eq([s.x, s.y], [0, 0], 'CPL acima da região vai até a linha 1');
});
test('il-dl-cancelam-wrap-pendente', () => {
  for (const f of ['L', 'M']) {
    const s = vt(5, 4);
    s.write(E + '[2;1Habcde' + E + '[' + f + 'X');
    eq([s.x, s.y], [1, 1], f + ': cursor na coluna 1 da mesma linha');
    eq(s.cell(0, 1).c, 'X', f + ': X na coluna 0, sem quebrar a linha');
  }
});
test('sgr-cor-invalida-ou-incompleta-ignorada', () => {
  const s = vt(10, 2);
  s.write(E + '[38;5;3m');
  for (const seq of ['38;5', '38;5;256', '38;2;1;2', '38;2;300;0;0', '38:5:256', '38:5']) {
    s.write(E + '[' + seq + 'm');
    eq(s.fg, 3, 'ESC[' + seq + 'm mantém a cor');
  }
  s.write(E + '[48;5;999;1m');
  eq([s.bg, !!(s.fl & ATTR.BOLD)], [-1, true], '256 inválido consome os parâmetros e segue');
  s.write(E + '[38;2;10;20;30;4m');
  eq([s.fg, !!(s.fl & ATTR.UNDERLINE)], [VtScreen.RGB | 0x0A141E, true], 'truecolor válido');
});
test('dcs-sem-st-e-abortado-por-esc', () => {
  /* Williams/xterm: ESC em qualquer estado começa uma nova sequência. */
  const s = vt(20, 2);
  s.write(E + 'Pnunca termina' + E + '[2;1Hok');
  eq(s.lineText(1), 'ok', 'o CSI depois do DCS sem ST é executado');
  s.write(E + '_apc' + E + 'c');
  eq(s.screenText(), '', 'ESC c (RIS) também aborta APC');
});
test('ech-el-vizinhos-de-largo', () => {
  let s = vt(6, 1);
  s.write('ab中d' + E + '[1G' + E + '[2X');
  eq(s.lineText(0), '  中d', 'ECH até antes de um largo não o desfaz');
  eq(!!(s.cell(2, 0).fl & ATTR.WIDE), true, 'continua largo');
  s = vt(6, 1);
  s.write('a中de' + E + '[1G' + E + '[2X');
  eq(s.lineText(0), '   de', 'ECH sobre a metade esquerda apaga o largo inteiro');
  eq(s.cell(2, 0).c, ' ', 'a metade direita vira espaço');
  s = vt(6, 1);
  s.write('a中de' + E + '[2G' + E + '[P');
  eq(s.lineText(0), 'a de', 'DCH na metade esquerda');
  eq(s.cell(1, 0).fl & (ATTR.WIDE | ATTR.WIDE_CONT), 0, 'sem metade órfã');
});
test('escrita-fora-de-banda-no-meio-de-sequencia', () => {
  /* Mensagens [ksweb] no meio de um OSC/CSI do guest não podem ser
   * engolidas, e o guest continua a sequência dele depois. */
  const titles = [];
  const s = vt(30, 4, { onTitle: (t) => titles.push(t) });
  s.write('x' + E + ']0;meu tí');
  s.outOfBand(() => s.write('\r\n[ksweb] fim\r\n'));
  eq(s.lineText(1), '[ksweb] fim', 'mensagem visível');
  s.write('tulo\x07' + E + '[');
  s.outOfBand(() => s.write('[ksweb] dois'));
  s.write('1mB');
  eq(titles, ['meu título'], 'o OSC do guest continua intacto');
  eq(s.lineText(2), '[ksweb] doisB', 'CSI do guest retomado');
  eq(!!(s.cell(12, 2).fl & ATTR.BOLD), true, 'SGR aplicado');
});

test('decstbm-fundo-alem-da-tela-vale-a-ultima-linha', () => {
  /* xterm: margem de baixo 0, omitida ou maior que a tela = última linha;
   * topo >= fundo continua ignorado. */
  const s = vt(5, 10);
  s.write(E + '[3;5r' + E + '[4;2H' + E + '[2;99r');
  eq([s.top, s.bottom], [1, 9], 'fundo 99 limitado à tela');
  eq(cur(s), [0, 0], 'e o cursor vai ao início');
  s.write(E + '[4;4r' + E + '[5;5H' + E + '[11;20r');
  eq([s.top, s.bottom, s.y], [1, 9, 4], 'topo >= fundo: ignorado');
});

/* ---- resize ---- */
test('resize', () => {
  const s = vt(10, 4);
  s.write('1\n2\n3\n4');
  s.resize(5, 2);
  eq([s.cols, s.rows], [5, 2]); eq(s.lineText(1), '4', 'cursor continua visível');
  eq(s.scrollback.length, 2);
  s.resize(12, 6);
  eq(s.lines.length, 6); eq(s.lines[0].cells.length, 12);
  s.write(E + '[6;12HX');
  eq(s.cell(11, 5).c, 'X');
});

/* ---- linhas sujas ---- */
test('linhas-sujas', () => {
  const s = vt(5, 3);
  for (const l of s.lines) l.dirty = false;
  s.write(E + '[2;1Hx');
  eq(s.lines.map((l) => l.dirty), [false, true, false]);
});

/* ---- exemplo vtdemo: saída real do guest ---- */
test('vtdemo-caixa', () => {
  const fs = require('fs');
  const path = require('path');
  const p = path.join(__dirname, '..', 'build', 'examples', 'vtdemo.ksx');
  if (!fs.existsSync(p)) return;
  const { KsCore, KsSession } = require('../web/vmcore.js');
  const core = KsCore.createSync(fs.readFileSync(path.join(__dirname, '..', 'build', 'ksvm.wasm')));
  const ses = new KsSession(core, {});
  ses.load(fs.readFileSync(p));
  const r = ses.runSync('');
  const s = vt(80, 24);
  s.write(r.stdout);
  eq(s.lineText(1), '   ┌' + '─'.repeat(40) + '┐');
  eq(s.lineText(5), '   └' + '─'.repeat(40) + '┘');
  eq(s.lineText(6), '   progresso: 100%');
  eq(s.cell(4, 4).bg, VtScreen.RGB | (255 << 16) | 80, 'primeira célula da barra');
  eq(s.cursorVisible, true);
  eq(s.lineText(10), '   pronto!');
});

console.log('test_vt: ' + total + ' casos, ' + failed + ' falhas');
process.exit(failed ? 1 : 0);
