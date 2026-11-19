#!/usr/bin/env node
/*
 * test_srcmap.js — breakpoints e linha atual com a imagem desatualizada:
 * AsmTools.curLineToBuild / buildLineToCur com ChangeSets reais do
 * CodeMirror 6 (o bundle de web/vendor carregado num contexto vm):
 *
 *   node test/test_srcmap.js --build build
 *
 * Monta um fonte com o ksas.wasm, edita o texto com transações do CM6
 * (inserir/apagar linhas acima, dentro e abaixo do breakpoint; várias
 * transações compostas) e confere: o breakpoint na linha atual vai para o
 * mesmo endereço da imagem montada antes da edição; linha nova = pendente
 * (null); o pc da imagem volta à linha atual certa; linha apagada = null.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const T = require('../web/asmtools.js');

const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
const BUILD = args.build || 'build';
const KSAS = fs.readFileSync(path.join(BUILD, 'ksas.wasm'));

const ctx = { console };
ctx.self = ctx;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, '../web/vendor/codemirror.bundle.js'), 'utf8') + ';this.CM = CM;', ctx);
const CM = ctx.CM;

let total = 0, failed = 0;
function test(name, fn) {
  total++;
  try { fn(); } catch (e) { failed++; console.log('FALHA [' + name + '] ' + (e && e.stack ? e.stack.split('\n').slice(0, 2).join(' | ') : e)); }
}
function eq(a, b, what) {
  const sa = JSON.stringify(a), sb = JSON.stringify(b);
  if (sa !== sb) throw new Error((what || 'valor') + ': ' + sa + ' != esperado ' + sb);
}

/* Aplica edições em sequência (cada uma uma transação) e devolve o texto
 * final e a ChangeSet composta, como ksweb.js acumula. */
function edit(text, steps) {
  let st = CM.EditorState.create({ doc: text }), acc;
  for (const s of steps) {
    const doc = st.doc;
    const spec = typeof s === 'function' ? s(doc) : s;
    const tr = st.update({ changes: spec });
    acc = acc ? acc.compose(tr.changes) : tr.changes;
    st = tr.state;
  }
  return { text: st.doc.toString(), desc: acc };
}
const at = (doc, line) => doc.line(line).from;
const lineDel = (doc, a, b) => ({ from: doc.line(a).from, to: doc.line(b).to + 1 });

const SRC = [
  '; programa',          // 1
  '_start:',             // 2
  '        li r1, 1',    // 3
  '        li r2, 2',    // 4
  'loop:',               // 5
  '        add r1, r1, r2', // 6  <- breakpoint
  '        dec r2',      // 7
  '        bne loop',    // 8
  '        halt',        // 9
  ''].join('\n');
const r = T.assemble(KSAS, { files: { 'p.ksasm': SRC }, main: 'p.ksasm' });
if (!r.ok) throw new Error(r.stderr);
const addrOf = (buildLine) => { const x = T.resolveBreakpoint(r.info, 'p.ksasm', buildLine); return x ? x.addr : null; };
const BP = 6, BP_ADDR = addrOf(BP);

function bpAddr(e, curLine) {
  const bl = T.curLineToBuild(e.desc, e.text, SRC, curLine);
  return bl === null ? null : addrOf(bl);
}
function pcLine(e, addr) {
  const loc = r.info.addrLine.get(addr);
  return T.buildLineToCur(e.desc, SRC, e.text, loc.line);
}

test('sem edições: identidade', () => {
  eq(T.curLineToBuild(undefined, SRC, SRC, BP), BP);
  eq(T.buildLineToCur(undefined, SRC, SRC, BP), BP);
  eq(T.curLineToBuild(undefined, SRC + 'x', SRC, BP), null, 'texto diferente sem ChangeSet: desconhecido');
});

test('3 linhas inseridas acima: mesmo endereço, linha atual +3', () => {
  const e = edit(SRC, [{ from: 0, insert: '; a\n; b\n; c\n' }]);
  eq(bpAddr(e, BP + 3), BP_ADDR, 'breakpoint');
  eq(pcLine(e, BP_ADDR), BP + 3, 'linha atual');
  for (const l of [1, 2, 3]) eq(T.curLineToBuild(e.desc, e.text, SRC, l), null, 'linha nova ' + l + ' pendente');
});

