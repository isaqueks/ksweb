#!/usr/bin/env node
/*
 * mkisa.js — gera isa.json (vocabulário do assembler e fichas da ISA para o
 * editor da IDE: realce, autocomplete, ajuda ao cursor e referência).
 *
 *   node tools/mkisa.js ISADUMP.json tools/ksasm-extra.json tools/isa-doc.md \
 *        KSVM2/include/ksvm/syscall.h KSVM2/include/ksvm/fault.h \
 *        build/web/isa.json build/web/isa.js
 *
 * - opcodes: saída de tools/isadump (isa.def + formas de operando do ksas);
 * - pseudo-instruções, diretivas, condições, apelidos de registradores e
 *   descrições curtas (autocomplete): tools/ksasm-extra.json;
 * - fichas (resumo, detalhe, sintaxe, exemplo, grupo; condições, registradores,
 *   flags, formatos, faults, syscalls, mapa de opcodes): tools/isa-doc.md,
 *   escrito a partir do doc 04 da ksvm2 (fonte normativa);
 * - números de syscall e códigos de erro: syscall.h; faults: fault.h.
 *
 * Falta ou sobra de ficha é erro (o build para): todo opcode, condição,
 * pseudo, diretiva, registrador especial, fault e syscall precisa da sua.
 *
 * isa.js é o mesmo JSON num script clássico (self.KSWEB_ISA = ...), para a
 * página e o arquivo único, que não podem usar fetch em file://.
 */
'use strict';
const fs = require('fs');

const [dumpPath, extraPath, docPath, syscallH, faultH, outJson, outJs] = process.argv.slice(2);
const dump = JSON.parse(fs.readFileSync(dumpPath, 'utf8'));
const extra = JSON.parse(fs.readFileSync(extraPath, 'utf8'));
const errors = [];
const fail = (msg) => errors.push(msg);

/* ---- tools/isa-doc.md ---------------------------------------------------- */

const SECTIONS = {
  'Instruções': 'insn', 'Condições': 'cond', 'Pseudo-instruções': 'pseudo', 'Formas abreviadas': 'short',
  'Diretivas': 'directive', 'Registradores': 'reg', 'Registradores especiais': 'sr', 'Flags': 'flag',
  'Formatos': 'format', 'Faults': 'fault', 'Syscalls': 'syscall', 'Erros de syscall': 'syserr',
  'Mapa de opcodes': 'opmap'
};
/* campos obrigatórios e opcionais por seção; [min, max] de linhas de detalhe */
const SCHEMA = {
  insn: { req: ['grupo', 'resumo', 'sintaxe', 'exemplo'], opt: [], detail: [2, 5] },
  cond: { req: ['testa', 'inteiro', 'float', 'resumo'], opt: ['apelidos'], detail: [0, 3] },
  pseudo: { req: ['resumo', 'sintaxe', 'expande', 'exemplo'], opt: [], detail: [0, 4] },
  short: { req: ['forma', 'expande', 'resumo', 'exemplo'], opt: [], detail: [0, 3] },
  directive: { req: ['resumo', 'sintaxe', 'exemplo'], opt: [], detail: [0, 4] },
  reg: { req: ['resumo', 'abi', 'preserva'], opt: [], detail: [0, 3] },
  sr: { req: ['acesso', 'resumo'], opt: [], detail: [0, 3] },
  flag: { req: ['bit', 'resumo'], opt: [], detail: [0, 3] },
  format: { req: ['resumo', 'alcance'], opt: [], detail: [0, 3] },
  fault: { req: ['endereço', 'resumo'], opt: [], detail: [0, 3] },
  syscall: { req: ['args', 'retorno', 'resumo'], opt: [], detail: [0, 3] },
  syserr: { req: ['resumo'], opt: [], detail: [0, 2] },
  opmap: { req: ['estado', 'resumo'], opt: [], detail: [0, 2] }
};

