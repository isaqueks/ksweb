#!/usr/bin/env node
/*
 * test_isaref.js — ajuda ao cursor e referência da ISA (web/isaref.js e
 * KsasmLang.helpAt), em Node, sem navegador:
 *
 *   node test/test_isaref.js --isa build/web/isa.json
 *
 * - busca/filtro/ordenação da referência (função pura);
 * - mapa de opcodes (256 células) e fichas de cada tipo;
 * - "token sob o cursor -> ficha" para mnemônico, pseudo, diretiva,
 *   registrador, condição de desvio, syscall, registrador especial e rótulo;
 * - render da ficha, do tooltip e da referência num DOM falso: todas as
 *   linhas presentes, expansão de ficha, inserir/copiar exemplo, busca,
 *   filtros, seções, mapa de opcodes, show() posicionado; nada de innerHTML.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const IsaRef = require('../web/isaref.js');
const Lang = require('../web/ksasm-lang.js');

const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
const ISA = JSON.parse(fs.readFileSync(args.isa || 'build/web/isa.json', 'utf8'));
Lang.setIsa(ISA);

let total = 0, failed = 0;
function test(name, fn) {
  total++;
  try { fn(); } catch (e) { failed++; console.log('FALHA [' + name + '] ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e)); }
}
function eq(a, b, what) {
  const sa = JSON.stringify(a), sb = JSON.stringify(b);
  if (sa !== sb) throw new Error((what || 'valor') + ': ' + sa + ' != esperado ' + sb);
}
function ok(c, what) { if (!c) throw new Error(what || 'condição falsa'); }

/* ---- DOM falso: só o que isaref.js usa ---- */
class FNode {
  constructor(doc, type) { this.ownerDocument = doc; this.nodeType = type; this.childNodes = []; this.parentNode = null; }
  get firstChild() { return this.childNodes[0] || null; }
  get nextSibling() { if (!this.parentNode) return null; const c = this.parentNode.childNodes; return c[c.indexOf(this) + 1] || null; }
  appendChild(n) {
    if (n.nodeType === 11) { for (const c of n.childNodes.slice()) this.appendChild(c); return n; }
    if (n.parentNode) n.parentNode.removeChild(n);
    n.parentNode = this; this.childNodes.push(n); return n;
  }
  append(...ns) { for (const n of ns) this.appendChild(typeof n === 'string' ? this.ownerDocument.createTextNode(n) : n); }
  insertBefore(n, ref) {
    if (!ref) return this.appendChild(n);
    if (n.parentNode) n.parentNode.removeChild(n);
    n.parentNode = this; this.childNodes.splice(this.childNodes.indexOf(ref), 0, n); return n;
  }
  removeChild(n) { const i = this.childNodes.indexOf(n); if (i >= 0) this.childNodes.splice(i, 1); n.parentNode = null; return n; }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  replaceChildren(...ns) { for (const c of this.childNodes) c.parentNode = null; this.childNodes = []; this.append(...ns); }
  get textContent() { return this.nodeType === 3 ? this.data : this.childNodes.map((c) => c.textContent).join(''); }
  set textContent(v) {
    if (this.nodeType === 3) { this.data = String(v); return; }
    this.replaceChildren(); if (v !== '' && v !== null && v !== undefined) this.appendChild(this.ownerDocument.createTextNode(String(v)));
  }
}
class FElement extends FNode {
  constructor(doc, tag) {
    super(doc, 1); this.tagName = tag.toUpperCase(); this.attrs = new Map(); this.listeners = new Map();
    this.style = {}; this.hidden = false; this.value = ''; this.title = ''; this.className = '';
  }
  get children() { return this.childNodes.filter((c) => c.nodeType === 1); }
  setAttribute(k, v) { this.attrs.set(k, String(v)); if (k === 'value') this.value = String(v); }
  getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }
  removeAttribute(k) { this.attrs.delete(k); }
  addEventListener(t, fn) { if (!this.listeners.has(t)) this.listeners.set(t, []); this.listeners.get(t).push(fn); }
  dispatch(t, extra) {
    const ev = Object.assign({ type: t, target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; } }, extra || {});
    for (let n = this; n && !ev.stopped; n = n.parentNode) for (const fn of (n.listeners && n.listeners.get(t)) || []) fn.call(n, ev);
    return ev;
  }
  click() { return this.dispatch('click'); }
  closest(sel) {
    const tags = sel.split(',').map((s) => s.trim().toUpperCase());
    for (let n = this; n && n.nodeType === 1; n = n.parentNode) if (tags.includes(n.tagName)) return n;
    return null;
  }
  focus() { this.ownerDocument.activeElement = this; }
  select() {}
  scrollIntoView() {}
  get innerHTML() { throw new Error('innerHTML lido'); }
  set innerHTML(v) { throw new Error('innerHTML escrito: ' + v); }
  /* busca na subárvore */
  all(pred) { const out = []; const walk = (n) => { for (const c of n.childNodes) if (c.nodeType === 1) { if (pred(c)) out.push(c); walk(c); } }; walk(this); return out; }
  tag(t) { return this.all((n) => n.tagName === t.toUpperCase()); }
  cls(c) { return this.all((n) => (' ' + n.className + ' ').includes(' ' + c + ' ')); }
}
class FDoc {
  constructor() { this.activeElement = null; }
  createElement(t) { return new FElement(this, t); }
  createTextNode(s) { const n = new FNode(this, 3); n.data = String(s); return n; }
  createDocumentFragment() { return new FNode(this, 11); }
}

