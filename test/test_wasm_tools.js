#!/usr/bin/env node
/*
 * test_wasm_tools.js — ksas.wasm e ksdis.wasm pelo shim WASI (web/wasi.js)
 * contra o ksas/ksdis nativos (oráculo), em Node:
 *
 *   node test/test_wasm_tools.js --build build --native build/native --ksvm2 ../ksvm2
 *
 * - todos os .ksasm de ksvm2/examples (e v1_ported), de examples/ e de
 *   test/progs: .ksx byte a byte idêntico, com e sem -g, e o listing (-l)
 *   idêntico ao nativo;
 * - erros de montagem: mesma stderr e mesmo código de saída (1 erro de
 *   montagem, 2 uso/E-S), inclusive .include ausente e arquivo inexistente;
 *   o listing é apagado quando a montagem falha;
 * - ksdis.wasm: listagem e --raw idênticas ao nativo para cada .ksx, e o
 *   round-trip ksas -> ksdis --raw -> ksas (doc 07 §4) com o par wasm;
 * - o próprio shim: argv, stdin, fd_seek, arquivo criado/apagado, ENOENT,
 *   diretório, proc_exit e import desconhecido = ENOSYS.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { runWasi, WASI_ERRNO } = require('../web/wasi.js');

const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
const BUILD = args.build || 'build';
const NATIVE = args.native || path.join(BUILD, 'native');
const K = path.resolve(args.ksvm2 || '../ksvm2');
const KSAS_NATIVE = path.resolve(NATIVE, 'ksas');
const KSDIS_NATIVE = path.resolve(NATIVE, 'tools/ksdis');
const KSAS_WASM = fs.readFileSync(path.join(BUILD, 'ksas.wasm'));
const KSDIS_WASM = fs.readFileSync(path.join(BUILD, 'ksdis.wasm'));
const WORK = path.resolve(BUILD, 'test-tmp/wasm-tools');

let total = 0, failed = 0;
function test(name, fn) {
  total++;
  try { fn(); } catch (e) { failed++; console.log('FALHA [' + name + '] ' + (e && e.message ? e.message : e)); }
}
function eq(a, b, what) {
  if (a !== b) throw new Error((what || 'valor') + ': ' + JSON.stringify(a).slice(0, 400) + ' != esperado ' + JSON.stringify(b).slice(0, 400));
}
function ok(c, what) { if (!c) throw new Error(what || 'condição falsa'); }
function sameBytes(a, b, what) {
  ok(a && b, what + ': ausente (' + (a ? 'nativo' : 'wasm') + ')');
  ok(Buffer.from(a).equals(Buffer.from(b)), what + ': bytes diferentes (' + a.length + ' x ' + b.length + ')');
}

fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });

/* Todos os .ksasm sob dir (caminhos relativos), para servir de FS virtual. */
function tree(dir, rel, out) {
  out = out || new Map();
  for (const e of fs.readdirSync(path.join(dir, rel || ''), { withFileTypes: true })) {
    const r = rel ? rel + '/' + e.name : e.name;
    if (e.isDirectory()) tree(dir, r, out);
    else if (/\.(ksasm|inc|s)$/.test(e.name)) out.set(r, fs.readFileSync(path.join(dir, r)));
  }
  return out;
}

function native(bin, argv, cwd, input) {
  const r = spawnSync(bin, argv, { cwd, input: input || '', maxBuffer: 1 << 26 });
  return { code: r.status, stdout: r.stdout.toString('utf8'), stderr: r.stderr.toString('utf8') };
}