function parseDoc(text) {
  const doc = {};
  for (const k of Object.values(SECTIONS)) doc[k] = new Map();
  let sec = null, cur = null, inDetail = false;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\s+$/, '');
    const where = 'isa-doc.md:' + (i + 1);
    let m;
    if ((m = /^# (.+)$/.exec(line))) {
      if (SECTIONS[m[1]]) { sec = SECTIONS[m[1]]; cur = null; }
      else if (sec) fail(where + ': seção desconhecida "' + m[1] + '"');
      continue;
    }
    if (!sec) continue;
    if ((m = /^## (\S+)$/.exec(line))) {
      if (doc[sec].has(m[1])) fail(where + ': ficha repetida "' + m[1] + '"');
      cur = { key: m[1], fields: {}, detail: [], where };
      doc[sec].set(m[1], cur);
      inDetail = false;
      continue;
    }
    if (!cur) { if (line) fail(where + ': texto fora de ficha'); continue; }
    if (!line) { if (Object.keys(cur.fields).length) inDetail = true; continue; }
    if (!inDetail && (m = /^([a-zà-ú]+): ?(.*)$/.exec(line))) {
      (cur.fields[m[1]] = cur.fields[m[1]] || []).push(m[2].trim());
      continue;
    }
    if (!inDetail) { fail(where + ': esperado "campo: valor" antes da linha em branco'); continue; }
    cur.detail.push(line.trim());
  }
  for (const [sec, map] of Object.entries(doc)) {
    const sc = SCHEMA[sec];
    for (const e of map.values()) {
      for (const f of sc.req) if (!e.fields[f] || !e.fields[f][0]) fail(e.where + ': ' + e.key + ' sem "' + f + '"');
      for (const f of Object.keys(e.fields)) {
        if (!sc.req.includes(f) && !sc.opt.includes(f)) fail(e.where + ': campo desconhecido "' + f + '" em ' + e.key);
        if (e.fields[f].length > 1 && f !== 'sintaxe') fail(e.where + ': campo "' + f + '" repetido em ' + e.key);
      }
      if (e.detail.length < sc.detail[0] || e.detail.length > sc.detail[1]) {
        fail(e.where + ': ' + e.key + ' com ' + e.detail.length + ' linhas de detalhe (esperado ' + sc.detail.join(' a ') + ')');
      }
    }
  }
  return doc;
}

const DOC = parseDoc(fs.readFileSync(docPath, 'utf8'));
const f1 = (e, k) => (e.fields[k] ? e.fields[k][0] : '');

/* Toda ficha usada é marcada; as que sobrarem são erro. */
function take(sec, key, what) {
  const e = DOC[sec].get(key);
  if (!e) { fail('isa-doc.md: falta a ficha de ' + what + ' "' + key + '" (seção ' + Object.keys(SECTIONS).find((k) => SECTIONS[k] === sec) + ')'); return null; }
  e.used = true;
  return e;
}

/* ---- grupos, formatos e codificação ---------------------------------------- */

const GROUPS = [
  ['movimentação', 'Movimentação e constantes'], ['load/store', 'Load / store'], ['pilha', 'Pilha'],
  ['aritmética', 'Aritmética inteira'], ['comparação', 'Comparação e teste'], ['lógica', 'Lógica'],
  ['bits', 'Bits (extensão e contagem)'], ['deslocamentos', 'Deslocamentos e rotações'],
  ['controle', 'Controle de fluxo'], ['sistema', 'Sistema'], ['float', 'Ponto flutuante (extensão F)']
];
const GROUP_KEYS = new Set(GROUPS.map((g) => g[0]));

/* Campos de cada formato, do bit mais alto para o mais baixo (doc 04 §3).
 * word: 1 = a palavra seguinte (imm32 do formato L). */
const FORMATS = {
  R: [['func9', 31, 23], ['rc', 22, 18], ['rb', 17, 13], ['ra', 12, 8], ['opcode', 7, 0]],
  I: [['imm14', 31, 18], ['rb', 17, 13], ['ra', 12, 8], ['opcode', 7, 0]],
  L: [['reservado', 31, 18], ['rb', 17, 13], ['ra', 12, 8], ['opcode', 7, 0], ['imm32', 31, 0, 1]],
  B: [['off20', 31, 12], ['cond', 11, 8], ['opcode', 7, 0]],
  J: [['off24', 31, 8], ['opcode', 7, 0]]
};

const hex2 = (n) => '0x' + n.toString(16).toUpperCase().padStart(2, '0');