/* ---- busca, filtro, ordenação ---- */

test('filterInsns: sem filtro, todas por opcode; por nome', () => {
  const all = IsaRef.filterInsns(ISA, {});
  eq(all.length, ISA.instructions.length, 'todas');
  ok(all.every((x, i) => i === 0 || all[i - 1].opcode < x.opcode), 'ordem de opcode');
  const byName = IsaRef.filterInsns(ISA, { sort: 'name' }).map((i) => i.mnemonic);
  eq(byName, byName.slice().sort(), 'ordem alfabética');
});

test('filterInsns: mnemônico, opcode, palavra da descrição, acentos, várias palavras', () => {
  const m = (o) => IsaRef.filterInsns(ISA, o).map((i) => i.mnemonic);
  eq(m({ q: 'fcmp' })[0], 'fcmp', 'mnemônico exato primeiro');
  eq(m({ q: 'ADD' }).slice(0, 3), ['add', 'addi', 'addl'], 'igual, depois prefixos');
  eq(m({ q: '0x3A' }), ['cmpl'], 'opcode 0x3A');
  eq(m({ q: '0xa' }), ISA.instructions.filter((i) => i.opcode >= 0xA0 && i.opcode <= 0xAF).map((i) => i.mnemonic), 'prefixo 0xA');
  eq(m({ q: 'b1' }), ['fcmp'], 'opcode sem 0x');
  const sat = m({ q: 'satura' });
  ok(sat.includes('ftoi') && sat.includes('ftou'), 'palavra da descrição: ' + sat);
  eq(m({ q: 'divisao' }), m({ q: 'DIVISÃO' }), 'acentos e maiúsculas ignorados');
  const logica = m({ q: 'logica' });
  ok(ISA.instructions.filter((i) => i.group === 'lógica').every((i) => logica.includes(i.mnemonic)), 'grupo Lógica pela busca sem acento');
  const two = m({ q: 'div zero' });
  ok(two.includes('div') && two.includes('remu') && !two.includes('add'), 'duas palavras (E): ' + two);
  eq(m({ q: 'nao-existe-xyz' }), [], 'nada');
});

test('filterInsns: grupo, formato e combinação com a busca', () => {
  const m = (o) => IsaRef.filterInsns(ISA, o).map((i) => i.mnemonic);
  eq(m({ group: 'float' }).length, 18, 'extensão F: 18');
  eq(m({ format: 'L' }), ['movil', 'adrl', 'addl', 'cmpl', 'andl', 'orl', 'xorl'], 'formato L');
  eq(m({ format: 'J' }), ['jmp', 'call'], 'formato J');
  eq(m({ group: 'load/store', format: 'R', sort: 'name' }), ['ldbsx', 'ldbx', 'ldhsx', 'ldhx', 'ldwx', 'stbx', 'sthx', 'stwx'], 'grupo + formato');
  eq(m({ group: 'float', q: 'nan' }).includes('fadd'), true, 'grupo + busca');
});

