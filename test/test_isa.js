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
 *   ksas.wasm (as formas de operando batem com o assembler);
 * - as fichas de tools/isa-doc.md: todo opcode com summary, detail,
 *   syntax, example, grupo e codificação; cada exemplo (instruções,
 *   desvios, pseudos, formas abreviadas, diretivas) monta num .text mínimo
 *   e gera o opcode da ficha; condições, registradores, flags, formatos,
 *   faults (fault.h), syscalls e erros (syscall.h), mapa de opcodes.
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

/* ---- fichas (tools/isa-doc.md, mescladas pelo mkisa.js) ---- */

/* O ".text mínimo" dos exemplos: _start antes, fim depois (alinhado, em .text). */
const EX_LIB = { 'lib.ksasm': 'LIB_OK = 1\n' };
function assembleExample(line) {
  const src = '        .text\n_start:\n' + line + '\n        .text\n        .align 4\nfim:    halt\n';
  const r = runWasi(KSAS, { args: ['ksas', 'a.ksasm', '-o', 'a.ksx'], files: Object.assign({ 'a.ksasm': src }, EX_LIB) });
  return { ok: r.exitCode === 0, err: r.stderr, ksx: r.files.get('a.ksx') };
}
const nonEmpty = (s) => typeof s === 'string' && s.trim().length > 0;

test('fichas: todo opcode do isa.def com summary, detail, syntax, example, group e encoding', () => {
  const groups = new Set(ISA.groups.map((g) => g.key));
  const bad = [];
  for (const o of ops) {
    const e = ISA.instructions.find((i) => i.mnemonic === o.name.toLowerCase());
    const m = o.name.toLowerCase();
    if (!nonEmpty(e.summary) || !/[.!]$/.test(e.summary)) bad.push(m + ': summary');
    if (!Array.isArray(e.detail) || e.detail.length < 2 || e.detail.length > 5 || !e.detail.every(nonEmpty)) bad.push(m + ': detail (2 a 5 linhas)');
    if (!nonEmpty(e.syntax) || !e.syntaxAll.includes(e.syntax)) bad.push(m + ': syntax');
    if (m !== 'bcond' && !e.syntaxAll.every((s) => s.split(' ')[0] === m)) bad.push(m + ': syntax com outro mnemônico');
    if (!nonEmpty(e.example) || !/;\s*\S/.test(e.example)) bad.push(m + ': example com comentário');
    if (!groups.has(e.group)) bad.push(m + ': group');
    const enc = e.encoding;
    if (!enc || enc.opcode !== '0x' + o.code.toString(16).toUpperCase().padStart(2, '0') || enc.format !== o.fmt) { bad.push(m + ': encoding'); continue; }
    /* campos da primeira palavra cobrem 31..0 sem buraco nem sobreposição */
    let next = 31;
    for (const f of enc.fields.filter((x) => !x.word)) { if (f.hi !== next || f.lo > f.hi) bad.push(m + ': campo ' + f.name); next = f.lo - 1; }
    if (next !== -1) bad.push(m + ': campos não cobrem 32 bits');
    if ((o.fmt === 'L') !== enc.fields.some((x) => x.word === 1 && x.name === 'imm32')) bad.push(m + ': imm32 do formato L');
    if (enc.fields.find((x) => x.name === 'opcode').value !== enc.opcode) bad.push(m + ': campo opcode');
    eq(e.flagsList.join(''), o.flags === 'NONE' ? '' : o.flags, m + ' flagsList');
  }
  eq(bad, [], 'fichas incompletas');
});

test('fichas: o exemplo de cada instrução monta no ksas.wasm e gera o opcode da ficha', () => {
  const bad = [];
  for (const e of ISA.instructions) {
    const r = assembleExample('        ' + e.example);
    if (!r.ok) { bad.push(e.mnemonic + ': ' + e.example + ' -> ' + r.err.split('\n')[0]); continue; }
    const op = firstWord(r.ksx) & 0xFF;
    if (op !== e.opcode) bad.push(e.mnemonic + ': exemplo gera o opcode 0x' + op.toString(16));
  }
  eq(bad, [], 'exemplos de instruções');
});

test('fichas: exemplos de desvios, pseudo-instruções, formas abreviadas e diretivas montam', () => {
  const bad = [];
  const all = ISA.branches.map((b) => [b.mnemonic, b.example])
    .concat(ISA.pseudos.map((p) => [p.mnemonic, p.example]))
    .concat(ISA.shortForms.map((s) => [s.key, s.example]))
    .concat(ISA.directives.map((d) => [d.name, d.example]));
  for (const [name, ex] of all) {
    if (!nonEmpty(ex) || !/;\s*\S/.test(ex)) { bad.push(name + ': sem exemplo comentado'); continue; }
    const r = assembleExample('        ' + ex);
    if (!r.ok) bad.push(name + ': ' + ex + ' -> ' + r.err.split('\n')[0]);
  }
  for (const b of ISA.branches) {
    const r = assembleExample('        ' + b.example);
    if (r.ok && ((firstWord(r.ksx) >> 8) & 15) !== b.code) bad.push(b.mnemonic + ': condição do exemplo');
  }
  for (const x of ISA.pseudos.concat(ISA.directives)) {
    if (!nonEmpty(x.summary) || !nonEmpty(x.syntax)) bad.push((x.mnemonic || x.name) + ': summary/syntax');
  }
  for (const p of ISA.pseudos) if (!nonEmpty(p.expands)) bad.push(p.mnemonic + ': expande');
  eq(bad, [], 'exemplos e fichas');
});

