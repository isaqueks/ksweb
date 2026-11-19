#!/usr/bin/env node
/*
 * test_asmtools.js — montagem pela IDE (web/asmtools.js) e a linguagem do
 * editor (web/ksasm-lang.js), em Node:
 *
 *   node test/test_asmtools.js --build build --native build/native --ksvm2 ../ksvm2
 *
 * - parser de erros do ksas (arquivo:linha:coluna, sem coluna, sem linha,
 *   resumo), coluna em bytes UTF-8 -> caractere;
 * - mapa linha <-> endereço contra o listing do ksas nativo (lido aqui por
 *   um parser independente) e contra os bytes da imagem, com .include;
 * - breakpoint em linha sem código vai para a próxima linha com código;
 * - tokenizer (casos de realce), rótulos do arquivo, contexto e opções de
 *   autocomplete, palavra sob o cursor e ajuda;
 * - desassembly do ksdis.wasm com endereços.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const Lang = require('../web/ksasm-lang.js');
const T = require('../web/asmtools.js');

const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
const BUILD = args.build || 'build';
const NATIVE = args.native || path.join(BUILD, 'native');
const K = path.resolve(args.ksvm2 || '../ksvm2');
const KSAS = fs.readFileSync(path.join(BUILD, 'ksas.wasm'));
const KSDIS = fs.readFileSync(path.join(BUILD, 'ksdis.wasm'));
const ISA = JSON.parse(fs.readFileSync(path.join(BUILD, 'web/isa.json'), 'utf8'));
const WORK = path.resolve(BUILD, 'test-tmp/asmtools');
fs.mkdirSync(WORK, { recursive: true });
Lang.setIsa(ISA);

let total = 0, failed = 0;
function test(name, fn) {
  total++;
  try { fn(); } catch (e) { failed++; console.log('FALHA [' + name + '] ' + (e && e.stack ? e.stack.split('\n').slice(0, 2).join(' | ') : e)); }
}
function eq(a, b, what) {
  const sa = JSON.stringify(a), sb = JSON.stringify(b);
  if (sa !== sb) throw new Error((what || 'valor') + ': ' + sa.slice(0, 600) + ' != esperado ' + sb.slice(0, 600));
}
function ok(c, what) { if (!c) throw new Error(what || 'condição falsa'); }

const exFiles = new Map();
for (const f of fs.readdirSync(path.join(K, 'examples'))) if (f.endsWith('.ksasm')) exFiles.set(f, fs.readFileSync(path.join(K, 'examples', f), 'utf8'));
exFiles.set('lib/io.ksasm', fs.readFileSync(path.join(K, 'examples/lib/io.ksasm'), 'utf8'));

/* ---- diagnósticos ---- */

test('parseDiagnostics', () => {
  const d = T.parseDiagnostics("a.ksasm:3:7: erro: esperado ','\nlib/x.ksasm:12: erro: sem coluna\na.ksasm: erro: muitos erros; montagem abortada\nksas: 2 erro(s); nenhuma saida gerada\n");
  eq(d.map((x) => [x.file, x.line, x.col, x.message, x.severity]), [
    ['a.ksasm', 3, 7, "esperado ','", 'error'], ['lib/x.ksasm', 12, 0, 'sem coluna', 'error'],
    ['a.ksasm', 0, 0, 'muitos erros; montagem abortada', 'error'], [null, 0, 0, '2 erro(s); nenhuma saida gerada', 'info']]);
});

test('diagnósticos reais do ksas.wasm com .include e coluna UTF-8', () => {
  const files = new Map([['m.ksasm', '; acentuação\n_start:\n  movi r1, ção\n  .include "inc/b.ksasm"\n'], ['inc/b.ksasm', '\n  foo r1\n']]);
  const r = T.assemble(KSAS, { files, main: 'm.ksasm' });
  ok(!r.ok && r.exitCode === 1, 'falhou');
  const errs = r.diagnostics.filter((x) => x.severity === 'error');
  eq(errs.map((x) => [x.file, x.line]), [['m.ksasm', 3], ['inc/b.ksasm', 2]]);
  const line = '  movi r1, ção';
  eq(T.byteColToChar(line, errs[0].col), line.indexOf('ç'), 'coluna em caracteres');
  eq(T.byteColToChar('ação x', 6), 3, 'byte 6 = o "o" de "ação"');
  eq(T.byteColToChar('ação x', 7), 4, 'byte 7 = depois de "ação"');
  eq(r.image, null);
});