test('linhas inseridas logo acima, digitando (várias transações)', () => {
  const steps = [];
  const typed = '        nop\n        nop\n';
  for (let i = 0; i < typed.length; i++) steps.push(((k) => (doc) => ({ from: at(doc, BP) + k, insert: typed[k] }))(i));
  const e = edit(SRC, steps);
  eq(e.text.split('\n')[BP + 1], '        add r1, r1, r2');
  eq(bpAddr(e, BP + 2), BP_ADDR, 'breakpoint');
  eq(pcLine(e, BP_ADDR), BP + 2, 'linha atual');
  eq(bpAddr(e, BP), null, 'linha digitada é pendente');
  eq(bpAddr(e, BP + 1), null, 'linha digitada é pendente');
  eq(T.curLineToBuild(e.desc, e.text, SRC, BP + 2), BP);
});

test('Enter no começo da linha do breakpoint', () => {
  const e = edit(SRC, [(doc) => ({ from: at(doc, BP), insert: '\n' })]);
  eq(bpAddr(e, BP + 1), BP_ADDR);
  eq(T.curLineToBuild(e.desc, e.text, SRC, BP), null, 'linha vazia nova');
  eq(pcLine(e, BP_ADDR), BP + 1);
});

test('linhas apagadas acima', () => {
  const e = edit(SRC, [(doc) => lineDel(doc, 3, 4)]);
  eq(bpAddr(e, BP - 2), BP_ADDR, 'breakpoint');
  eq(pcLine(e, BP_ADDR), BP - 2, 'linha atual');
  eq(pcLine(e, addrOf(3)), null, 'li r1 apagado: sem linha atual');
  eq(pcLine(e, addrOf(4)), null, 'li r2 apagado: sem linha atual');
});

test('edição dentro da linha do breakpoint', () => {
  const e = edit(SRC, [(doc) => ({ from: doc.line(BP).to - 2, to: doc.line(BP).to, insert: 'r1' })]);
  eq(e.text.split('\n')[BP - 1], '        add r1, r1, r1');
  eq(bpAddr(e, BP), BP_ADDR, 'continua a instrução da imagem');
  eq(pcLine(e, BP_ADDR), BP);
});

test('linha do breakpoint apagada ou substituída inteira', () => {
  const del = edit(SRC, [(doc) => lineDel(doc, BP, BP)]);
  eq(pcLine(del, BP_ADDR), null, 'apagada');
  eq(bpAddr(del, BP), addrOf(7), 'a linha que subiu é a do dec');
  const rep = edit(SRC, [(doc) => ({ from: doc.line(BP).from, to: doc.line(BP).to, insert: '        sub r1, r1, r2' })]);
  eq(bpAddr(rep, BP), null, 'conteúdo novo: pendente');
  eq(pcLine(rep, BP_ADDR), null, 'sem linha atual');
});

test('edições abaixo não mexem; mistura acima e abaixo composta', () => {
  const below = edit(SRC, [(doc) => ({ from: doc.line(9).to, insert: '\n        nop\n        nop' })]);
  eq(bpAddr(below, BP), BP_ADDR);
  eq(pcLine(below, addrOf(9)), 9);
  const mix = edit(SRC, [
    { from: 0, insert: '; x\n' },
    (doc) => ({ from: doc.line(10).to, insert: '\n; fim' }),
    (doc) => lineDel(doc, 2, 2),                       /* apaga "; programa" (agora linha 2) */
    (doc) => ({ from: doc.line(3).from, insert: '        nop\n' })
  ]);
  const want = mix.text.split('\n').indexOf('        add r1, r1, r2') + 1;
  eq(bpAddr(mix, want), BP_ADDR, 'breakpoint na linha ' + want);
  eq(pcLine(mix, BP_ADDR), want);
  for (let l = 1; l <= 9; l++) {
    const cur = T.buildLineToCur(mix.desc, SRC, mix.text, l);
    if (cur !== null) eq(T.curLineToBuild(mix.desc, mix.text, SRC, cur), l, 'ida e volta da linha ' + l);
  }
});

test('ChangeSet que não bate com os textos: desconhecido', () => {
  const e = edit(SRC, [{ from: 0, insert: '; a\n' }]);
  eq(T.curLineToBuild(e.desc, e.text + 'x', SRC, 2), null);
  eq(T.buildLineToCur(e.desc, SRC + 'x', e.text, 2), null);
  eq(T.curLineToBuild(null, e.text, SRC, 2), null, 'null = arquivo sem mapa');
});

console.log('test_srcmap: ' + total + ' casos, ' + failed + ' falhas');
process.exit(failed ? 1 : 0);