test('fichas: as 16 condições com flags testadas e significado inteiro/float; CS e CC apelidos', () => {
  const base = ISA.conds.filter((c) => !c.aliasOf);
  eq(base.map((c) => c.code), [...Array(16).keys()], 'códigos 0..15');
  for (const c of base) ok(nonEmpty(c.tests) && nonEmpty(c.int) && nonEmpty(c.float) && nonEmpty(c.summary), c.name);
  eq(ISA.conds.filter((c) => c.aliasOf).map((c) => c.name + '=' + c.aliasOf), ['CS=HS', 'CC=LO'], 'apelidos');
  eq(ISA.conds.find((c) => c.name === 'GE').tests, 'N=V', 'GE testa N=V (doc 04 §4)');
  for (const b of ISA.branches) ok(nonEmpty(b.summary) && b.detail.length >= 2 && b.encoding.format === 'B', b.mnemonic);
});

test('fichas: registradores, especiais, flags e formatos', () => {
  const docs = new Map(ISA.regDocs.map((d) => [d.key, d]));
  for (const r of ISA.registers) {
    const d = docs.get(r.doc);
    ok(d && r.index >= d.from && r.index <= d.to, r.name + ' -> ficha ' + r.doc);
    ok(nonEmpty(d.summary) && nonEmpty(d.abi) && nonEmpty(d.preserve), r.doc);
  }
  eq(ISA.registers.find((r) => r.name === 't0').doc, 'r5-r15', 't0 = r5');
  for (const s of ISA.specialRegs) ok(nonEmpty(s.summary) && nonEmpty(s.access), s.name);
  eq(ISA.flagBits.map((f) => f.name + f.bit), ['Z0', 'N1', 'C2', 'V3'], 'flags');
  const setBy = (f) => ISA.flagBits.find((x) => x.name === f).setBy;
  ok(setBy('V').includes('add') && setBy('V').includes('fcmp') && !setBy('V').includes('shl'), 'V: add e fcmp, não shl');
  ok(setBy('C').includes('shl') && !setBy('C').includes('and'), 'C: shl, não and');
  for (const f of ISA.formats) {
    ok(nonEmpty(f.summary) && nonEmpty(f.range), f.name);
    eq(f.fields.filter((x) => !x.word).reduce((n, x) => n + x.hi - x.lo + 1, 0), 32, f.name + ' com 32 bits');
    eq(f.count, ISA.instructions.filter((i) => i.format === f.name).length, f.name + ' contagem');
  }
});

test('fichas: faults conferem com fault.h, syscalls e erros com syscall.h', () => {
  const fh = fs.readFileSync(path.join(K, 'include/ksvm/fault.h'), 'utf8');
  const names = [...fh.matchAll(/^\s*KSVM_FAULT_(\w+)\s*[,=]/gm)].map((m) => m[1]).filter((n) => n !== 'COUNT');
  eq(ISA.faults.map((f) => f.name), names.filter((n) => n !== 'NONE'), 'faults na ordem do enum');
  for (const f of ISA.faults) { eq(f.code, names.indexOf(f.name), f.name + ' código'); eq(f.exit, 70 + f.code, f.name + ' saída'); ok(nonEmpty(f.summary) && nonEmpty(f.addr), f.name); }
  for (const s of ISA.syscalls) ok(nonEmpty(s.args) && nonEmpty(s.ret) && nonEmpty(s.summary) && s.group === s.num >> 4, s.name);
  const sh = fs.readFileSync(path.join(K, 'include/ksvm/syscall.h'), 'utf8');
  eq(ISA.syscallErrors.map((e) => e.name + '=' + e.code), [...sh.matchAll(/KSVM_ERR_(\w+)\s*=\s*(\d+)/g)].map((m) => m[1] + '=' + m[2]), 'erros');
  for (const e of ISA.syscallErrors) ok(nonEmpty(e.summary), e.name);
});

test('fichas: faixas do mapa de opcodes (doc 04 §5.8) sem instrução dentro', () => {
  const st = (op) => (ISA.opRanges.find((r) => op >= r.from && op <= r.to) || {}).state;
  eq([st(0x04), st(0x80), st(0x9F), st(0xB2), st(0xC0), st(0xEF), st(0xFF)], ['removido', 'reservado', 'reservado', 'reservado', 'plataforma', 'plataforma', 'inválido']);
  for (const r of ISA.opRanges) for (const i of ISA.instructions) ok(i.opcode < r.from || i.opcode > r.to, i.mnemonic + ' em faixa ' + r.state);
  const doc = fs.readFileSync(path.join(__dirname, '../tools/isa-doc.md'), 'utf8');
  ok(/Fonte normativa: o doc 04 da ksvm2/.test(doc) && /corrija primeiro o doc 04/.test(doc), 'cabeçalho do isa-doc.md aponta o doc 04 como fonte normativa');
});

console.log('test_isa: ' + total + ' casos, ' + failed + ' falhas');
process.exit(failed ? 1 : 0);