/* O ksas cita o incluído como escrito no .include ("./lib/a.ksasm"); o
 * explorador chama o arquivo "lib/a.ksasm". Sem normalizar, o erro não ia
 * para o editor e o breakpoint no incluído não resolvia. */
test('.include com ./, .. e / : nomes do projeto nos erros e no mapa', () => {
  const lib = 'f:\n  nop\n  ret\n';
  for (const inc of ['./lib/a.ksasm', 'lib/../lib/a.ksasm', '/lib/a.ksasm', 'lib/./a.ksasm']) {
    const r = T.assemble(KSAS, { files: { 'm.ksasm': '_start:\n  call f\n  halt\n  .include "' + inc + '"\n', 'lib/a.ksasm': lib }, main: 'm.ksasm' });
    ok(r.ok, inc + ': ' + r.stderr);
    ok(r.info.files.includes('lib/a.ksasm'), inc + ': arquivos ' + JSON.stringify(r.info.files));
    eq(T.resolveBreakpoint(r.info, 'lib/a.ksasm', 1), { line: 2, addr: 8, moved: true }, inc + ': breakpoint no incluído');
    eq(r.info.addrLine.get(12), { file: 'lib/a.ksasm', line: 3 }, inc + ': linha atual no incluído');
    eq([r.info.symByName.get('f').file, r.info.symByName.get('f').line], ['lib/a.ksasm', 1], inc + ': definição do rótulo');
    const bad = T.assemble(KSAS, { files: { 'm.ksasm': '_start:\n  halt\n  .include "' + inc + '"\n', 'lib/a.ksasm': '\n  foo r1\n' }, main: 'm.ksasm' });
    eq(bad.diagnostics.filter((x) => x.severity === 'error').map((x) => [x.file, x.line, x.col]), [['lib/a.ksasm', 2, 3]], inc + ': erro no incluído');
    ok(bad.stderr.startsWith(inc + ':2:3: erro: '), inc + ': stderr do ksas intacto: ' + bad.stderr);
  }
  eq(T.parseDiagnostics('../fora.ksasm:1:1: erro: x\n')[0].file, '../fora.ksasm', 'fora da raiz fica como veio');
});

/* ---- listing e mapa linha <-> endereço ---- */

/* Parser independente do listing nativo: linhas de instrução = 4 ou 8 bytes
 * com fonte que não começa por diretiva. */