test('filterRows e norm', () => {
  eq(IsaRef.norm('Lógica ÇÃO'), 'logica cao');
  const rows = [{ t: 'Divisão por zero' }, { t: 'soma' }];
  eq(IsaRef.filterRows(rows, 'divisao', (r) => r.t).length, 1);
  eq(IsaRef.filterRows(rows, '', (r) => r.t).length, 2);
  eq(IsaRef.filterRows(rows, 'zero soma', (r) => r.t).length, 0);
});

test('mapa de opcodes: 256 células e estados do doc 04 §5.8', () => {
  const c = IsaRef.opcodeCells(ISA);
  eq(c.length, 256);
  eq(c.filter((x) => x.state === 'usado').length, ISA.instructions.length, 'ocupados = instruções');
  eq([c[0x30].mnemonic, c[0x04].state, c[0x09].state, c[0x85].state, c[0xB5].state, c[0xC3].state, c[0xFF].state],
    ['add', 'removido', 'livre', 'reservado', 'reservado', 'plataforma', 'inválido']);
  ok(c.every((x) => x.summary), 'toda célula com descrição');
});

/* ---- fichas e "token sob o cursor" ---- */

test('fichas de cada tipo e posição na referência', () => {
  const cases = [
    [{ kind: 'insn', key: 'add' }, 'ADD', 'insn', 'add'],
    [{ kind: 'branch', key: 'b.lt' }, 'b.lt', 'cond', 'lt'],
    [{ kind: 'branch', key: 'bcc' }, 'bcc', 'cond', 'lo'],
    [{ kind: 'cond', key: 'GE' }, 'bge', 'cond', 'ge'],
    [{ kind: 'pseudo', key: 'fli' }, 'fli', 'pseudo', 'fli'],
    [{ kind: 'directive', key: '.asciz' }, '.asciz', 'directive', '.asciz'],
    [{ kind: 'register', key: 's0' }, 's0', 'reg', 'r16-r29'],
    [{ kind: 'register', key: 'fp' }, 'fp', 'reg', 'fp'],
    [{ kind: 'sr', key: 'INSN_COUNT' }, 'INSN_COUNT', 'sr', 'insn_count'],
    [{ kind: 'syscall', key: 'GETS' }, 'syscall GETS', 'syscall', 'gets'],
    [{ kind: 'fault', key: 'DIV_ZERO' }, 'fault DIV_ZERO', 'fault', 'div_zero']
  ];
  for (const [t, title, sec, key] of cases) {
    const c = IsaRef.card(ISA, t);
    ok(c, JSON.stringify(t));
    eq([c.title, c.ref && c.ref.section, c.ref && c.ref.key], [title, sec, key], JSON.stringify(t));
    ok(c.summary, title + ' resumo');
  }
  const add = IsaRef.card(ISA, { kind: 'insn', key: 'ADD' });
  eq([add.syntax[0], add.flags.join(''), add.encoding.opcode, add.badges[0]], ['add rd, ra, rb', 'ZNCV', '0x30', '0x30']);
  ok(add.example.startsWith('add r1, r2, r3') && add.detail.length >= 2, 'exemplo e detalhe');
  const blt = IsaRef.card(ISA, { kind: 'branch', key: 'blt' });
  ok(blt.extra.some((e) => e[0] === 'Testa' && e[1] === 'N≠V'), 'blt testa N≠V');
  eq(IsaRef.card(ISA, { kind: 'insn', key: 'nada' }), null, 'inexistente');
  eq(IsaRef.card(ISA, { kind: 'label', key: 'loop' }), null, 'rótulo é com a IDE');
});