/* Operando de cada campo (o mapeamento do topo do isa.def). */
function fieldValues(o) {
  const n = o.name, v = {};
  const pcrel = 'rótulo − PC_next';
  switch (o.shape) {
    case 'R3': Object.assign(v, { ra: 'rd', rb: 'ra', rc: 'rb' }); break;
    case 'R2': Object.assign(v, (n === 'CMP' || n === 'TST' || n === 'FCMP') ? { ra: 'ra', rb: 'rb' } : { ra: 'rd', rb: 'rb' }); break;
    case 'RA': v.ra = n === 'POP' ? 'rd' : 'ra'; break;
    case 'RB': v.rb = 'rb'; break;
    case 'LOAD': Object.assign(v, { ra: 'rd', rb: 'rb' }, o.format === 'R' ? { rc: 'rc' } : { imm14: 'imm' }); break;
    case 'STORE': Object.assign(v, { ra: 'ra', rb: 'rb' }, o.format === 'R' ? { rc: 'rc' } : { imm14: 'imm' }); break;
    case 'RRI': Object.assign(v, { ra: 'rd', rb: 'ra' }); v[o.format === 'L' ? 'imm32' : 'imm14'] = o.imm === 'shift' ? 'n' : 'imm'; break;
    case 'RI': {
      v.ra = (n === 'CMPI' || n === 'TSTI' || n === 'CMPL') ? 'ra' : 'rd';
      v[o.format === 'L' ? 'imm32' : 'imm14'] = n === 'MFSR' ? 'sr' : (n === 'ADR' || n === 'ADRL') ? pcrel : 'imm';
      break;
    }
    case 'SR_RB': Object.assign(v, { rb: 'rb', imm14: 'sr' }); break;
    case 'IMM': v.imm14 = n === 'SYSCALL' ? 'número' : (n === 'PUSHM' || n === 'POPM') ? 'máscara' : 'imm'; break;
    case 'BRANCH': Object.assign(v, { off20: '(' + pcrel + ') / 4', cond: 'cond' }); break;
    case 'JUMP': v.off24 = '(' + pcrel + ') / 4'; break;
    default: break;
  }
  return v;
}

function encoding(o, override) {
  const vals = Object.assign(fieldValues(o), override || {});
  const fields = FORMATS[o.format].map(([name, hi, lo, word]) => {
    const value = name === 'opcode' ? hex2(o.opcode) : vals[name] || '0';
    const f = { name, hi, lo, value };
    if (word) f.word = word;
    return f;
  });
  const used = fields.filter((f) => f.name !== 'opcode' && f.value !== '0').map((f) => f.name + ' = ' + f.value);
  return {
    opcode: hex2(o.opcode), format: o.format, len: o.len, fields,
    text: 'formato ' + o.format + ', ' + o.len + ' bytes, opcode ' + hex2(o.opcode) + (used.length ? '; ' + used.join(', ') : '')
  };
}

/* ---- instruções -------------------------------------------------------------- */

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
const flagList = (f) => (f === 'NONE' ? [] : f.split(''));