function nativeMap(lst) {
  const map = new Map();
  let file = null;
  for (const l of lst.split('\n')) {
    const f = /^; arquivo (.*)$/.exec(l);
    if (f) { file = f[1]; continue; }
    /* colunas fixas: "%-8s  %-23s  %5lu  fonte"; instrução = 4 ou 8 bytes */
    const m = /^([0-9A-F]{8})  (.{23})  ( {0,4}\d+)  (.*)$/.exec(l);
    if (!m || !/^(?:[0-9A-F]{2} ){3}[0-9A-F]{2}(?:(?: [0-9A-F]{2}){4})? *$/.test(m[2])) continue;
    m[3] = m[3].trim();
    const code = m[4].replace(/[;#].*$/, '').replace(/^\s*([A-Za-z_][\w.]*:\s*)*/, '').trim();
    if (!code || code.startsWith('.')) continue;
    map.set(parseInt(m[1], 16), file + ':' + m[3]);
  }
  return map;
}

for (const ex of [...exFiles.keys()].filter((f) => !f.includes('/'))) {
  test('mapa linha<->endereço ' + ex, () => {
    const r = T.assemble(KSAS, { files: exFiles, main: ex });
    ok(r.ok, r.stderr);
    const lst = path.join(WORK, ex + '.lst');
    const n = spawnSync(path.resolve(NATIVE, 'ksas'), [ex, '-o', path.join(WORK, ex + '.ksx'), '-l', lst, '-g'], { cwd: path.join(K, 'examples') });
    eq(n.status, 0, 'nativo');
    const want = nativeMap(fs.readFileSync(lst, 'utf8'));
    const got = new Map([...r.info.addrLine].map(([a, v]) => [a, v.file + ':' + v.line]));
    eq([...got].sort((a, b) => a[0] - b[0]), [...want].sort((a, b) => a[0] - b[0]), 'mapa');
    /* os bytes do listing são os da imagem em cada endereço de instrução */
    const img = r.image, dv = new DataView(img.buffer, img.byteOffset);
    const codeOff = dv.getUint32(0x0C, true);
    for (const row of r.listing.rows.filter((x) => x.kind === 'insn')) {
      eq([...img.subarray(codeOff + row.addr, codeOff + row.addr + row.size)], row.bytes, ex + ':' + row.line + ' bytes');
      ok(row.size === 4 || row.size === 8, 'tamanho de instrução');
    }
    /* símbolos do listing = tabela .ksx (-g) */
    ok(r.info.symbols.length > 0 && r.info.symByName.has('_start'), 'símbolos');
    eq(r.info.header.codeSize, dv.getUint32(0x10, true), 'code_size do resumo');
    if (/include/.test(exFiles.get(ex))) ok(r.info.code.has('lib/io.ksasm') && r.info.files.includes('lib/io.ksasm'), 'linhas do arquivo incluído');
  });
}

test('listing: equ, .space grande, .bss, continuação de dados', () => {
  const src = 'N = 7\n_start: li r1, N\n  halt\n  .data\nmsg: .asciz "uma string bem comprida"\nbig: .space 100\n  .bss\nbuf: .space 64\n';
  const r = T.assemble(KSAS, { files: { 'a.ksasm': src }, main: 'a.ksasm' });
  ok(r.ok, r.stderr);
  const byLine = new Map(r.listing.rows.map((x) => [x.line, x]));
  eq([byLine.get(1).kind, byLine.get(1).value], ['equ', 7]);
  eq(byLine.get(2).kind, 'insn');
  eq([byLine.get(5).kind, byLine.get(5).size], ['data', 24], 'asciz em 3 linhas');
  eq([byLine.get(6).kind, byLine.get(6).size], ['data', 100]);
  eq([byLine.get(8).kind, byLine.get(8).size], ['data', 64], '.bss reserva');
  eq(r.info.code.get('a.ksasm'), [2, 3]);
  eq(r.listing.sections.map((s) => s.name), ['.text', '.rodata', '.data', '.bss']);
  eq(r.info.symByName.get('N').kind, 'equ');
  eq([r.info.symByName.get('msg').file, r.info.symByName.get('msg').line], ['a.ksasm', 5], 'linha do rótulo');
});

test('breakpoint em linha sem código vai para a próxima', () => {
  const src = '; cabeçalho\n\n_start:\n  li r1, 1     ; 4\n\n  ; comentário\nloop:\n  dec r1\n  .data\nx: .word 1\n  .text\n  halt\n\n';
  const r = T.assemble(KSAS, { files: { 'p.ksasm': src }, main: 'p.ksasm' });
  ok(r.ok, r.stderr);
  const R = (l) => T.resolveBreakpoint(r.info, 'p.ksasm', l);
  eq(R(1), { line: 4, addr: 0, moved: true }, 'comentário -> li');
  eq(R(3), { line: 4, addr: 0, moved: true }, 'rótulo -> li');
  eq(R(4), { line: 4, addr: 0, moved: false });
  eq(R(5), { line: 8, addr: 4, moved: true }, 'vazia/comentário/rótulo -> dec');
  eq(R(10), { line: 12, addr: 8, moved: true }, 'dado -> próxima instrução');
  eq(R(13), null, 'depois da última instrução');
  eq(T.resolveBreakpoint(r.info, 'outro.ksasm', 1), null, 'arquivo sem código');
});

/* ---- ksdis ---- */

test('ksdis.wasm: endereços e seções', () => {
  const r = T.assemble(KSAS, { files: exFiles, main: 'fib.ksasm' });
  const d = T.disassemble(KSDIS, r.image);
  ok(d.ok, d.stderr);
  const rows = T.parseKsdis(d.text);
  const code = rows.filter((x) => x.code);
  ok(code.length >= 50, 'instruções: ' + code.length);
  eq(code[0].addr, 0);
  ok(rows.some((x) => x.label === 'print_u32'), 'rótulos');
  for (const a of r.info.addrLine.keys()) ok(code.some((x) => x.addr === a), 'ksdis tem 0x' + a.toString(16));
  const raw = T.disassemble(KSDIS, r.image, true);
  ok(raw.ok && /remonte com ksas -g/.test(raw.text), 'raw');
});

/* ---- tokenizer ---- */

const types = (line) => Lang.tokenizeLine(line).map((t) => t.type + ':' + t.text);

test('tokenizer: instrução, registradores, número, comentário', () => {
  eq(types('loop:  addi r1, r2, 0x1F ; soma'), ['labelDef:loop', 'punct::', 'mnemonic:addi', 'register:r1', 'punct:,', 'register:r2', 'punct:,', 'number:0x1F', 'comment:; soma']);
  eq(types('  LDW R3, [sp + 4]   # coment'), ['mnemonic:LDW', 'register:R3', 'punct:,', 'punct:[', 'register:sp', 'operator:+', 'number:4', 'punct:]', 'comment:# coment']);
  eq(types('  stb [fp - 1], zr // c'), ['mnemonic:stb', 'punct:[', 'register:fp', 'operator:-', 'number:1', 'punct:]', 'punct:,', 'register:zr', 'comment:// c']);
});

test('tokenizer: pseudo, desvio, rótulo usado, syscall por nome', () => {
  eq(types('  li a0, 0b1010_0101'), ['pseudo:li', 'register:a0', 'punct:,', 'number:0b1010_0101']);
  eq(types('  beq fim'), ['mnemonic:beq', 'label:fim']);
  eq(types('  b.lt a.b'), ['mnemonic:b.lt', 'label:a.b']);
  eq(types('  syscall PUTC'), ['mnemonic:syscall', 'syscall:PUTC']);
  eq(types('  mfsr r1, flags'), ['mnemonic:mfsr', 'register:r1', 'punct:,', 'syscall:flags']);
  eq(types('  call print_u32'), ['mnemonic:call', 'label:print_u32']);
  eq(types('  bcond x'), ['invalid:bcond', 'label:x'], 'bcond não se escreve');
  eq(types('  xyz r1'), ['invalid:xyz', 'register:r1'], 'mnemônico desconhecido');
});

test('tokenizer: diretivas, strings, caracteres, equ, float', () => {
  eq(types('msg: .asciz "Olá\\n\\x41"'), ['labelDef:msg', 'punct::', 'directive:.asciz', 'string:"Olá\\n\\x41"']);
  eq(types('  .byte \'A\', \'\\n\', 65'), ['directive:.byte', 'char:\'A\'', 'punct:,', 'char:\'\\n\'', 'punct:,', 'number:65']);
  eq(types('COUNT = 20 << 2'), ['labelDef:COUNT', 'operator:=', 'number:20', 'operator:<<', 'number:2']);
  eq(types('  .float 1.5, -2e3, .5, inf, 0x1.8p1'), ['directive:.float', 'number:1.5', 'punct:,', 'operator:-', 'number:2e3', 'punct:,', 'number:.5', 'punct:,', 'number:inf', 'punct:,', 'number:0x1.8p1']);
  eq(types('  fli r2, 3.25'), ['pseudo:fli', 'register:r2', 'punct:,', 'number:3.25']);
  eq(types('  .naoexiste'), ['invalid:.naoexiste']);
  eq(types('  .asciz "sem fim'), ['directive:.asciz', 'invalid:"sem fim']);
  eq(types('  .ascii "esc \\q"'), ['directive:.ascii', 'invalid:"esc \\q"'], 'escape inválido');
  eq(types('  li r1, 12ab'), ['pseudo:li', 'register:r1', 'punct:,', 'invalid:12ab']);
  eq(types('  la r1, msg+4'), ['pseudo:la', 'register:r1', 'punct:,', 'label:msg', 'operator:+', 'number:4']);
});

test('tokenizer: registradores r0..r31 e não-registradores', () => {
  for (let i = 0; i < 32; i++) eq(types('  push r' + i)[1], 'register:r' + i);
  eq(types('  la r1, r32')[3], 'label:r32');
  eq(types('  la r1, r01')[3], 'label:r01');
  eq(types('  la r1, t11')[3], 'label:t11');
  eq(types('  la r1, s13')[3], 'register:s13');
});

test('statementKind', () => {
  eq(['  add r1, r2, r3', 'x: .word 1', 'N = 3', 'lbl:', '', '  ; só comentário', 'a: b: halt'].map(Lang.statementKind),
    ['insn', 'directive', 'equ', 'label', 'empty', 'empty', 'insn']);
});

/* ---- autocomplete ---- */

const SRC = '_start:\n  li r1, 1\nloop:\n  dec r1\n  bne lo\nLimite = 10\nmsg: .asciz "x"\nlocal.a:\n  halt\nloop2:\n';

test('labelCompletions (função pura)', () => {
  eq(Lang.labelCompletions(SRC, 'lo').map((l) => l.name), ['local.a', 'loop', 'loop2']);
  eq(Lang.labelCompletions(SRC, 'L').map((l) => l.name), ['Limite', 'local.a', 'loop', 'loop2'], 'maiúscula primeiro, depois sem diferenciar');
  eq(Lang.labelCompletions(SRC, '').length, 6);
  eq(Lang.labelCompletions(SRC, 'loop2', 10).map((l) => l.name), [], 'não sugere o próprio rótulo sendo digitado');
  eq(Lang.labelCompletions(SRC, 'Lim')[0], { name: 'Limite', line: 6, kind: 'equ' });
  eq(Lang.scanLabels('a: b: halt\n  ; c:\n  .asciz "d:"\n').map((l) => l.name), ['a', 'b'], 'comentário e string não definem rótulo');
});

test('completionContext e completionOptions', () => {
  eq(Lang.completionContext('  ad', 4), { kind: 'statement', from: 2, prefix: 'ad' });
  eq(Lang.completionContext('loop: ad', 8), { kind: 'statement', from: 6, prefix: 'ad' });
  eq(Lang.completionContext('  .as', 5), { kind: 'directive', from: 2, prefix: '.as' });
  const c = Lang.completionContext('  add r1, r', 11);
  eq([c.kind, c.op, c.index, c.prefix], ['operand', 'add', 1, 'r']);
  eq(Lang.completionContext('  ; ad', 6), { kind: 'none' });
  eq(Lang.completionContext('  .asciz "ab', 12), { kind: 'none' });
  const opts = Lang.completionOptions(Lang.completionContext('  ad', 4), []);
  const add = opts.find((o) => o.label === 'add');
  ok(add && add.snippet === 'add ${rd}, ${ra}, ${rb}' && /rd = ra \+ rb/.test(add.info), 'add com snippet e descrição');
  ok(opts.some((o) => o.label === 'addi') && !opts.some((o) => o.label === 'sub'), 'filtra por prefixo');
  const labels = Lang.labelCompletions(SRC, '');
  const br = Lang.completionOptions(Lang.completionContext('  bne lo', 8), labels);
  eq(br.map((o) => o.label), ['local.a', 'loop', 'loop2'], 'desvio sugere rótulos');
  const reg = Lang.completionOptions(Lang.completionContext('  mov r1, s', 11), labels).map((o) => o.label);
  ok(reg.includes('sp') && !reg.includes('s0'), 'registradores sem apelidos: ' + reg.join(','));
  const sys = Lang.completionOptions(Lang.completionContext('  syscall PU', 12), labels).map((o) => o.label);
  eq(sys, ['PUTC', 'PUTS']);
  const dirs = Lang.completionOptions(Lang.completionContext('  .al', 5), []).map((o) => o.label);
  eq(dirs, ['.align']);
  const la = Lang.completionOptions(Lang.completionContext('  la r1, m', 10), labels).map((o) => o.label);
  eq(la, ['msg'], 'la: rótulo');
});

test('wordAt e describe', () => {
  eq(Lang.wordAt('  addi r1, r2, 5', 4), { word: 'addi', from: 2, to: 6 });
  eq(Lang.wordAt('  addi r1, r2, 5', 6), { word: 'addi', from: 2, to: 6 }, 'fim da palavra');
  eq(Lang.wordAt('  bne b.x', 8).word, 'b.x');
  eq(Lang.wordAt('  .asciz', 4).word, '.asciz');
  eq(Lang.wordAt('   ', 1), null);
  const d = Lang.describe('ADDI', 'mnemonic');
  ok(d.kind === 'insn' && /0x31/.test(d.title) && d.signature === 'addi rd, ra, imm' && /Z N C V/.test(d.detail), JSON.stringify(d));
  eq(Lang.describe('li', 'pseudo').kind, 'pseudo');
  eq(Lang.describe('beq', 'mnemonic').kind, 'branch');
  eq(Lang.describe('.word', 'directive').kind, 'directive');
  eq([Lang.describe('sp', 'register').kind, Lang.describe('sp', 'register').index], ['register', 31]);
  eq(Lang.describe('PUTC', 'syscall').signature, '0x10');
  eq(Lang.describe('loop', 'label').kind, 'label');
  eq(Lang.describe('b', 'label').kind, 'label', '"b" usado como rótulo');
  eq(Lang.tokenAt('  b b', 4).type, 'label');
  eq(Lang.tokenAt('  b b', 2).type, 'pseudo');
});

console.log('test_asmtools: ' + total + ' casos, ' + failed + ' falhas');
process.exit(failed ? 1 : 0);