test('token sob o cursor -> ficha: mnemônico, pseudo, diretiva, registrador, condição, syscall, SR, rótulo', () => {
  const at = (line, col, opts) => {
    const t = Lang.helpAt(line, col, opts);
    if (!t) return null;
    const c = IsaRef.card(ISA, t);
    return t.kind + ':' + t.key + (c ? '=' + c.title : '');
  };
  eq(at('        add     r1, r2, r3', 9), 'insn:add=ADD', 'no meio do mnemônico');
  eq(at('        add     r1, r2, r3', 11), 'insn:add=ADD', 'logo depois do mnemônico');
  eq(at('        ADD     r1, r2, r3', 8), 'insn:add=ADD', 'maiúsculas, início');
  eq(at('        add     r1, r2, r3', 17), 'register:r1=r1', 'registrador');
  eq(at('        add     r1, r2, r3', 18, { line: true }), 'register:r1=r1', 'fim do registrador');
  eq(at('        add     r1, r2, r3', 19, { line: true }), 'insn:add=ADD', 'vírgula: mnemônico da linha');
  eq(at('        add     r1, r2, r3', 19), null, 'vírgula sem fallback');
  eq(at('        li      t3, 5', 9), 'pseudo:li=li', 'pseudo');
  eq(at('        li      t3, 5', 17), 'register:t3=t3', 'apelido');
  eq(at('msg:    .asciz  "add r1"', 10), 'directive:.asciz=.asciz', 'diretiva');
  eq(at('msg:    .asciz  "add r1"', 19), null, 'dentro da string');
  eq(at('msg:    .asciz  "add r1"', 19, { line: true }), 'directive:.asciz=.asciz', 'string: diretiva da linha');
  eq(at('        beq     fim', 9), 'branch:beq=beq', 'condição');
  eq(at('        b.ge    fim', 10), 'branch:b.ge=b.ge', 'condição com ponto');
  eq(at('        bcs     fim', 9), 'branch:bcs=bcs', 'apelido de condição');
  eq(at('        beq     fim', 17), 'label:fim', 'rótulo (operando)');
  eq(at('loop:   b       loop', 2), 'label:loop', 'rótulo (definição)');
  eq(at('loop:   b       loop', 8), 'pseudo:b=b', '"b" mnemônico');
  eq(at('        syscall PUTS', 18), 'syscall:PUTS=syscall PUTS', 'syscall pelo nome');
  eq(at('        syscall PUTS', 10), 'insn:syscall=SYSCALL', 'a instrução syscall');
  eq(at('        mfsr    r1, ISA_VERSION', 22), 'sr:ISA_VERSION=ISA_VERSION', 'registrador especial');
  eq(at('        movi    r1, 0x1F', 22), 'number:0x1F', 'número');
  eq(at('        nop     ; add aqui', 18), null, 'comentário');
  eq(at('        nop     ; add aqui', 18, { line: true }), 'insn:nop=NOP', 'comentário: instrução da linha');
  eq(at('        bogus   r1', 9), null, 'mnemônico desconhecido');
  eq(at('', 0, { line: true }), null, 'linha vazia');
});

/* ---- DOM ---- */