/* Monta src (relativo a dir) nos dois e compara. */
function compareAssemble(label, dir, src, extra) {
  extra = extra || [];
  const base = path.basename(src).replace(/\.ksasm$/, '');
  const ndir = path.join(WORK, 'n-' + label.replace(/[^\w.-]/g, '_'));
  fs.mkdirSync(ndir, { recursive: true });
  const ksx = path.join(ndir, base + '.ksx'), lst = path.join(ndir, base + '.lst');
  const n = native(KSAS_NATIVE, [src, '-o', ksx, '-l', lst].concat(extra), dir);
  const files = tree(dir);
  const w = runWasi(KSAS_WASM, { args: ['ksas', src, '-o', 'out/' + base + '.ksx', '-l', 'out/' + base + '.lst'].concat(extra), files: new Map([...files, ['out/.keep', '']]) });
  eq(w.exitCode, n.code, 'código de saída');
  eq(w.stderr, n.stderr, 'stderr');
  if (n.code === 0) {
    sameBytes(fs.readFileSync(ksx), w.files.get('out/' + base + '.ksx'), '.ksx');
    eq(Buffer.from(w.files.get('out/' + base + '.lst')).toString('utf8'), fs.readFileSync(lst, 'utf8'), 'listing');
  }
  return { native: n, wasm: w, ksx: n.code === 0 ? fs.readFileSync(ksx) : null };
}

/* ---- exemplos: ksas ------------------------------------------------------ */

const sources = [];
for (const f of fs.readdirSync(path.join(K, 'examples')).filter((x) => x.endsWith('.ksasm'))) sources.push([path.join(K, 'examples'), f]);
for (const f of fs.readdirSync(path.join(K, 'examples/v1_ported')).filter((x) => x.endsWith('.ksasm'))) sources.push([path.join(K, 'examples'), 'v1_ported/' + f]);
for (const f of fs.readdirSync('examples').filter((x) => x.endsWith('.ksasm'))) sources.push([path.resolve('examples'), f]);
for (const f of fs.readdirSync('test/progs').filter((x) => x.endsWith('.ksasm'))) sources.push([path.resolve('test/progs'), f]);

const images = [];
for (const [dir, src] of sources) {
  for (const g of [[], ['-g']]) {
    const label = src + (g.length ? ' -g' : '');
    test('ksas ' + label, () => {
      const r = compareAssemble(label, dir, src, g);
      eq(r.native.code, 0, 'nativo montou');
      images.push({ name: label, ksx: r.ksx, g: g.length > 0 });
    });
  }
}

test('ksas -D e -h', () => {
  const dir = path.join(WORK, 'defs');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'd.ksasm'), '_start: li r1, N\n  li r2, M\n  halt\n');
  compareAssemble('defs', dir, 'd.ksasm', ['-DN=0x1234', '-DM']);
  const n = native(KSAS_NATIVE, ['-h'], dir);
  const w = runWasi(KSAS_WASM, { args: ['ksas', '-h'] });
  eq(w.exitCode, n.code, 'código -h');
  eq(w.stdout, n.stdout, 'uso');
});

/* ---- erros de montagem ----------------------------------------------------- */

const BAD = {
  'mnemonico': 'foo r1\n',
  'operandos': '_start:\n  addi r1, r2\n  add r1\n',
  'registrador': '  mov r1, r40\n',
  'rotulo-duplicado': 'a:\na:\n  halt\n',
  'rotulo-indefinido': '  b nada\n  call outro\n',
  'imediato-grande': '  addi r1, r1, 100000\n  shli r1, r1, 40\n',
  'string': '  .data\ns: .asciz "abc\n',
  'secao': '  .data\n  add r1, r2, r3\n',
  'float': '  .data\n  .float 1e39, 1.5x\n',
  'include-ausente': '  .include "nao/existe.ksasm"\n',
  'utf8-coluna': '; ção\n  movi r1, ção\n',
  'diretiva': '  .naoexiste 3\n',
  'muitos': Array.from({ length: 120 }, (_, i) => 'x' + i + ' r1\n').join('')
};

for (const [name, text] of Object.entries(BAD)) {
  test('erro ' + name, () => {
    const dir = path.join(WORK, 'bad-' + name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name + '.ksasm'), text);
    const r = compareAssemble('bad-' + name, dir, name + '.ksasm');
    eq(r.native.code, 1, 'nativo recusou');
    ok(/:\d+(:\d+)?: erro: /.test(r.wasm.stderr), 'formato arquivo:linha:coluna: erro:');
    ok(!r.wasm.files.has('out/' + name + '.lst'), 'listing apagado na falha');
  });
}

