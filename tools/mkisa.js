#!/usr/bin/env node
/*
 * mkisa.js — gera isa.json (vocabulário do assembler para o editor da IDE:
 * realce, autocomplete e documentação ao passar o mouse).
 *
 *   node tools/mkisa.js ISADUMP.json tools/ksasm-extra.json KSVM2/include/ksvm/syscall.h \
 *        build/web/isa.json build/web/isa.js
 *
 * - opcodes: saída de tools/isadump (isa.def + formas de operando do ksas);
 * - pseudo-instruções, diretivas, condições, apelidos de registradores e
 *   descrições: tools/ksasm-extra.json (doc 07 da KSVM);
 * - números de syscall: enum ksvm_syscall_num de syscall.h.
 *
 * isa.js é o mesmo JSON num script clássico (self.KSWEB_ISA = ...), para a
 * página e o arquivo único, que não podem usar fetch em file://.
 */
'use strict';
const fs = require('fs');

const [dumpPath, extraPath, syscallH, outJson, outJs] = process.argv.slice(2);
const dump = JSON.parse(fs.readFileSync(dumpPath, 'utf8'));
const extra = JSON.parse(fs.readFileSync(extraPath, 'utf8'));

/* Operandos por forma (topo do isa.def e ksas_op_shape). */
function operands(o) {
  const n = o.name;
  switch (o.shape) {
    case 'NONE': return [];
    case 'R3': return ['rd', 'ra', o.immForm ? 'rb|imm' : 'rb'];
    case 'R2':
      if (n === 'CMP' || n === 'TST' || n === 'FCMP') return ['ra', o.immForm ? 'rb|imm' : 'rb'];
      return ['rd', o.immForm ? 'rb|imm' : 'rb'];
    case 'RA': return [n === 'POP' ? 'rd' : 'ra'];
    case 'RB': return ['rb'];
    case 'LOAD': return ['rd', o.format === 'R' ? '[rb + rc]' : '[rb + imm]'];
    case 'STORE': return [o.format === 'R' ? '[rb + rc]' : '[rb + imm]', 'ra'];
    case 'RRI': return ['rd', 'ra', o.imm === 'shift' ? 'n' : 'imm'];
    case 'RI':
      if (n === 'CMPI' || n === 'TSTI' || n === 'CMPL') return ['ra', 'imm'];
      if (n === 'MFSR') return ['rd', 'sr'];
      if (n === 'ADR' || n === 'ADRL') return ['rd', 'rótulo'];
      return ['rd', 'imm'];
    case 'SR_RB': return ['sr', 'rb'];
    case 'IMM':
      if (n === 'SYSCALL') return ['número|nome'];
      if (n === 'PUSHM' || n === 'POPM') return ['máscara'];
      return ['imm'];
    case 'BRANCH': return ['rótulo'];
    case 'JUMP': return ['rótulo'];
    default: return [];
  }
}

/* Snippet do CodeMirror 6: "add ${rd}, ${ra}, ${rb}". */
function snippet(name, ops) {
  if (!ops.length) return name;
  const ph = (s) => '${' + s.replace(/[{}$\\]/g, '') + '}';
  const parts = ops.map((op) => {
    const m = /^\[(\w+) \+ (\w+)\]$/.exec(op);
    if (m) return '[' + ph(m[1]) + ' + ' + ph(m[2]) + ']';
    return ph(op.split('|')[0]);
  });
  return name + ' ' + parts.join(', ');
}

const FLAG_TEXT = { NONE: 'não altera flags', ZN: 'altera Z N', ZNC: 'altera Z N C', ZNCV: 'altera Z N C V' };