const instructions = [];
const byOp = new Map();
for (const o of dump.opcodes) {
  byOp.set(o.name, o);
  const ops = operands(o);
  const m = o.name.toLowerCase();
  const e = {
    mnemonic: m, opcode: o.opcode, format: o.format, len: o.len, flags: o.flags, shape: o.shape,
    imm: o.imm, operands: ops, signature: (m + ' ' + ops.join(', ')).trim(), desc: o.desc,
    flagsText: FLAG_TEXT[o.flags] || o.flags, flagsList: flagList(o.flags)
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
  const d = take('insn', m, 'instrução');
  if (d) {
    const g = f1(d, 'grupo');
    if (!GROUP_KEYS.has(g)) fail(d.where + ': grupo desconhecido "' + g + '" em ' + m);
    Object.assign(e, {
      group: g, summary: f1(d, 'resumo'), syntax: d.fields.sintaxe[0], syntaxAll: d.fields.sintaxe.slice(),
      example: f1(d, 'exemplo'), detail: d.detail.slice()
    });
  }
  e.encoding = encoding(o);
  instructions.push(e);
}

/* ---- condições e desvios ------------------------------------------------------- */

const conds = [];
const condByName = new Map();
dump.conds.forEach((c, code) => {
  const d = take('cond', c.toLowerCase(), 'condição');
  const e = { name: c, code, desc: extra.conds[c] || '', aliases: [] };
  if (d) {
    Object.assign(e, { tests: f1(d, 'testa'), int: f1(d, 'inteiro'), float: f1(d, 'float'), summary: f1(d, 'resumo'), detail: d.detail.slice() });
    if (d.fields.apelidos) e.aliases = f1(d, 'apelidos').split(/[ ,]+/).map((s) => s.toUpperCase()).filter(Boolean);
  }
  conds.push(e);
  condByName.set(c, e);
});
/* apelidos (CS = HS, CC = LO) como entradas próprias, como antes */
for (const c of dump.conds.slice()) {
  for (const a of condByName.get(c).aliases) {
    const base = condByName.get(c);
    const e = Object.assign({}, base, { name: a, desc: extra.conds[a] || '', aliasOf: c, aliases: [] });
    conds.push(e);
    condByName.set(a, e);
  }
}
for (const a of ['CS', 'CC']) if (!condByName.has(a)) fail('isa-doc.md: condição ' + a + ' não declarada em "apelidos:"');

const bcond = byOp.get('BCOND');
const branches = [];
for (const c of conds) {
  const lc = c.name.toLowerCase();
  const desc = 'desvia se ' + (extra.conds[c.name] || c.name) + ' (BCOND ' + c.name + ', ±2 MiB)';
  const base = c.aliasOf ? condByName.get(c.aliasOf) : c;
  const card = {
    cond: c.name, code: base.code, operands: ['rótulo'], desc, group: 'controle', flags: 'NONE', flagsList: [],
    flagsText: FLAG_TEXT.NONE, opcode: bcond.opcode, format: 'B', len: 4,
    summary: base.code === 0 ? 'Desvia sempre para `rótulo` (incondicional; alcance ±2 MiB).'
      : base.code === 15 ? 'Nunca desvia (condição NV, reservada): comporta-se como NOP.'
        : 'Desvia para `rótulo` se ' + base.summary + '; alcance ±2 MiB.',
    detail: [
      'Testa ' + base.tests + '. Depois de `cmp a, b`: ' + base.int + '; depois de `fcmp a, b`: ' + base.float + '.',
      'BCOND (0x72) com cond = ' + base.code + (c.aliasOf ? ' (' + c.name + ' é apelido de ' + c.aliasOf + ')' : '') +
        ': `pc = PC_next + off20 × 4` se a condição vale; não altera flags.'
    ].concat(base.detail || []),
    encoding: encoding(bcond, { cond: String(base.code) + ' (' + c.name + ')' })
  };
  for (const [m, alias] of [['b' + lc, false], ['b.' + lc, true]]) {
    const e = Object.assign({ mnemonic: m, signature: m + ' rótulo', syntax: m + ' rótulo', snippet: m + ' ${rótulo}' }, card);
    e.example = (m + ' fim').padEnd(25) + '; ' + (base.code === 15 ? 'nunca desvia' : base.code === 0 ? 'sempre desvia' : 'desvia se ' + base.tests);
    if (alias) e.alias = true;
    branches.push(e);
  }
}

/* ---- pseudo-instruções, formas abreviadas, diretivas ------------------------------ */

const pseudos = extra.pseudos.map((p) => {
  const e = {
    mnemonic: p.name, operands: p.operands, signature: (p.name + ' ' + p.operands.join(', ')).trim(),
    desc: p.desc, snippet: snippet(p.name, p.operands)
  };
  const d = take('pseudo', p.name, 'pseudo-instrução');
  if (d) Object.assign(e, { summary: f1(d, 'resumo'), syntax: d.fields.sintaxe[0], syntaxAll: d.fields.sintaxe.slice(), expands: f1(d, 'expande'), example: f1(d, 'exemplo'), detail: d.detail.slice() });
  return e;
});

const shortForms = [...DOC.short.values()].map((d) => {
  d.used = true;
  return { key: d.key, form: f1(d, 'forma'), expands: f1(d, 'expande'), summary: f1(d, 'resumo'), example: f1(d, 'exemplo'), detail: d.detail.slice() };
});

const directives = extra.directives.map((x) => {
  const e = {
    name: x.name, args: x.args, desc: x.desc,
    snippet: x.args ? x.name + ' ' + (x.args.startsWith('"') ? '"${' + x.args.replace(/"/g, '') + '}"' : '${' + x.args.split(/[ ,[]/)[0] + '}') : x.name
  };
  const d = take('directive', x.name, 'diretiva');
  if (d) Object.assign(e, { summary: f1(d, 'resumo'), syntax: d.fields.sintaxe[0], syntaxAll: d.fields.sintaxe.slice(), example: f1(d, 'exemplo'), detail: d.detail.slice() });
  return e;
});

/* ---- registradores ---------------------------------------------------------------- */

const regDocs = [];
const regDocOf = new Array(32).fill(null);
for (const d of DOC.reg.values()) {
  d.used = true;
  const name = d.key;
  let from, to;
  let m;
  if (name === 'zr') from = to = 0;
  else if (name === 'fp') from = to = 30;
  else if (name === 'sp') from = to = 31;
  else if ((m = /^r(\d+)(?:-r(\d+))?$/.exec(name))) { from = +m[1]; to = m[2] ? +m[2] : from; }
  else { fail(d.where + ': registrador inválido "' + name + '"'); continue; }
  for (let i = from; i <= to; i++) {
    if (regDocOf[i]) fail(d.where + ': r' + i + ' em duas fichas');
    regDocOf[i] = name;
  }
  regDocs.push({ key: name, from, to, summary: f1(d, 'resumo'), abi: f1(d, 'abi'), preserve: f1(d, 'preserva'), detail: d.detail.slice() });
}
regDocOf.forEach((k, i) => { if (!k) fail('isa-doc.md: r' + i + ' sem ficha de registrador'); });

const registers = [];
for (let i = 0; i < 32; i++) {
  const n = 'r' + i;
  const alt = i === 0 ? 'zr' : i === 30 ? 'fp' : i === 31 ? 'sp' : null;
  registers.push({ name: n, index: i, desc: extra.registers[n] || (alt ? extra.registers[alt] : 'registrador ' + i), doc: regDocOf[i] });
}
for (const a of ['zr', 'fp', 'sp']) {
  const i = a === 'zr' ? 0 : a === 'fp' ? 30 : 31;
  registers.push({ name: a, index: i, desc: extra.registers[a], doc: regDocOf[i] });
}
for (const al of extra.aliases) {
  for (let i = 0; i < al.count; i++) {
    registers.push({ name: al.prefix + i, index: al.base + i, desc: 'r' + (al.base + i) + ' (' + al.desc + ')', alias: true, doc: regDocOf[al.base + i] });
  }
}

const specialRegs = Object.entries(extra.specialRegs).map(([name, desc], i) => {
  const e = { name, num: i, desc };
  const d = take('sr', name, 'registrador especial');
  if (d) Object.assign(e, { access: f1(d, 'acesso'), summary: f1(d, 'resumo'), detail: d.detail.slice() });
  return e;
});

/* ---- flags e formatos --------------------------------------------------------------- */

const flagBits = ['Z', 'N', 'C', 'V'].map((name, bit) => {
  const d = take('flag', name, 'flag');
  const e = { name, bit, setBy: instructions.filter((i) => i.flagsList.includes(name)).map((i) => i.mnemonic) };
  if (d) {
    if (+f1(d, 'bit') !== bit) fail(d.where + ': flag ' + name + ' é o bit ' + bit);
    Object.assign(e, { summary: f1(d, 'resumo'), detail: d.detail.slice() });
  }
  return e;
});

const formats = Object.keys(FORMATS).map((name) => {
  const d = take('format', name, 'formato');
  const e = {
    name, len: name === 'L' ? 8 : 4,
    fields: FORMATS[name].map(([n, hi, lo, word]) => (word ? { name: n, hi, lo, word } : { name: n, hi, lo })),
    count: instructions.filter((i) => i.format === name).length
  };
  if (d) Object.assign(e, { summary: f1(d, 'resumo'), range: f1(d, 'alcance'), detail: d.detail.slice() });
  return e;
});

/* ---- faults, syscalls, erros ----------------------------------------------------------- */

const faultSrc = fs.readFileSync(faultH, 'utf8');
const faultEnum = /enum[^{]*\{([\s\S]*?)\}/.exec(faultSrc);
const faults = [];
if (!faultEnum) fail('fault.h: enum dos faults não encontrado');
else {
  let code = 0;
  for (const m of faultEnum[1].matchAll(/KSVM_FAULT_(\w+)(?:\s*=\s*(\d+))?/g)) {
    if (m[2] !== undefined) code = +m[2];
    const name = m[1];
    if (name !== 'NONE' && name !== 'COUNT') {
      const d = take('fault', name, 'fault');
      const e = { name, code, exit: 70 + code };
      if (d) Object.assign(e, { addr: f1(d, 'endereço'), summary: f1(d, 'resumo'), detail: d.detail.slice() });
      faults.push(e);
    }
    code++;
  }
}

const SYS_GROUPS = ['núcleo', 'console', 'tempo', 'arquivos', 'GPIO', 'memória'];
const sysSrc = fs.readFileSync(syscallH, 'utf8');
const syscalls = [];
for (const m of sysSrc.matchAll(/KSVM_SYSCALL_(\w+)\s*=\s*(0x[0-9A-Fa-f]+)/g)) {
  if (m[1] === 'USER_BASE') continue;
  const num = parseInt(m[2], 16);
  const e = { name: m[1], num, group: num >> 4, groupName: SYS_GROUPS[num >> 4] || 'host', desc: extra.syscalls[m[1]] || '' };
  const d = take('syscall', m[1], 'syscall');
  if (d) Object.assign(e, { args: f1(d, 'args'), ret: f1(d, 'retorno'), summary: f1(d, 'resumo'), detail: d.detail.slice() });
  syscalls.push(e);
}
const syscallErrors = [];
for (const m of sysSrc.matchAll(/KSVM_ERR_(\w+)\s*=\s*(\d+)/g)) {
  const d = take('syserr', m[1], 'erro de syscall');
  syscallErrors.push({ name: m[1], code: +m[2], summary: d ? f1(d, 'resumo') : '' });
}

/* ---- mapa de opcodes -------------------------------------------------------------------- */

const OP_STATES = new Set(['removido', 'reservado', 'plataforma', 'inválido']);
const opRanges = [];
for (const d of DOC.opmap.values()) {
  d.used = true;
  const m = /^0x([0-9A-F]{2})(?:-0x([0-9A-F]{2}))?$/.exec(d.key);
  if (!m) { fail(d.where + ': faixa inválida "' + d.key + '"'); continue; }
  const from = parseInt(m[1], 16), to = m[2] ? parseInt(m[2], 16) : from;
  const st = f1(d, 'estado');
  if (!OP_STATES.has(st)) fail(d.where + ': estado desconhecido "' + st + '"');
  for (const i of instructions) if (i.opcode >= from && i.opcode <= to) fail(d.where + ': ' + d.key + ' inclui ' + i.mnemonic);
  opRanges.push({ from, to, state: st, summary: f1(d, 'resumo') });
}

/* ---- sobras e saída ---------------------------------------------------------------------- */

for (const [sec, map] of Object.entries(DOC)) {
  for (const e of map.values()) if (!e.used) fail(e.where + ': ficha "' + e.key + '" não corresponde a nada (seção ' + sec + ')');
}
if (errors.length) {
  for (const e of errors) console.error('mkisa: ' + e);
  console.error('mkisa: ' + errors.length + ' erro(s) em ' + docPath);
  process.exit(1);
}

const isa = {
  generator: 'tools/mkisa.js (isa.def + mnemonic.c via tools/isadump; tools/ksasm-extra.json; tools/isa-doc.md; syscall.h; fault.h)',
  source: 'fichas de tools/isa-doc.md, escritas a partir do doc 04 da ksvm2 (fonte normativa)',
  groups: GROUPS.map(([key, label]) => ({ key, label })),
  instructions, branches, pseudos, shortForms, directives, registers, regDocs, syscalls, syscallErrors,
  specialRegs, conds, flagBits, formats, faults, opRanges
};

const json = JSON.stringify(isa, null, 1);
fs.writeFileSync(outJson, json + '\n');
if (outJs) {
  fs.writeFileSync(outJs, '/* gerado por tools/mkisa.js — não editar */\n' +
    '(typeof self !== "undefined" ? self : globalThis).KSWEB_ISA = ' + JSON.stringify(isa) + ';\n');
}
