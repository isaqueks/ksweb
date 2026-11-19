#!/usr/bin/env node
/*
 * test_isa.js — build/web/isa.json (gerado por tools/isadump + tools/mkisa.js)
 * contra as fontes da ksvm2, lidas aqui de forma independente:
 *
 *   node test/test_isa.js --isa build/web/isa.json --ksas build/ksas.wasm --ksvm2 ../ksvm2
 *
 * - todo KSVM_OP do isa.def está no JSON com o mesmo opcode, formato, flags
 *   e descrição, e nada além deles;
 * - todas as diretivas e pseudo-instruções das tabelas do ksas (parser.c e
 *   insn.c) e todas as condições estão no JSON, e vice-versa;
 * - os nomes de syscall do JSON são aceitos pelo ksas.wasm ("syscall NOME")
 *   e geram o número certo; registradores e apelidos idem;
 * - o snippet de cada instrução, com operandos de exemplo, monta no
 *   ksas.wasm (as formas de operando batem com o assembler).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { runWasi } = require('../web/wasi.js');

const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
const K = path.resolve(args.ksvm2 || '../ksvm2');
const ISA = JSON.parse(fs.readFileSync(args.isa || 'build/web/isa.json', 'utf8'));
const KSAS = fs.readFileSync(args.ksas || 'build/ksas.wasm');

let total = 0, failed = 0;
function test(name, fn) {
  total++;
  try { fn(); } catch (e) { failed++; console.log('FALHA [' + name + '] ' + (e && e.message ? e.message : e)); }
}
function eq(a, b, what) {
  const sa = JSON.stringify(a), sb = JSON.stringify(b);
  if (sa !== sb) throw new Error((what || 'valor') + ': ' + sa + ' != esperado ' + sb);
}
function ok(c, what) { if (!c) throw new Error(what || 'condição falsa'); }

function assemble(src) {
  const r = runWasi(KSAS, { args: ['ksas', 'a.ksasm', '-o', 'a.ksx'], files: { 'a.ksasm': src } });
  return { ok: r.exitCode === 0, err: r.stderr, ksx: r.files.get('a.ksx') };
}
/* Primeira palavra do código de uma imagem montada (doc 05: code_off em 0x0C). */
function firstWord(ksx) {
  const dv = new DataView(ksx.buffer, ksx.byteOffset, ksx.byteLength);
  return dv.getUint32(dv.getUint32(0x0C, true), true);
}