test('renderCard e renderTip: texto, código, codificação, botões', () => {
  const doc = new FDoc();
  const c = IsaRef.card(ISA, { kind: 'insn', key: 'fcmp' });
  const calls = [];
  const el = IsaRef.renderCard(doc, c, { onInsert: (t) => calls.push(['ins', t]), onCopy: (t) => calls.push(['cp', t]), onRef: (r) => calls.push(['ref', r.section + '/' + r.key]) });
  const text = el.textContent;
  for (const s of ['FCMP', 'fcmp ra, rb', c.summary.replace(/`/g, ''), c.encoding.text, 'Exemplo', 'Inserir no editor', 'Copiar', 'Ver na referência']) ok(text.includes(s), 'ficha contém ' + s);
  ok(el.tag('code').some((n) => n.textContent === '0x5'), 'crases viram <code>');
  ok(el.cls('kflag').filter((n) => / on /.test(' ' + n.className + ' ')).length === 4, 'quatro flags ligadas');
  const enc = el.cls('enc')[0];
  eq(enc.getAttribute('role'), 'img');
  eq(enc.cls('enc-f').length, 5, 'campos do formato R');
  eq(enc.cls('enc-f')[0].style.flexGrow, '9', 'func9 com largura 9');
  for (const b of el.tag('button')) b.click();
  eq(calls.map((x) => x[0]), ['ins', 'cp', 'ref']);
  eq(calls[0][1], c.example);
  eq(calls[2][1], 'insn/fcmp');
  const tip = IsaRef.renderTip(doc, IsaRef.card(ISA, { kind: 'insn', key: 'movil' }), { onRef: () => {} });
  for (const s of ['MOVIL', 'movil rd, imm32', 'codificação', 'formato L, 8 bytes, opcode 0x03', 'flags', 'não altera', 'ver na referência']) ok(tip.textContent.includes(s), 'tooltip contém ' + s);
  const l = IsaRef.renderCard(doc, IsaRef.card(ISA, { kind: 'insn', key: 'movil' }));
  eq(l.cls('enc-word').length, 2, 'formato L: duas palavras');
  eq(l.tag('button').length, 0, 'sem callbacks, sem botões');
});

test('referência: tabela com todas as instruções, th scope, expansão, inserir exemplo', () => {
  const doc = new FDoc();
  const root = doc.createElement('div');
  const ins = [];
  const ref = new IsaRef.Reference(root, { doc, isa: ISA, onInsert: (t) => ins.push(t), onCopy: () => {} });
  const table = root.cls('ref-insns')[0];
  ok(table, 'tabela de instruções');
  const heads = table.tag('thead')[0].tag('th');
  eq(heads.map((th) => th.textContent), ['Mnemônico', 'Opcode', 'Formato', 'Sintaxe', 'Flags', 'Resumo']);
  ok(heads.every((th) => th.getAttribute('scope') === 'col'), 'th scope=col');
  const rows = table.tag('tbody')[0].children;
  eq(rows.length, ISA.instructions.length, 'uma linha por instrução');
  ok(rows.every((r) => r.children[0].tagName === 'TH' && r.children[0].getAttribute('scope') === 'row'), 'th scope=row');
  eq(rows.map((r) => r.getAttribute('data-key')), ISA.instructions.slice().sort((a, b) => a.opcode - b.opcode).map((i) => i.mnemonic), 'todas, por opcode');
  eq(rows[0].children[1].textContent, '0x00');
  eq(root.cls('ref-count')[0].textContent, ISA.instructions.length + ' instruções');
  /* expandir a linha do add */
  const addBtn = ref.rowButtons.get('add');
  eq(addBtn.getAttribute('aria-expanded'), 'false');
  addBtn.click();
  const addBtn2 = ref.rowButtons.get('add');
  eq(addBtn2.getAttribute('aria-expanded'), 'true', 'aria-expanded');
  const cardRow = root.cls('ref-card-row');
  eq(cardRow.length, 1, 'uma ficha aberta');
  const sib = cardRow[0].parentNode.childNodes;
  eq(sib[sib.indexOf(cardRow[0]) - 1].getAttribute('data-key'), 'add', 'logo abaixo da linha');
  eq(cardRow[0].getAttribute('id'), addBtn2.getAttribute('aria-controls'), 'aria-controls');
  const card = cardRow[0].cls('kcard')[0];
  ok(card.textContent.includes('Z = resultado zero') && card.cls('enc').length === 1, 'detalhe e campos de bits');
  card.all((n) => n.getAttribute('data-act') === 'insert')[0].click();
  eq(ins, [ISA.instructions.find((i) => i.mnemonic === 'add').example], 'inserir no editor');
  /* clicar na linha (fora do botão) fecha */
  ref.rowButtons.get('add').parentNode.parentNode.dispatch('click');
  eq(root.cls('ref-card-row').length, 0, 'fechou');
});

test('referência: busca, filtros, ordenação e estado das fichas abertas', () => {
  const doc = new FDoc();
  const root = doc.createElement('div');
  const ref = new IsaRef.Reference(root, { doc, isa: ISA });
  const rowsKeys = () => root.cls('ref-row').map((r) => r.getAttribute('data-key'));
  ref.q.value = 'fcmp';
  ref.q.dispatch('input');
  eq(rowsKeys()[0], 'fcmp', 'busca fcmp: a instrução primeiro');
  ref.q.value = '0xB1';
  ref.q.dispatch('input');
  eq(rowsKeys(), ['fcmp'], 'busca pelo opcode');
  eq(root.cls('ref-count')[0].textContent, '1 de ' + ISA.instructions.length + ' instruções');
  ref.q.dispatch('keydown', { key: 'Enter' });
  eq(root.cls('ref-card-row').length, 1, 'Enter com um resultado abre a ficha');
  ref.q.value = 'zzzz';
  ref.q.dispatch('input');
  ok(root.textContent.includes('Nenhuma instrução'), 'busca vazia');
  ref.q.value = '';
  ref.group.value = 'controle';
  ref.group.dispatch('change');
  eq(rowsKeys(), ['jmp', 'jmpr', 'bcond', 'call', 'callr', 'ret']);
  ref.sort.value = 'name';
  ref.sort.dispatch('change');
  eq(rowsKeys(), ['bcond', 'call', 'callr', 'jmp', 'jmpr', 'ret']);
  ref.format.value = 'J';
  ref.format.dispatch('change');
  eq(rowsKeys(), ['call', 'jmp']);
  /* show() limpa os filtros quando a ficha está escondida por eles */
  ok(ref.show({ kind: 'insn', key: 'fcmp' }), 'show fcmp');
  eq([ref.q.value, ref.group.value, ref.format.value], ['', '', ''], 'filtros limpos');
  eq(root.cls('ref-card-row').map((r) => r.cls('kcard')[0].getAttribute('data-key')), ['fcmp'], 'fcmp aberta');
  ok(doc.activeElement === ref.rowButtons.get('fcmp'), 'foco na linha');
});

test('referência: todas as seções, show() posicionado e mapa de opcodes', () => {
  const doc = new FDoc();
  const root = doc.createElement('div');
  const ref = new IsaRef.Reference(root, { doc, isa: ISA });
  const tabs = root.all((n) => n.getAttribute('role') === 'tab');
  eq(tabs.length, IsaRef.SECTIONS.length, 'uma aba por seção');
  const expectRows = { cond: 16, pseudo: ISA.pseudos.length + ISA.shortForms.length + 0, directive: ISA.directives.length, reg: ISA.regDocs.length, sr: 4, flag: 4, fault: ISA.faults.length, syscall: ISA.syscalls.length + ISA.syscallErrors.length };
  for (const [k] of IsaRef.SECTIONS) {
    tabs.find((t) => t.getAttribute('data-section') === k).click();
    eq(ref.section, k);
    eq(tabs.find((t) => t.getAttribute('data-section') === k).getAttribute('aria-selected'), 'true', k + ' selecionada');
    ok(root.cls('ref-body')[0].childNodes.length > 0, k + ' renderiza');
    if (expectRows[k] !== undefined) eq(root.cls('ref-row').length, expectRows[k], k + ': linhas');
    for (const t of root.tag('table')) ok(t.tag('th').every((th) => th.getAttribute('scope')), k + ': th com scope');
  }
  /* condição: CS abre HS, com a ficha do desvio */
  ok(ref.show({ kind: 'branch', key: 'bcs' }), 'show bcs');
  eq(ref.section, 'cond');
  const open = root.cls('ref-card-row');
  eq(open.length, 1);
  ok(open[0].textContent.includes('C=1'), 'ficha de HS/CS');
  ok(ref.show({ kind: 'register', key: 't5' }) && ref.section === 'reg', 'registrador');
  ok(root.cls('ref-card-row')[0].textContent.includes('caller-saved'), 'ficha r5-r15');
  ok(ref.show({ kind: 'syscall', key: 'PUTC' }) && root.cls('ref-card-row')[0].textContent.includes('r1 = byte'), 'syscall');
  ok(ref.show({ kind: 'directive', key: '.word' }) && ref.section === 'directive', 'diretiva');
  ok(ref.show({ kind: 'sr', key: 'FLAGS' }) && ref.section === 'sr', 'SR');
  eq(ref.show({ kind: 'label', key: 'x' }), false, 'rótulo não tem ficha');
  /* mapa de opcodes */
  ref.setSection('opmap');
  const cells = root.all((n) => n.getAttribute('role') === 'gridcell');
  eq(cells.length, 256, '16 x 16');
  eq(cells.filter((c) => c.getAttribute('tabindex') === '0').length, 1, 'tabindex itinerante');
  const c30 = cells.find((c) => c.getAttribute('data-op') === '48');
  eq([c30.textContent, c30.className], ['add', 'op-usado']);
  ok(c30.title.includes('0x30') && c30.title.includes('ADD'), 'hover mostra o mnemônico');
  eq(cells[0xFF].className, 'op-invalido');
  cells[0].dispatch('keydown', { key: 'ArrowRight' });
  eq(cells[1].getAttribute('tabindex'), '0', 'seta move o foco');
  c30.click();
  eq([ref.section, root.cls('ref-card-row').length], ['insn', 1], 'clique abre a ficha');
  /* nenhum innerHTML no código (o DOM falso também lança se usado) */
  ok(!/[.]innerHTML/.test(fs.readFileSync(path.join(__dirname, '../web/isaref.js'), 'utf8')), 'isaref.js sem innerHTML');
});

console.log('test_isaref: ' + total + ' casos, ' + failed + ' falhas');
process.exit(failed ? 1 : 0);
