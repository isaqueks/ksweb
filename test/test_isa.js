#!/usr/bin/env node
/*
 * test_isa.js — build/web/isa.json (gerado por tools/isadump + tools/mkisa.js)
 * contra as fontes da ksvm2, lidas aqui de forma independente:
 *
 *   node test/test_isa.js --isa build/web/isa.json --ksas build/ksas.wasm \
 *        --wasm build/ksvm.wasm --ksvm2 ../ksvm2
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
 *   faults (fault.h), syscalls e erros (syscall.h), mapa de opcodes;
 * - o que as fichas afirmam sobre flags, casos especiais (C em shift por
 *   0, INT_MIN / -1, PUSH sp, FCMP, saturação, NaN, CAPS...) e exemplos,
 *   executado no ksvm.wasm; e o texto das fichas coerente com as flags
 *   declaradas no isa.def.
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

/* ---- afirmações das fichas, executadas na VM (build/ksvm.wasm) ----------
 * O que as fichas dizem sobre flags, casos especiais e exemplos, conferido
 * contra o núcleo de verdade: cada caso monta um trecho no ksas.wasm, roda
 * até o HALT (ou o fault esperado) e compara registradores e FLAGS. */

const { KsCore, STATE } = require('../web/vmcore.js');
const VM_WASM = fs.readFileSync(args.wasm || 'build/ksvm.wasm');
const FZ = 1, FN = 2, FC = 4, FV = 8;

function runAsm(body) {
  const src = '        .text\n_start:\n' + body + '\n        halt\n        .data\n        .align 4\nbuf:    .space 64\n';
  const r = assemble(src);
  if (!r.ok) throw new Error('não montou: ' + r.err.split('\n')[0] + ' :: ' + body.replace(/\n/g, ' | '));
  let t = 0;
  const core = KsCore.createSync(VM_WASM, { clock: () => (t += 0.001) });
  core.init(1 << 16, 0);
  const err = core.load(r.ksx);
  if (err !== 0) throw new Error('imagem recusada: ' + err);
  const st = core.run(100000);
  const cpu = core.cpu();
  return { st, r: cpu.r.map((v) => v >>> 0), flags: cpu.flags & 0xF, fault: st === STATE.FAULT ? core.faultInfo() : null };
}
const u = (v) => v >>> 0;
const F32 = (x) => { const b = new DataView(new ArrayBuffer(4)); b.setFloat32(0, x, true); return b.getUint32(0, true); };