const isaDef = fs.readFileSync(path.join(K, 'include/ksvm/isa.def'), 'utf8');
const ops = [...isaDef.matchAll(/^KSVM_OP\((\w+),\s*(0x[0-9A-F]+),\s*(\w),\s*(\w+),\s*"([^"]*)"\)/gm)]
  .map((m) => ({ name: m[1], code: parseInt(m[2], 16), fmt: m[3], flags: m[4], desc: m[5] }));

test('isa.def inteiro no JSON', () => {
  ok(ops.length >= 100, 'opcodes lidos do isa.def: ' + ops.length);
  const byName = new Map(ISA.instructions.map((i) => [i.mnemonic, i]));
  for (const o of ops) {
    const e = byName.get(o.name.toLowerCase());
    ok(e, 'falta ' + o.name);
    eq([e.opcode, e.format, e.flags, e.desc], [o.code, o.fmt, o.flags, o.desc], o.name);
    eq(e.len, o.fmt === 'L' ? 8 : 4, o.name + ' len');
  }
  eq(ISA.instructions.length, ops.length, 'nada além do isa.def');
});

test('diretivas do parser.c', () => {
  const src = fs.readFileSync(path.join(K, 'src/tools/ksas/parser.c'), 'utf8');
  const table = /directives\[\][^{]*\{([\s\S]*?)\n\};/.exec(src);
  ok(table, 'tabela de diretivas no parser.c');
  const names = [...table[1].matchAll(/\{\s*"(\w+)",/g)].map((m) => '.' + m[1]).sort();
  ok(names.length >= 18, 'diretivas: ' + names.length);
  eq(ISA.directives.map((d) => d.name).sort(), names, 'conjunto de diretivas');
});

test('pseudo-instruções do insn.c', () => {
  const src = fs.readFileSync(path.join(K, 'src/tools/ksas/insn.c'), 'utf8');
  const table = /\} pseudos\[\] = \{([\s\S]*?)\n\};/.exec(src);
  ok(table, 'tabela pseudos no insn.c');
  const names = [...table[1].matchAll(/\{\s*"(\w+)",/g)].map((m) => m[1]).sort();
  eq(ISA.pseudos.map((p) => p.mnemonic).sort(), names, 'conjunto de pseudos');
});

test('condições de desvio montam com o código certo', () => {
  const conds = ['AL', 'EQ', 'NE', 'HS', 'LO', 'MI', 'PL', 'VS', 'VC', 'HI', 'LS', 'GE', 'LT', 'GT', 'LE', 'NV'];
  eq(ISA.conds.map((c) => c.name), conds.concat(['CS', 'CC']), 'lista');
  for (const b of ISA.branches) {
    const r = assemble('x: ' + b.mnemonic + ' x\n');
    ok(r.ok, b.mnemonic + ': ' + r.err);
    const cond = (firstWord(r.ksx) >> 8) & 15;
    const want = b.cond === 'CS' ? 3 : b.cond === 'CC' ? 4 : conds.indexOf(b.cond);
    eq(cond, want, b.mnemonic);
  }
});

test('syscalls por nome', () => {
  ok(ISA.syscalls.length >= 20, 'syscalls: ' + ISA.syscalls.length);
  for (const s of ISA.syscalls) {
    const r = assemble('  syscall ' + s.name + '\n');
    ok(r.ok, s.name + ': ' + r.err);
    eq(firstWord(r.ksx) >>> 18, s.num, s.name);
    ok(s.desc, s.name + ' sem descrição');
  }
});

test('registradores e apelidos', () => {
  for (const reg of ISA.registers) {
    const r = assemble('  mov ' + reg.name + ', zr\n');
    ok(r.ok, reg.name + ': ' + r.err);
    eq((firstWord(r.ksx) >> 8) & 31, reg.index, reg.name);
  }
  ok(!assemble('  mov a4, zr\n').ok, 'a4 não é registrador');
});

test('registradores especiais', () => {
  for (const s of ISA.specialRegs) {
    const r = assemble('  mfsr r1, ' + s.name + '\n');
    ok(r.ok, s.name + ': ' + r.err);
    eq(firstWord(r.ksx) >>> 18, s.num, s.name);
  }
});

/* Operandos de exemplo para cada marcador do snippet. */
const SAMPLE = { rd: 'r1', ra: 'r2', rb: 'r3', rc: 'r4', imm: '4', n: '3', 'rótulo': 'alvo', sr: 'FLAGS', 'número': '0x10', 'máscara': '1', valor: '1000', float: '1.5' };

test('snippets das instruções montam', () => {
  const bad = [];
  for (const i of ISA.instructions.concat(ISA.pseudos)) {
    if (!i.snippet) continue;
    const text = i.snippet.replace(/\$\{([^}]*)\}/g, (m, k) => SAMPLE[k] || 'r1');
    const r = assemble('alvo:\n  ' + text + '\n');
    if (!r.ok) bad.push(text + ' -> ' + r.err.split('\n')[0]);
  }
  eq(bad, [], 'snippets recusados');
});

test('diretivas: snippets e descrições', () => {
  for (const d of ISA.directives) {
    ok(d.desc && d.snippet.startsWith(d.name), d.name);
  }
  for (const i of ISA.instructions) ok(i.signature.startsWith(i.mnemonic) && i.flagsText, i.mnemonic);
});

console.log('test_isa: ' + total + ' casos, ' + failed + ' falhas');
process.exit(failed ? 1 : 0);