const instructions = [];
for (const o of dump.opcodes) {
  const ops = operands(o);
  const m = o.name.toLowerCase();
  const e = {
    mnemonic: m, opcode: o.opcode, format: o.format, len: o.len, flags: o.flags, shape: o.shape,
    imm: o.imm, operands: ops, signature: (m + ' ' + ops.join(', ')).trim(), desc: o.desc,
    flagsText: FLAG_TEXT[o.flags] || o.flags
  };
  if (o.long) e.long = o.long;
  if (o.immForm) e.immForm = o.immForm;
  if (o.indexed) e.indexed = o.indexed;
  if (o.shape === 'BRANCH') {
    e.note = 'não se escreve "bcond": use b<cond> (beq, bne, b.lt...) ou b';
    e.snippet = null;
  } else {
    e.snippet = snippet(m, ops);
  }
  instructions.push(e);
}

/* Desvios condicionais b<cond> e b.<cond> (aliases CS/CC). */
const branches = [];
const condNames = dump.conds.concat(['CS', 'CC']);
for (const c of condNames) {
  const lc = c.toLowerCase();
  const desc = 'desvia se ' + (extra.conds[c] || c) + ' (BCOND ' + c + ', ±2 MiB)';
  branches.push({ mnemonic: 'b' + lc, cond: c, operands: ['rótulo'], signature: 'b' + lc + ' rótulo', desc, snippet: 'b' + lc + ' ${rótulo}' });
  branches.push({ mnemonic: 'b.' + lc, cond: c, operands: ['rótulo'], signature: 'b.' + lc + ' rótulo', desc, snippet: 'b.' + lc + ' ${rótulo}', alias: true });
}

const pseudos = extra.pseudos.map((p) => ({
  mnemonic: p.name, operands: p.operands, signature: (p.name + ' ' + p.operands.join(', ')).trim(),
  desc: p.desc, snippet: snippet(p.name, p.operands)
}));

const directives = extra.directives.map((d) => ({
  name: d.name, args: d.args, desc: d.desc,
  snippet: d.args ? d.name + ' ' + (d.args.startsWith('"') ? '"${' + d.args.replace(/"/g, '') + '}"' : '${' + d.args.split(/[ ,[]/)[0] + '}') : d.name
}));

const registers = [];
for (let i = 0; i < 32; i++) {
  const n = 'r' + i;
  const alt = i === 0 ? 'zr' : i === 30 ? 'fp' : i === 31 ? 'sp' : null;
  registers.push({ name: n, index: i, desc: extra.registers[n] || (alt ? extra.registers[alt] : 'registrador ' + i) });
}
for (const a of ['zr', 'fp', 'sp']) {
  registers.push({ name: a, index: a === 'zr' ? 0 : a === 'fp' ? 30 : 31, desc: extra.registers[a] });
}
for (const al of extra.aliases) {
  for (let i = 0; i < al.count; i++) {
    registers.push({ name: al.prefix + i, index: al.base + i, desc: 'r' + (al.base + i) + ' (' + al.desc + ')', alias: true });
  }
}

/* enum ksvm_syscall_num */
const sysSrc = fs.readFileSync(syscallH, 'utf8');
const syscalls = [];
for (const m of sysSrc.matchAll(/KSVM_SYSCALL_(\w+)\s*=\s*(0x[0-9A-Fa-f]+)/g)) {
  if (m[1] === 'USER_BASE') continue;
  syscalls.push({ name: m[1], num: parseInt(m[2], 16), desc: extra.syscalls[m[1]] || '' });
}

const specialRegs = Object.entries(extra.specialRegs).map(([name, desc], i) => ({ name, num: i, desc }));

const isa = {
  generator: 'tools/mkisa.js (isa.def + mnemonic.c via tools/isadump; tools/ksasm-extra.json; syscall.h)',
  instructions, branches, pseudos, directives, registers, syscalls, specialRegs,
  conds: condNames.map((c) => ({ name: c, desc: extra.conds[c] || '' }))
};

const json = JSON.stringify(isa, null, 1);
fs.writeFileSync(outJson, json + '\n');
if (outJs) {
  fs.writeFileSync(outJs, '/* gerado por tools/mkisa.js — não editar */\n' +
    '(typeof self !== "undefined" ? self : globalThis).KSWEB_ISA = ' + JSON.stringify(isa) + ';\n');
}