/* [ficha, trecho, {rN: valor, flags: v, fault: 'NOME', addr: v, eq: [[a, b]...]}] */
const CLAIMS = [
  ['mfsr', '        nop\naqui:   mfsr r1, PC\n        la r2, aqui', { eq: [[1, 2]] }],
  ['mtsr', '        li r2, 0xFF\n        mtsr FLAGS, r2\n        mfsr r1, FLAGS', { r1: 0xF }],
  ['movi', '        movi r1, -5', { r1: 0xFFFFFFFB }],
  ['adr', '        adr r1, alvo\nalvo:   mfsr r2, PC', { eq: [[1, 2]] }],
  ['adrl', '        adrl r1, alvo\nalvo:   mfsr r2, PC', { eq: [[1, 2]] }],
  ['zr', '        li r2, 5\n        sub zr, r2, r2\n        mfsr r9, FLAGS\n        mov r1, zr', { r1: 0, r9: FZ | FC }],
  ['sub', '        li r2, 5\n        li r3, 3\n        sub r1, r2, r3\n        mfsr r9, FLAGS\n        sub r4, r3, r2\n        mfsr r10, FLAGS', { r1: 2, r9: FC, r4: u(-2), r10: FN }],
  ['neg', '        li r2, 0x80000000\n        neg r1, r2\n        mfsr r9, FLAGS\n        neg r4, zr\n        mfsr r10, FLAGS', { r1: 0x80000000, r9: FN | FV, r4: 0, r10: FZ | FC }],
  ['add', '        li r2, 0x7FFFFFFF\n        addi r1, r2, 1\n        mfsr r9, FLAGS\n        li r3, -1\n        add r4, r3, r3\n        mfsr r10, FLAGS', { r1: 0x80000000, r9: FN | FV, r4: u(-2), r10: FN | FC }],
  ['subi-grande', '        li r2, 5\n        subi r1, r2, 10000\n        mfsr r9, FLAGS\n        li r3, 20000\n        subi r4, r3, 10000\n        mfsr r10, FLAGS\n        subi r5, zr, 0x80000000\n        mfsr r11, FLAGS',
    { r1: u(-9995), r9: FN, r4: 10000, r10: FC, r5: 0x80000000, r11: FN }],
  ['mul', '        li r9, 0xC\n        mtsr FLAGS, r9\n        li r2, 3\n        li r3, 4\n        mul r1, r2, r3\n        mfsr r9, FLAGS', { r1: 12, r9: FC | FV }],
  ['tsti', '        li r9, 0xC\n        mtsr FLAGS, r9\n        li r2, 1\n        tsti r2, 2\n        mfsr r9, FLAGS', { r9: FZ | FC | FV }],
  ['div', '        li r2, 0x80000000\n        li r3, -1\n        div r1, r2, r3\n        rem r4, r2, r3\n        li r5, -7\n        li r6, 2\n        div r7, r5, r6\n        rem r8, r5, r6\n        li r5, 7\n        li r6, -2\n        rem r10, r5, r6',
    { r1: 0x80000000, r4: 0, r7: u(-3), r8: u(-1), r10: 1 }],
  ['div (zero)', '        li r1, 9\n        li r2, 3\n        div r1, r2, zr', { fault: 'DIV_ZERO', r1: 9, addrIsPc: true }],
  ['trap', '        trap 42', { fault: 'TRAP', addr: 42 }],
  ['trap (negativo)', '        trap -1', { fault: 'TRAP', addr: 0xFFFFFFFF }],
  ['stw (ROM)', '        stw [zr + 0], r1', { fault: 'MEM_PERM', addr: 0 }],
  ['shl', '        li r2, 1\n        cmp r2, zr\n        li r3, 32\n        shl r1, r2, r3\n        mfsr r9, FLAGS\n        li r2, 0x80000001\n        shli r4, r2, 1\n        mfsr r10, FLAGS', { r1: 1, r9: 0, r4: 2, r10: FC }],
  ['shr', '        li r2, 2\n        shri r1, r2, 2\n        mfsr r9, FLAGS', { r1: 0, r9: FZ | FC }],
  ['sar', '        li r2, -7\n        sari r1, r2, 1\n        mfsr r9, FLAGS', { r1: u(-4), r9: FN | FC }],
  ['rol', '        li r2, 0x80000000\n        li r3, 1\n        rol r1, r2, r3\n        mfsr r9, FLAGS\n        ror r4, r1, r3\n        mfsr r10, FLAGS', { r1: 1, r9: FC, r4: 0x80000000, r10: FN | FC }],
  ['clz', '        li r2, 1\n        clz r1, r2\n        clz r4, zr\n        li r2, 8\n        ctz r5, r2\n        li r2, 0xFF\n        popcnt r6, r2', { r1: 31, r4: 32, r5: 3, r6: 8 }],
  ['push', '        mov r5, sp\n        push sp\n        ldw r1, [sp]\n        mov r6, sp\n        addi sp, sp, 4', { eq: [[1, 5]], fn: (x) => x.r[6] === u(x.r[5] - 4) }],
  ['pop', '        mov r5, sp\n        li r2, 0x100\n        push r2\n        pop sp\n        mov r1, sp\n        mov sp, r5', { r1: 0x100 }],
  ['ldw', '        la r2, buf\n        li r3, 0x11223344\n        stw [r2 + 1], r3\n        ldw r1, [r2 + 1]\n        ldh r4, [r2 + 1]\n        ldbs r5, [r2 + 4]', { r1: 0x11223344, r4: 0x3344, r5: 0x11 }],
  ['fcmp', '        fli r2, 1.0\n        fli r3, 2.0\n        fcmp r2, r3\n        mfsr r1, FLAGS\n        fli r2, 0.0\n        fli r3, -0.0\n        fcmp r2, r3\n        mfsr r4, FLAGS\n        fli r2, 3.0\n        fli r3, 2.0\n        fcmp r2, r3\n        mfsr r5, FLAGS\n        fli r2, nan\n        fcmp r2, r3\n        mfsr r6, FLAGS',
    { r1: 0x2, r4: 0x5, r5: 0x4, r6: 0xC }],
  ['blt (unordered)', '        fli r2, nan\n        fli r3, 1.0\n        fcmp r2, r3\n        li r1, 0\n        li r4, 0\n        blt um\n        b dois\num:     li r1, 1\ndois:   bge tres\n        b quatro\ntres:   li r4, 1\nquatro: nop', { r1: 1, r4: 0 }],
  ['fadd', '        li r9, 0xC\n        mtsr FLAGS, r9\n        fli r2, inf\n        fli r3, -inf\n        fadd r1, r2, r3\n        mfsr r9, FLAGS\n        fli r2, 1.0\n        fli r3, -0.0\n        fdiv r4, r2, r3', { r1: 0x7FC00000, r9: FC | FV, r4: 0xFF800000 }],
  ['fmin', '        fli r2, -0.0\n        fli r3, 0.0\n        fmin r1, r2, r3\n        fmax r4, r2, r3\n        fli r2, nan\n        fli r3, 1.0\n        fmin r5, r2, r3\n        fmin r6, r2, r2',
    { r1: 0x80000000, r4: 0, r5: 0x3F800000, r6: 0x7FC00000 }],
  ['frint', '        fli r2, 2.5\n        frint r1, r2\n        fli r2, 3.5\n        frint r4, r2\n        fli r2, -0.5\n        frint r5, r2\n        fceil r6, r2\n        fli r2, -1.5\n        ffloor r7, r2\n        fli r2, -1.7\n        ftrunc r8, r2',
    { r1: F32(2), r4: F32(4), r5: 0x80000000, r6: 0x80000000, r7: F32(-2), r8: F32(-1) }],
  ['ftoi', '        fli r2, nan\n        ftoi r1, r2\n        fli r2, 1e10\n        ftoi r4, r2\n        fli r2, -inf\n        ftoi r5, r2\n        fli r2, -3.9\n        ftoi r6, r2', { r1: 0, r4: 0x7FFFFFFF, r5: 0x80000000, r6: u(-3) }],
  ['ftou', '        fli r2, -1.0\n        ftou r1, r2\n        fli r2, 3e9\n        ftou r4, r2\n        fli r2, 5e9\n        ftou r5, r2', { r1: 0, r4: 3000000000, r5: 0xFFFFFFFF }],
  ['itof', '        li r2, -3\n        itof r1, r2\n        li r2, 16777217\n        itof r4, r2\n        li r2, 0xFFFFFFFF\n        utof r5, r2', { r1: 0xC0400000, r4: F32(16777216), r5: 0x4F800000 }],
  ['fneg', '        fli r2, nan\n        fneg r1, r2\n        fabs r4, r1', { r1: 0xFFC00000, r4: 0x7FC00000 }],
  ['syscall', '        li r1, 0x4000\n        li r5, 99\n        syscall CAPS\n        mov r6, r1\n        mov r7, r2\n        li r1, 0x22\n        syscall CAPS\n        mov r8, r1\n        li r1, 0x10\n        syscall CAPS\n        mov r10, r1\n        syscall 0x3FFF',
    { r6: 7, r7: 0, r5: 99, r8: 0, r10: 1, r1: 0xFFFFFFFF, r2: 1 }],
  ['MEM_INFO', '        li r3, 0x77\n        li r4, 0x77\n        li r5, 0x77\n        syscall MEM_INFO', { r5: 0x77, fn: (x) => x.r[3] !== 0x77 && x.r[4] !== 0x77 && x.r[2] !== 0 }]
];