/* .float/fli passam o texto ao strtof da libc. O da wasi-libc (musl) ignora
 * o sinal de "-nan"; o ksas especifica NaN canônico com o sinal do literal
 * (ksvm2/tests/ksas/test_ksas_float.c: -nan = 0xFFC00000). Oráculo duplo:
 * o nativo e os bits esperados. Mais um lote de literais variados. */
test('float: sinal de -nan e literais variados = nativo', () => {
  const dir = path.join(WORK, 'floats');
  fs.mkdirSync(dir, { recursive: true });
  const lits = ['nan', '-nan', '+nan', '-NaN', 'NAN', '-nan(123)', 'nan(0x1)', '-inf', '+inf', '-infinity', 'INFINITY',
    '-0.0', '0x1.fffffep127', '0x1p-149', '0x1p-150', '0x1.8p-149', '1.17549435e-38', '1.1754942e-38', '3.4028234e38',
    '3.40282356e38', '1e-46', '7e-46', '0.1', '-.5', '+1.5', '16777217', '0X1P+4', '1.000000059604644775390625',
    '1.00000005960464477539062501', '2.5e-45', '4.9e-324', '123456789012345678901234567890'];
  let seed = 12345;
  const rnd = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296;
  for (let i = 0; i < 200; i++) {
    const m = (rnd() * 10).toFixed(1 + (i % 12)), e = Math.floor(rnd() * 80) - 44;
    lits.push((rnd() < 0.3 ? '-' : '') + m + 'e' + e);
  }
  const text = '_start:\n  fli r1, -nan\n  fli r2, nan\n  halt\n  .data\n' + lits.map((l) => '  .float ' + l + '\n').join('');
  fs.writeFileSync(path.join(dir, 'f.ksasm'), text);
  const r = compareAssemble('floats', dir, 'f.ksasm');
  eq(r.native.code, 0, 'nativo montou: ' + r.native.stderr);
  const im = r.wasm.files.get('out/f.ksx');
  const lst = Buffer.from(r.wasm.files.get('out/f.lst')).toString('utf8');
  ok(/^00000000  [0-9A-F]{2} 01 00 00 00 00 C0 FF /m.test(lst), 'fli r1, -nan = 0xFFC00000');
  ok(/^00000008  [0-9A-F]{2} 02 00 00 00 00 C0 7F /m.test(lst), 'fli r2, nan = 0x7FC00000');
  ok(/  00 00 C0 FF\s+\d+\s+\.float -nan\n/.test(lst), '.float -nan = 0xFFC00000');
  ok(/  00 00 C0 7F\s+\d+\s+\.float \+nan\n/.test(lst), '.float +nan = 0x7FC00000');
  ok(im && im.length > 0, 'imagem');
});

test('erro arquivo inexistente e opção inválida', () => {
  for (const argv of [['nada.ksasm'], ['-x', 'a.ksasm'], [], ['a.ksasm', 'b.ksasm']]) {
    const n = native(KSAS_NATIVE, argv, WORK);
    const w = runWasi(KSAS_WASM, { args: ['ksas'].concat(argv) });
    eq(w.exitCode, n.code, 'código ' + argv.join(' '));
    eq(w.stderr, n.stderr, 'stderr ' + argv.join(' '));
  }
});

/* ---- ksdis ----------------------------------------------------------------- */


test('ksdis listagem e --raw = nativo; round-trip', () => {
  ok(images.length >= sources.length * 2 - 2, 'imagens montadas: ' + images.length);
  for (const im of images) {
    const f = path.join(WORK, 'dis.ksx');
    fs.writeFileSync(f, im.ksx);
    for (const extra of [[], ['--raw']]) {
      const n = native(KSDIS_NATIVE, ['dis.ksx'].concat(extra), WORK);
      const w = runWasi(KSDIS_WASM, { args: ['ksdis', 'dis.ksx'].concat(extra), files: { 'dis.ksx': im.ksx } });
      eq(w.exitCode, n.code, im.name + ' código ' + extra);
      eq(w.stdout, n.stdout, im.name + ' saída ' + extra);
      eq(w.stderr, n.stderr, im.name + ' stderr ' + extra);
      if (extra.length) {
        /* ksdis --raw x -> ksas = y; x == y (com -g se o texto pede) */
        const g = /remonte com ksas -g/.test(w.stdout) ? ['-g'] : [];
        const a = runWasi(KSAS_WASM, { args: ['ksas', 'rt.s', '-o', 'rt.ksx'].concat(g), files: { 'rt.s': w.stdout } });
        eq(a.exitCode, 0, im.name + ' remonta: ' + a.stderr);
        sameBytes(im.ksx, a.files.get('rt.ksx'), im.name + ' round-trip');
      }
    }
  }
});

test('ksdis erros', () => {
  fs.writeFileSync(path.join(WORK, 'lixo.ksx'), 'nao e imagem');
  for (const argv of [['lixo.ksx'], ['nada.ksx'], []]) {
    const n = native(KSDIS_NATIVE, argv, WORK);
    const w = runWasi(KSDIS_WASM, { args: ['ksdis'].concat(argv), files: { 'lixo.ksx': 'nao e imagem' } });
    eq(w.exitCode, n.code, 'código ' + argv.join(' '));
    eq(w.stderr, n.stderr, 'stderr ' + argv.join(' '));
  }
});

/* ---- o shim ---------------------------------------------------------------- */

/* Módulo WASI escrito à mão (wasm binário mínimo) seria trabalhoso; o ksas e
 * o ksdis já exercitam args, path_open, fd_read/write/close, unlink. Aqui os
 * casos de borda do FS pelo ksdis -o (cria arquivo) e pelo ksas. */
test('shim: -o cria arquivo, caminhos com ./ e ../, diretório como entrada', () => {
  const im = images[0].ksx;
  const w = runWasi(KSDIS_WASM, { args: ['ksdis', './a/../dis.ksx', '-o', 'sub/out.txt'], files: { 'dis.ksx': im, 'sub/x': '' } });
  eq(w.exitCode, 0, 'ksdis -o');
  ok(w.files.has('sub/out.txt') && w.files.get('sub/out.txt').length > 100, 'arquivo criado');
  const w2 = runWasi(KSDIS_WASM, { args: ['ksdis', 'sub'], files: { 'sub/x': '' } });
  eq(w2.exitCode, 1, 'diretório como entrada falha');
  const w3 = runWasi(KSDIS_WASM, { args: ['ksdis', '../fora.ksx'], files: {} });
  eq(w3.exitCode, 1, 'fora da raiz');
  const w4 = runWasi(KSDIS_WASM, { args: ['ksdis', 'dis.ksx', '-o', 'naodir/out.txt'], files: { 'dis.ksx': im } });
  eq(w4.exitCode, 1, 'diretório inexistente');
  ok(!w4.files.has('naodir/out.txt'), 'nada criado');
});

/* test/wasi_probe.c compilado com a wasi-libc (pelo shim) e com a libc do
 * host (num diretório de verdade): mesma saída e mesmos arquivos. Cobre
 * truncar e escrever além do fim (o buraco é zero), ftruncate, lseek
 * 0/1/2 e negativo, writev/readv com vários iovecs, EOF, append, O_EXCL,
 * diretórios, caminhos com ./ e .., unlink/rmdir, close de fd inválido,
 * argv UTF-8 com espaços, stdin, stderr e o código de saída. */