test('fichas: afirmações de flags, casos especiais e exemplos conferidas na VM', () => {
  const bad = [];
  const names = new Set(ISA.instructions.map((i) => i.mnemonic).concat(ISA.shortForms.map((s) => s.key), ISA.syscalls.map((s) => s.name), ISA.branches.map((b) => b.mnemonic), ['zr']));
  for (const [ficha, body, exp] of CLAIMS) {
    const base = ficha.split(' ')[0];
    if (!names.has(base)) { bad.push(ficha + ': ficha inexistente'); continue; }
    let x;
    try { x = runAsm(body); } catch (e) { bad.push(ficha + ': ' + e.message); continue; }
    if (exp.fault) {
      if (!x.fault || x.fault.name !== exp.fault) { bad.push(ficha + ': esperado fault ' + exp.fault + ', veio ' + (x.fault ? x.fault.name : 'estado ' + x.st)); continue; }
      if (exp.addr !== undefined && x.fault.addr !== exp.addr) bad.push(ficha + ': fault_addr ' + x.fault.addr);
      if (exp.addrIsPc && x.fault.addr !== x.fault.pc) bad.push(ficha + ': fault_addr != pc');
    } else if (x.st !== STATE.HALT) { bad.push(ficha + ': terminou no estado ' + x.st + (x.fault ? ' (' + x.fault.name + ')' : '')); continue; }
    for (const k of Object.keys(exp)) {
      const m = /^r(\d+)$/.exec(k);
      if (m && x.r[+m[1]] !== u(exp[k])) bad.push(ficha + ': ' + k + ' = 0x' + x.r[+m[1]].toString(16) + ', esperado 0x' + u(exp[k]).toString(16));
    }
    for (const [a, b] of exp.eq || []) if (x.r[a] !== x.r[b]) bad.push(ficha + ': r' + a + ' != r' + b);
    if (exp.fn && !exp.fn(x)) bad.push(ficha + ': condição da ficha falsa');
  }
  eq(bad, [], 'afirmações das fichas');
});

test('fichas: formas de diretiva citadas no detalhe são aceitas pelo ksas', () => {
  const okSrc = [
    '        .data\nx:      .byte "ab", 0',                 /* .byte com string */
    '        .data\nx:      .ascii "a\\\'b", "cd"',          /* \' e lista de strings */
    '        .data\nx:      .asciz "a", "b"',
    '        .bss\nx:      .space 4\n        .org 16\ny:      .space 4', /* .org em .bss */
    '        .data\nx:      .space 2, -128',
    'R = 7\n        .data\nx:      .word R'
  ];
  for (const s of okSrc) { const r = assemble('        .text\n_start: halt\n' + s + '\n'); ok(r.ok, s + ' -> ' + r.err); }
  const badSrc = ['        .bss\nx:      .byte 1', '        .bss\nx:      .space 4, 1', '        .data\nx:      .space 2, 256'];
  for (const s of badSrc) ok(!assemble('        .text\n_start: halt\n' + s + '\n').ok, 'deveria falhar: ' + s);
});

test('fichas: flags declaradas batem com o que a ficha escreve sobre elas', () => {
  const bad = [];
  for (const i of ISA.instructions) {
    const txt = [i.summary].concat(i.detail).join(' ');
    if (i.flags === 'NONE' && i.group !== 'controle' && /atualiza Z|altera Z/.test(txt)) bad.push(i.mnemonic + ': diz que altera flags');
    if (i.flags === 'ZN' && /atualiza Z, N, C|atualiza Z, N e C/.test(txt)) bad.push(i.mnemonic + ': ZN mas fala de C');
    if (i.flags === 'ZNC' && !/Z, N e C/.test(i.summary)) bad.push(i.mnemonic + ': resumo sem "Z, N e C"');
    if (i.flags === 'ZNCV' && i.group !== 'float' && i.mnemonic !== 'mtsr' && !/Z, N, C e V|Z, N, C, V/.test(txt)) bad.push(i.mnemonic + ': sem "Z, N, C e V"');
    if (i.group === 'float' && i.mnemonic !== 'fcmp' && i.flags !== 'NONE') bad.push(i.mnemonic + ': F que altera flags');
  }
  eq(bad, [], 'texto das flags');
});

console.log('test_isa: ' + total + ' casos, ' + failed + ' falhas');
process.exit(failed ? 1 : 0);