test('shim: sonda C (wasi-libc pelo shim) = libc do host', () => {
  const probeWasm = path.join(BUILD, 'wasi_probe.wasm'), probeNative = path.resolve(NATIVE, 'wasi_probe');
  ok(fs.existsSync(probeWasm) && fs.existsSync(probeNative), 'sondas construídas (make test)');
  const init = { 'old.txt': 'X'.repeat(64), 'in.txt': 'abcdefghij' };
  const dir = path.join(WORK, 'probe');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  for (const [k, v] of Object.entries(init)) fs.writeFileSync(path.join(dir, k), v);
  const argv = ['é um', 'a b', ''];
  const n = spawnSync(probeNative, argv, { cwd: dir, input: 'entrada', argv0: 'probe' });
  const w = runWasi(fs.readFileSync(probeWasm), { args: ['probe'].concat(argv), files: init, stdin: 'entrada' });
  eq(w.exitCode, n.status, 'código de saída');
  eq(w.stdout, n.stdout.toString('utf8'), 'saída');
  eq(w.stderr, n.stderr.toString('utf8'), 'stderr');
  const left = fs.readdirSync(dir).sort();
  eq(JSON.stringify([...w.files.keys()].sort()), JSON.stringify(left), 'arquivos que sobraram');
  for (const f of left) sameBytes(fs.readFileSync(path.join(dir, f)), w.files.get(f), f);
  ok(/trunc\+seek: 61 62 00 00 00 00 00 00 00 00 7a/.test(w.stdout), 'buraco com zeros');
});

test('shim: ksas lê o mesmo arquivo de entrada com Map e com objeto', () => {
  const src = '_start: li r1, 7\n  halt\n';
  const a = runWasi(KSAS_WASM, { args: ['ksas', 'x.ksasm'], files: { 'x.ksasm': src } });
  const b = runWasi(KSAS_WASM, { args: ['ksas', '/x.ksasm', '-o', '/x.ksx'], files: new Map([['/x.ksasm', new TextEncoder().encode(src)]]) });
  eq(a.exitCode, 0); eq(b.exitCode, 0);
  sameBytes(a.files.get('x.ksx'), b.files.get('x.ksx'), 'mesma imagem');
  eq(WASI_ERRNO.NOSYS, 52, 'ENOSYS');
});

test('shim: import desconhecido vira ENOSYS e proc_exit dá o código', () => {
  /* módulo: importa wasi_snapshot_preview1.fd_advise (não implementado) e
   * proc_exit; _start chama proc_exit(fd_advise(0,0,0,0) ) -> 52 */
  const bytes = new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    /* tipos: (i32 i64 i64 i32)->i32, (i32)->(), ()->() */
    0x01, 0x10, 0x03, 0x60, 0x04, 0x7f, 0x7e, 0x7e, 0x7f, 0x01, 0x7f, 0x60, 0x01, 0x7f, 0x00, 0x60, 0x00, 0x00,
    /* imports */
    0x02, 0x47, 0x02,
    0x16, ...Buffer.from('wasi_snapshot_preview1'), 0x09, ...Buffer.from('fd_advise'), 0x00, 0x00,
    0x16, ...Buffer.from('wasi_snapshot_preview1'), 0x09, ...Buffer.from('proc_exit'), 0x00, 0x01,
    /* funções */ 0x03, 0x02, 0x01, 0x02,
    /* memória */ 0x05, 0x03, 0x01, 0x00, 0x01,
    /* exports: memory, _start */
    0x07, 0x13, 0x02, 0x06, ...Buffer.from('memory'), 0x02, 0x00, 0x06, ...Buffer.from('_start'), 0x00, 0x02,
    /* código */
    0x0a, 0x10, 0x01, 0x0e, 0x00, 0x41, 0x00, 0x42, 0x00, 0x42, 0x00, 0x41, 0x00, 0x10, 0x00, 0x10, 0x01, 0x0b
  ]);
  const r = runWasi(bytes, { args: ['t'] });
  eq(r.exitCode, 52, 'código = ENOSYS');
});

console.log('test_wasm_tools: ' + total + ' casos, ' + failed + ' falhas');
process.exit(failed ? 1 : 0);
