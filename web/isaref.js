/*
 * isaref.js — fichas da ISA (ajuda ao cursor, tooltip) e a referência da
 * ISA da IDE. Os dados vêm de isa.json (KSWEB_ISA, gerado por tools/mkisa.js
 * a partir do isa.def e de tools/isa-doc.md).
 *
 * Funções puras (testadas em Node, test/test_isaref.js):
 *   IsaRef.filterInsns(isa, {q, group, format, sort})  busca/filtro/ordenação
 *   IsaRef.filterRows(rows, q, text)    filtro genérico das outras seções
 *   IsaRef.card(isa, target)            target {kind, key} -> ficha normalizada
 *   IsaRef.refTarget(isa, target)       {section, key} da ficha na referência
 *   IsaRef.opcodeCells(isa)             as 256 células do mapa de opcodes
 *   IsaRef.norm(texto)                  minúsculas sem acentos (busca)
 * DOM (recebem o document, para rodar também num DOM falso nos testes;
 * todo texto entra por textContent, nunca innerHTML):
 *   IsaRef.renderCard(doc, card, opts)  ficha completa (painel Ajuda, referência)
 *   IsaRef.renderTip(doc, card, opts)   ficha compacta (tooltip do editor)
 *   IsaRef.renderEncoding(doc, enc)     desenho dos campos de bits
 *   new IsaRef.Reference(root, {doc, isa, onInsert, onCopy})
 *       .show(target) / .setSection(nome) / .focusSearch() / .section
 *
 * target.kind: insn | branch | pseudo | directive | register | sr | syscall |
 * cond | fault | label | number (as duas últimas são montadas pela IDE).
 */
(function (root) {
  'use strict';

  const norm = (s) => String(s === undefined || s === null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const hex2 = (n) => '0x' + n.toString(16).toUpperCase().padStart(2, '0');

  /* ---- índices por isa (WeakMap: o mesmo objeto, os mesmos mapas) ---- */
  const IDX = new WeakMap();
  function index(isa) {
    let x = IDX.get(isa);
    if (x) return x;
    x = {
      insn: new Map(isa.instructions.map((i) => [i.mnemonic, i])),
      byOp: new Map(isa.instructions.map((i) => [i.opcode, i])),
      branch: new Map((isa.branches || []).map((b) => [b.mnemonic, b])),
      pseudo: new Map((isa.pseudos || []).map((p) => [p.mnemonic, p])),
      directive: new Map((isa.directives || []).map((d) => [d.name, d])),
      register: new Map((isa.registers || []).map((r) => [r.name, r])),
      regDoc: new Map((isa.regDocs || []).map((r) => [r.key, r])),
      sr: new Map((isa.specialRegs || []).map((s) => [s.name.toLowerCase(), s])),
      syscall: new Map((isa.syscalls || []).map((s) => [s.name.toLowerCase(), s])),
      cond: new Map((isa.conds || []).map((c) => [c.name.toLowerCase(), c])),
      fault: new Map((isa.faults || []).map((f) => [f.name.toLowerCase(), f])),
      group: new Map((isa.groups || []).map((g) => [g.key, g.label])),
      hay: new WeakMap()
    };
    IDX.set(isa, x);
    return x;
  }

  /* ---- busca ---- */

  function insnHay(isa, i) {
    const x = index(isa);
    let s = x.hay.get(i);
    if (s === undefined) {
      const h = i.opcode.toString(16).padStart(2, '0');
      s = norm([i.mnemonic, h, '0x' + h, 'formato ' + i.format, i.group, x.group.get(i.group), i.syntax,
        (i.syntaxAll || []).join(' '), i.summary, (i.detail || []).join(' '), i.desc, i.flagsText,
        i.immForm, i.long, i.indexed].filter(Boolean).join(' \u0001 '));
      x.hay.set(i, s);
    }
    return s;
  }

  function insnMatches(isa, i, t) {
    const m = /^0x([0-9a-f]{1,2})$/.exec(t);
    if (m) return i.opcode.toString(16).padStart(2, '0').startsWith(m[1]);
    return insnHay(isa, i).includes(t);
  }

  /*
   * Instruções que casam com a busca (todas as palavras, sem acento nem
   * maiúsculas: mnemônico, opcode "0x30"/"30"/"0x3", formato, grupo, sintaxe,
   * resumo, detalhe), o grupo e o formato. Ordem: mnemônico igual à busca,
   * depois mnemônicos que começam com ela, depois o resto; dentro de cada
   * faixa, por opcode (padrão) ou por nome (sort: 'name').
   */
  function filterInsns(isa, o) {
    o = o || {};
    const toks = norm(o.q).split(/\s+/).filter(Boolean);
    let list = isa.instructions.filter((i) => (!o.group || i.group === o.group) && (!o.format || i.format === o.format));
    if (toks.length) list = list.filter((i) => toks.every((t) => insnMatches(isa, i, t)));
    const first = toks.length === 1 ? toks[0] : null;
    const rank = (i) => (!first ? 0 : i.mnemonic === first ? 0 : i.mnemonic.startsWith(first) ? 1 : 2);
    const cmp = o.sort === 'name' ? (a, b) => (a.mnemonic < b.mnemonic ? -1 : a.mnemonic > b.mnemonic ? 1 : 0) : (a, b) => a.opcode - b.opcode;
    return list.slice().sort((a, b) => rank(a) - rank(b) || cmp(a, b));
  }

  /* Filtro genérico: todas as palavras de q aparecem em text(row). */
  function filterRows(rows, q, text) {
    const toks = norm(q).split(/\s+/).filter(Boolean);
    if (!toks.length) return rows.slice();
    return rows.filter((r) => { const s = norm(text(r)); return toks.every((t) => s.includes(t)); });
  }

  /* ---- mapa de opcodes ---- */

  const OP_STATE_TEXT = {
    usado: 'ocupado', livre: 'livre', removido: 'removido', reservado: 'reservado', plataforma: 'plataforma', 'inválido': 'inválido'
  };

  function opcodeCells(isa) {
    const x = index(isa);
    const out = [];
    for (let op = 0; op < 256; op++) {
      const i = x.byOp.get(op);
      if (i) { out.push({ op, state: 'usado', mnemonic: i.mnemonic, group: i.group, summary: i.summary || i.desc }); continue; }
      const r = (isa.opRanges || []).find((g) => op >= g.from && op <= g.to);
      if (r) out.push({ op, state: r.state, summary: r.summary });
      else out.push({ op, state: 'livre', summary: 'Livre: nenhuma instrução na v2.0; executar dá fault BAD_OPCODE.' });
    }
    return out;
  }

  /* ---- fichas ---- */

  function flagsLine(list) { return list && list.length ? list.join(' ') : 'nenhuma'; }

  function regRange(isa, d) {
    const names = (isa.registers || []).filter((r) => r.alias && r.index >= d.from && r.index <= d.to).map((r) => r.name);
    if (!names.length) return '';
    return names.length === 1 ? names[0] : names[0] + '…' + names[names.length - 1];
  }

  /*
   * Ficha normalizada: {kind, key, title, badges[], syntax[], summary,
   * detail[], extra[[rótulo, texto]], flags?, encoding?, example?, ref}.
   * null se o alvo não existe.
   */
  function card(isa, t) {
    if (!isa || !t) return null;
    const x = index(isa);
    const k = String(t.key === undefined ? '' : t.key);
    const lk = k.toLowerCase();
    let c = null;
    switch (t.kind) {
      case 'insn': {
        const i = x.insn.get(lk);
        if (!i) return null;
        if (i.mnemonic === 'bcond') {
          c = { title: 'BCOND (b<cond>)' };
        } else c = { title: i.mnemonic.toUpperCase() };
        Object.assign(c, {
          badges: [hex2(i.opcode), 'formato ' + i.format, i.len + ' bytes', x.group.get(i.group) || i.group || ''].filter(Boolean),
          syntax: i.syntaxAll || [i.syntax || i.signature], summary: i.summary || i.desc, detail: i.detail || [],
          flags: i.flagsList || [], encoding: i.encoding, example: i.example, extra: []
        });
        if (i.immForm) c.extra.push(['Com imediato', i.immForm]);
        if (i.long) c.extra.push(['Forma longa', i.long]);
        if (i.indexed) c.extra.push(['Com [rb + rc]', i.indexed]);
        break;
      }
      case 'branch': {
        const b = x.branch.get(lk);
        if (!b) return null;
        c = {
          title: b.mnemonic, badges: [hex2(b.opcode), 'formato B', 'cond ' + b.code + (b.cond ? ' (' + b.cond + ')' : ''), 'Controle de fluxo'],
          syntax: [b.syntax || b.signature], summary: b.summary || b.desc, detail: b.detail || [], flags: [],
          encoding: b.encoding, example: b.example, extra: []
        };
        const cd = x.cond.get(String(b.cond).toLowerCase());
        if (cd) c.extra.push(['Testa', cd.tests], ['Depois de CMP', cd.int], ['Depois de FCMP', cd.float]);
        break;
      }
      case 'cond': {
        const cd = x.cond.get(lk);
        if (!cd) return null;
        return card(isa, { kind: 'branch', key: 'b' + cd.name.toLowerCase() });
      }
      case 'pseudo': {
        const p = x.pseudo.get(lk);
        if (!p) return null;
        c = {
          title: p.mnemonic, badges: ['pseudo-instrução'], syntax: p.syntaxAll || [p.syntax || p.signature],
          summary: p.summary || p.desc, detail: p.detail || [], example: p.example, extra: [['Expande para', p.expands || p.desc]]
        };
        break;
      }
      case 'directive': {
        const d = x.directive.get(lk);
        if (!d) return null;
        c = {
          title: d.name, badges: ['diretiva'], syntax: d.syntaxAll || [(d.name + ' ' + (d.args || '')).trim()],
          summary: d.summary || d.desc, detail: d.detail || [], example: d.example, extra: []
        };
        break;
      }
      case 'register': {
        const r = x.register.get(lk);
        if (!r) return null;
        const d = x.regDoc.get(r.doc) || {};
        const canon = r.index === 0 ? 'zr' : r.index === 30 ? 'fp' : r.index === 31 ? 'sp' : 'r' + r.index;
        const others = (isa.registers || []).filter((y) => y.index === r.index && y.name !== r.name).map((y) => y.name);
        c = {
          title: r.name, badges: ['R' + r.index].concat(others.length ? ['= ' + others.join(', ')] : []), syntax: [],
          summary: d.summary || r.desc, detail: d.detail || [],
          extra: [['ABI (kscc)', d.abi || ''], ['Preservado por', d.preserve || '']].filter((e) => e[1])
        };
        c.key = canon;
        break;
      }
      case 'sr': {
        const s = x.sr.get(lk);
        if (!s) return null;
        c = {
          title: s.name, badges: ['registrador especial ' + s.num], syntax: ['mfsr rd, ' + s.name].concat(s.name === 'FLAGS' ? ['mtsr FLAGS, rb'] : []),
          summary: s.summary || s.desc, detail: s.detail || [], extra: [['Acesso', s.access || '']].filter((e) => e[1])
        };
        break;
      }
      case 'syscall': {
        const s = x.syscall.get(lk);
        if (!s) return null;
        c = {
          title: 'syscall ' + s.name, badges: [hex2(s.num), 'grupo ' + s.group + ': ' + s.groupName],
          syntax: ['syscall ' + s.name], summary: s.summary || s.desc, detail: s.detail || [],
          extra: [['Argumentos', s.args || ''], ['Retorno', s.ret || '']].filter((e) => e[1])
        };
        break;
      }
      case 'fault': {
        const f = x.fault.get(lk);
        if (!f) return null;
        c = {
          title: 'fault ' + f.name, badges: ['código ' + f.code, 'saída ' + f.exit], syntax: [], summary: f.summary,
          detail: f.detail || [], extra: [['fault_addr', f.addr || '']].filter((e) => e[1])
        };
        break;
      }
      default:
        return null;
    }
    c.kind = t.kind === 'cond' ? 'branch' : t.kind;
    if (c.key === undefined) c.key = t.kind === 'insn' || t.kind === 'branch' || t.kind === 'pseudo' || t.kind === 'directive' ? lk : k;
    c.ref = refTarget(isa, { kind: c.kind, key: c.key });
    return c;
  }

  /* Onde a ficha aparece na referência: {section, key} ou null. */
  function refTarget(isa, t) {
    if (!isa || !t) return null;
    const x = index(isa);
    const lk = String(t.key === undefined ? '' : t.key).toLowerCase();
    switch (t.kind) {
      case 'insn': return x.insn.has(lk) ? { section: 'insn', key: lk } : null;
      case 'branch': { const b = x.branch.get(lk); if (!b) return null; const c = x.cond.get(String(b.cond).toLowerCase()); return { section: 'cond', key: (c && c.aliasOf ? c.aliasOf : b.cond).toLowerCase() }; }
      case 'cond': { const c = x.cond.get(lk); return c ? { section: 'cond', key: (c.aliasOf || c.name).toLowerCase() } : null; }
      case 'pseudo': return x.pseudo.has(lk) ? { section: 'pseudo', key: lk } : null;
      case 'directive': return x.directive.has(lk) ? { section: 'directive', key: lk } : null;
      case 'register': { const r = x.register.get(lk); return r ? { section: 'reg', key: r.doc } : null; }
      case 'sr': return x.sr.has(lk) ? { section: 'sr', key: lk } : null;
      case 'syscall': return x.syscall.has(lk) ? { section: 'syscall', key: lk } : null;
      case 'fault': return x.fault.has(lk) ? { section: 'fault', key: lk } : null;
      default: return null;
    }
  }

  /* ---- DOM ---- */

  function mk(doc) {
    return function h(tag, attrs, ...kids) {
      const e = doc.createElement(tag);
      for (const k in attrs || {}) {
        const v = attrs[k];
        if (v === false || v === null || v === undefined) continue;
        if (k === 'class') e.className = v;
        else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
        else e.setAttribute(k, v === true ? '' : String(v));
      }
      for (const c of kids) {
        if (c === null || c === undefined || c === false) continue;
        e.appendChild(typeof c === 'string' ? doc.createTextNode(c) : c);
      }
      return e;
    };
  }

  /* Texto com `código` entre crases -> nós (code para os trechos). */
  function inline(doc, text, into) {
    const parts = String(text || '').split('`');
    parts.forEach((p, i) => {
      if (!p) return;
      if (i % 2) { const c = doc.createElement('code'); c.textContent = p; into.appendChild(c); }
      else into.appendChild(doc.createTextNode(p));
    });
    return into;
  }

  /* Campos de bits: uma faixa por palavra, largura proporcional aos bits. */
  function renderEncoding(doc, enc, opts) {
    const h = mk(doc);
    opts = opts || {};
    const box = h('div', { class: 'enc', role: 'img', 'aria-label': opts.label || enc.text || '' });
    const words = [enc.fields.filter((f) => !f.word), enc.fields.filter((f) => f.word)];
    words.forEach((fields, w) => {
      if (!fields.length) return;
      const row = h('div', { class: 'enc-word' + (w ? ' enc-w2' : ''), 'aria-hidden': 'true' });
      for (const f of fields) {
        const bits = f.hi - f.lo + 1;
        const value = opts.names ? f.name : f.value;
        const cell = h('div', { class: 'enc-f' + (f.name === 'opcode' ? ' enc-op' : value === '0' ? ' enc-zero' : '') },
          h('span', { class: 'enc-bits' }, f.hi === f.lo ? String(f.hi) : f.hi + '–' + f.lo),
          h('span', { class: 'enc-name' }, f.name),
          opts.names ? null : h('span', { class: 'enc-val' }, value));
        cell.style.flexGrow = String(bits);
        cell.title = f.name + ' (bits ' + f.hi + '–' + f.lo + (w ? ' da 2ª palavra' : '') + ')' + (opts.names ? '' : ' = ' + value);
        row.appendChild(cell);
      }
      if (w) row.insertBefore(h('div', { class: 'enc-tag' }, '+4'), row.firstChild);
      box.appendChild(row);
    });
    return box;
  }

  function flagChips(doc, list) {
    const h = mk(doc);
    const box = h('span', { class: 'kflags', 'aria-label': 'altera ' + (list.length ? list.join(', ') : 'nenhuma flag') });
    for (const f of ['Z', 'N', 'C', 'V']) box.appendChild(h('span', { class: 'kflag' + (list.includes(f) ? ' on' : ''), 'aria-hidden': 'true' }, f));
    if (!list.length) box.appendChild(h('span', { class: 'kflags-none' }, ' não altera flags'));
    return box;
  }

  /*
   * Ficha completa. opts: {onRef(ref), onInsert(text), onCopy(text),
   * headingLevel, idPrefix}. Sem os callbacks, os botões não aparecem.
   */
  function renderCard(doc, c, opts) {
    const h = mk(doc);
    opts = opts || {};
    const art = h('article', { class: 'kcard', 'data-kind': c.kind, 'data-key': c.key });
    const head = h('div', { class: 'kcard-head' }, h('h' + (opts.headingLevel || 3), { class: 'kcard-title' }, c.title));
    if (c.badges && c.badges.length) {
      const b = h('span', { class: 'kcard-badges' });
      for (const t of c.badges) b.appendChild(h('span', { class: 'badge' }, t));
      head.appendChild(b);
    }
    art.appendChild(head);
    if (c.syntax && c.syntax.length) {
      const s = h('div', { class: 'kcard-syntax', 'aria-label': 'sintaxe' });
      for (const t of c.syntax) s.appendChild(h('code', {}, t));
      art.appendChild(s);
    }
    if (c.summary) art.appendChild(inline(doc, c.summary, h('p', { class: 'kcard-summary' })));
    if (c.detail && c.detail.length) {
      const ul = h('ul', { class: 'kcard-detail' });
      for (const d of c.detail) ul.appendChild(inline(doc, d, h('li', {})));
      art.appendChild(ul);
    }
    const dl = h('dl', { class: 'kcard-extra' });
    if (c.flags) dl.append(h('dt', {}, 'Flags'), h('dd', {}, flagChips(doc, c.flags)));
    for (const [k, v] of c.extra || []) dl.append(h('dt', {}, k), inline(doc, v, h('dd', {})));
    if (c.encoding) dl.append(h('dt', {}, 'Codificação'), h('dd', {}, h('div', { class: 'kcard-enctext' }, c.encoding.text)));
    if (dl.childNodes.length) art.appendChild(dl);
    if (c.encoding) art.appendChild(renderEncoding(doc, c.encoding));
    if (c.example) {
      const ex = h('div', { class: 'kcard-example' }, h('span', { class: 'kcard-label' }, 'Exemplo'), h('code', { class: 'kcard-excode' }, c.example));
      const acts = h('span', { class: 'kcard-acts' });
      if (opts.onInsert) acts.appendChild(h('button', { type: 'button', class: 'small', 'data-act': 'insert', title: 'Insere o exemplo numa linha nova abaixo do cursor', onclick: () => opts.onInsert(c.example) }, 'Inserir no editor'));
      if (opts.onCopy) acts.appendChild(h('button', { type: 'button', class: 'small', 'data-act': 'copy', title: 'Copia o exemplo', onclick: () => opts.onCopy(c.example) }, 'Copiar'));
      if (acts.childNodes.length) ex.appendChild(acts);
      art.appendChild(ex);
    }
    if (opts.onRef && c.ref) {
      art.appendChild(h('p', { class: 'kcard-links' },
        h('button', { type: 'button', class: 'link', 'data-act': 'ref', title: 'Abre a referência da ISA nesta ficha (Ctrl+Shift+H)', onclick: () => opts.onRef(c.ref) }, 'Ver na referência →')));
    }
    return art;
  }

  /* Ficha compacta para o tooltip: título, sintaxe, resumo, codificação e flags. */
  function renderTip(doc, c, opts) {
    const h = mk(doc);
    opts = opts || {};
    const box = h('div', { class: 'ks-hover ktip', 'data-kind': c.kind });
    const t = h('div', { class: 't' }, c.title);
    if (c.badges && c.badges.length) t.appendChild(h('span', { class: 'ktip-badges' }, '  ' + c.badges.slice(0, 3).join(' · ')));
    box.appendChild(t);
    for (const s of (c.syntax || []).slice(0, 3)) box.appendChild(h('div', { class: 'sig' }, s));
    if (c.summary) box.appendChild(inline(doc, c.summary, h('div', { class: 'd' })));
    const rows = [];
    if (c.encoding) rows.push(['codificação', c.encoding.text]);
    if (c.flags) rows.push(['flags', c.flags.length ? c.flags.join(' ') : 'não altera']);
    for (const [k, v] of (c.extra || []).slice(0, 3)) rows.push([k, v]);
    if (rows.length) {
      const tb = h('table', { class: 'ktip-rows' });
      for (const [k, v] of rows) tb.appendChild(h('tr', {}, h('td', { class: 'k' }, k), inline(doc, v, h('td', {}))));
      box.appendChild(tb);
    }
    if (opts.onRef && c.ref) {
      box.appendChild(h('div', { class: 'ktip-foot' },
        h('button', { type: 'button', class: 'link', 'data-act': 'ref', onmousedown: (e) => e.preventDefault(), onclick: () => opts.onRef(c.ref) }, 'ver na referência'),
        h('span', { class: 'muted' }, opts.hint ? '  ' + opts.hint : '')));
    }
    return box;
  }

  /* ---- a referência ---- */

  const SECTIONS = [
    ['insn', 'Instruções'], ['opmap', 'Mapa de opcodes'], ['cond', 'Condições (Bcc)'], ['pseudo', 'Pseudo-instruções'],
    ['directive', 'Diretivas'], ['reg', 'Registradores'], ['sr', 'Registradores especiais'], ['flag', 'Flags'],
    ['format', 'Formatos'], ['fault', 'Faults'], ['syscall', 'Syscalls']
  ];

  class Reference {
    constructor(rootEl, o) {
      this.root = rootEl;
      this.doc = o.doc || rootEl.ownerDocument;
      this.isa = o.isa;
      this.opts = o;
      this.h = mk(this.doc);
      this.section = 'insn';
      this.expanded = {};
      for (const [k] of SECTIONS) this.expanded[k] = new Set();
      this.rowButtons = new Map();     /* key -> botão da linha (seção atual) */
      this._build();
      this.setSection('insn');
    }

    _build() {
      const h = this.h;
      this.navButtons = new Map();
      const nav = h('div', { class: 'ref-nav', role: 'tablist', 'aria-label': 'Seções da referência', 'aria-orientation': 'vertical' });
      for (const [k, label] of SECTIONS) {
        const b = h('button', { type: 'button', role: 'tab', id: 'ref-tab-' + k, 'aria-selected': 'false', 'aria-controls': 'ref-body', 'data-section': k, tabindex: '-1' }, label);
        b.addEventListener('click', () => this.setSection(k));
        b.addEventListener('keydown', (e) => this._navKey(e, k));
        nav.appendChild(b);
        this.navButtons.set(k, b);
      }
      this.q = h('input', { type: 'search', class: 'ref-q', placeholder: 'Buscar (mnemônico, opcode, palavra)…', 'aria-label': 'Buscar na referência', spellcheck: 'false', autocomplete: 'off' });
      this.q.addEventListener('input', () => this._renderBody());
      this.q.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && this.q.value) { this.q.value = ''; this._renderBody(); e.preventDefault(); e.stopPropagation(); }
        else if (e.key === 'ArrowDown' || e.key === 'Enter') {
          const first = this.rowButtons.values().next().value;
          if (first) { e.preventDefault(); if (e.key === 'Enter' && this.rowButtons.size === 1) first.click(); first.focus(); }
        }
      });
      const sel = (label, cls, options) => {
        const s = h('select', { class: cls, 'aria-label': label });
        for (const [v, t] of options) s.appendChild(h('option', { value: v }, t));
        s.addEventListener('change', () => this._renderBody());
        return s;
      };
      this.group = sel('Filtrar por grupo', 'ref-group', [['', 'todos os grupos']].concat((this.isa.groups || []).map((g) => [g.key, g.label])));
      this.format = sel('Filtrar por formato', 'ref-format', [['', 'todos os formatos'], ['R', 'formato R'], ['I', 'formato I'], ['L', 'formato L'], ['B', 'formato B'], ['J', 'formato J']]);
      this.sort = sel('Ordenar', 'ref-sort', [['opcode', 'por opcode'], ['name', 'por nome']]);
      this.count = h('span', { class: 'ref-count muted', 'aria-live': 'polite' });
      this.insnTools = h('span', { class: 'ref-insn-tools' }, this.group, this.format, this.sort);
      const tools = h('div', { class: 'ref-tools' }, this.q, this.insnTools, this.count);
      this.body = h('div', { class: 'ref-body', id: 'ref-body', role: 'tabpanel', tabindex: '-1' });
      this.main = h('div', { class: 'ref-main' }, tools, this.body);
      const wrap = h('div', { class: 'ref' }, nav, this.main);
      if (this.root.replaceChildren) this.root.replaceChildren(wrap);
      else { this.root.textContent = ''; this.root.appendChild(wrap); }
    }

    _navKey(e, k) {
      const keys = SECTIONS.map((s) => s[0]);
      let i = keys.indexOf(k);
      if (e.key === 'ArrowDown' || e.key === 'ArrowRight') i = (i + 1) % keys.length;
      else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') i = (i - 1 + keys.length) % keys.length;
      else if (e.key === 'Home') i = 0;
      else if (e.key === 'End') i = keys.length - 1;
      else return;
      e.preventDefault();
      this.setSection(keys[i]);
      this.navButtons.get(keys[i]).focus();
    }

    setSection(k) {
      if (!this.expanded[k]) k = 'insn';
      this.section = k;
      for (const [s, b] of this.navButtons) {
        b.setAttribute('aria-selected', s === k ? 'true' : 'false');
        b.setAttribute('tabindex', s === k ? '0' : '-1');
      }
      this.body.setAttribute('aria-labelledby', 'ref-tab-' + k);
      this.insnTools.hidden = k !== 'insn';
      this.q.hidden = k === 'opmap' || k === 'format';
      this._renderBody();
    }

    focusSearch() {
      if (this.q.hidden) this.setSection('insn');
      this.q.focus();
      if (this.q.select) this.q.select();
    }

    /* Abre a seção da ficha, expande e rola até ela. false se não há onde. */
    show(t) {
      const r = t && (t.section ? t : refTarget(this.isa, t));
      if (!r) return false;
      this.setSection(r.section);
      if (r.key === undefined || r.key === null) return true;
      if (!this.rowButtons.has(r.key)) {
        this.q.value = '';
        this.group.value = '';
        this.format.value = '';
        this._renderBody();
      }
      if (!this.rowButtons.has(r.key)) return false;
      this.expanded[r.section].add(r.key);
      this._renderBody();
      const b = this.rowButtons.get(r.key);
      if (b) {
        if (b.scrollIntoView) b.scrollIntoView({ block: 'nearest' });
        b.focus();
      }
      return true;
    }

    _clear(el) { if (el.replaceChildren) el.replaceChildren(); else el.textContent = ''; }

    _renderBody() {
      this.rowButtons = new Map();
      this._clear(this.body);
      const fn = {
        insn: this._insn, opmap: this._opmap, cond: this._cond, pseudo: this._pseudo, directive: this._directive,
        reg: this._reg, sr: this._sr, flag: this._flag, format: this._format, fault: this._fault, syscall: this._syscall
      }[this.section];
      fn.call(this);
    }

    _setCount(n, total, what) {
      this.count.textContent = n === total ? total + ' ' + what : n + ' de ' + total + ' ' + what;
    }

    _cardOpts() {
      return { onInsert: this.opts.onInsert, onCopy: this.opts.onCopy, headingLevel: 4 };
    }

    /*
     * Tabela com linhas expansíveis. cols: [rótulo]; rows: [{key, cells:
     * [texto|nó], card?: () => ficha | nó}]. A primeira célula é <th
     * scope="row"> com um botão de abrir/fechar (aria-expanded).
     */
    _table(caption, cols, rows, cls) {
      const h = this.h;
      const sec = this.section;
      const t = h('table', { class: 'ref-table' + (cls ? ' ' + cls : '') });
      t.appendChild(h('caption', { class: 'sr-only' }, caption));
      const hr = h('tr', {});
      for (const c of cols) hr.appendChild(h('th', { scope: 'col' }, c));
      t.appendChild(h('thead', {}, hr));
      const tb = h('tbody', {});
      const buttons = [];
      for (const r of rows) {
        const tr = h('tr', { 'data-key': r.key });
        const open = !!r.card && this.expanded[sec].has(r.key);
        let first;
        if (r.card) {
          const id = 'ref-card-' + sec + '-' + String(r.key).replace(/[^\w-]/g, '_');
          const btn = h('button', { type: 'button', class: 'ref-x', 'aria-expanded': open ? 'true' : 'false', 'aria-controls': id }, h('span', { class: 'ref-caret', 'aria-hidden': 'true' }, open ? '▾ ' : '▸ '), r.cells[0]);
          btn.addEventListener('click', (e) => { e.stopPropagation(); this._toggle(sec, r.key); });
          btn.addEventListener('keydown', (e) => this._rowKey(e, buttons, btn));
          buttons.push(btn);
          this.rowButtons.set(r.key, btn);
          first = h('th', { scope: 'row' }, btn);
          tr.addEventListener('click', (e) => { if (e.target && e.target.closest && e.target.closest('button,a,input,select')) return; this._toggle(sec, r.key); });
          tr.className = 'ref-row expandable' + (open ? ' open' : '');
        } else {
          first = h('th', { scope: 'row' }, r.cells[0]);
          this.rowButtons.set(r.key, first);
          tr.className = 'ref-row';
        }
        tr.appendChild(first);
        for (const c of r.cells.slice(1)) tr.appendChild(h('td', {}, c));
        tb.appendChild(tr);
        if (open) {
          const content = r.card();
          const node = content && content.nodeType ? content : renderCard(this.doc, content, this._cardOpts());
          const id = 'ref-card-' + sec + '-' + String(r.key).replace(/[^\w-]/g, '_');
          tb.appendChild(h('tr', { class: 'ref-card-row', id }, h('td', { colspan: String(cols.length) }, node)));
        }
      }
      t.appendChild(tb);
      return t;
    }

    _toggle(sec, key) {
      const s = this.expanded[sec];
      if (s.has(key)) s.delete(key); else s.add(key);
      this._renderBody();
      const b = this.rowButtons.get(key);
      if (b && b.focus) b.focus();
    }

    _rowKey(e, buttons, btn) {
      const i = buttons.indexOf(btn);
      let j = -1;
      if (e.key === 'ArrowDown') j = Math.min(buttons.length - 1, i + 1);
      else if (e.key === 'ArrowUp') j = i - 1;
      else if (e.key === 'Home') j = 0;
      else if (e.key === 'End') j = buttons.length - 1;
      else return;
      e.preventDefault();
      if (j < 0) { this.q.focus(); return; }
      buttons[j].focus();
    }

    _code(text) { return this.h('code', {}, text); }
    _inline(text) { return inline(this.doc, text, this.h('span', {})); }

    _insn() {
      const isa = this.isa;
      const list = filterInsns(isa, { q: this.q.value, group: this.group.value, format: this.format.value, sort: this.sort.value });
      this._setCount(list.length, isa.instructions.length, 'instruções');
      const rows = list.map((i) => ({
        key: i.mnemonic,
        cells: [i.mnemonic, hex2(i.opcode), i.format, this._code(i.syntax || i.signature), flagChips(this.doc, i.flagsList || []), this._inline(i.summary || i.desc)],
        card: () => card(isa, { kind: 'insn', key: i.mnemonic })
      }));
      if (!rows.length) { this.body.appendChild(this.h('p', { class: 'muted ref-empty' }, 'Nenhuma instrução para essa busca.')); return; }
      this.body.appendChild(this._table('Instruções da ISA', ['Mnemônico', 'Opcode', 'Formato', 'Sintaxe', 'Flags', 'Resumo'], rows, 'ref-insns'));
    }

    _opmap() {
      const h = this.h;
      const cells = opcodeCells(this.isa);
      const used = cells.filter((c) => c.state === 'usado').length;
      this.count.textContent = used + ' opcodes ocupados de 256';
      const info = h('p', { class: 'ref-opinfo', 'aria-live': 'polite' }, 'Passe o mouse ou use as setas na grade; Enter abre a ficha.');
      const legend = h('p', { class: 'ref-legend' });
      for (const st of ['usado', 'livre', 'removido', 'reservado', 'plataforma', 'inválido']) {
        legend.appendChild(h('span', { class: 'op-' + st.replace('á', 'a') }, OP_STATE_TEXT[st]));
      }
      const t = h('table', { class: 'ref-opmap', role: 'grid', 'aria-label': 'Mapa de opcodes: linhas = dígito alto, colunas = dígito baixo' });
      const hr = h('tr', {}, h('th', { scope: 'col' }, ''));
      for (let c = 0; c < 16; c++) hr.appendChild(h('th', { scope: 'col' }, '_' + c.toString(16).toUpperCase()));
      t.appendChild(h('thead', {}, hr));
      const tb = h('tbody', {});
      const tds = [];
      const describe = (c) => hex2(c.op) + ' · ' + (c.mnemonic ? c.mnemonic.toUpperCase() + ' (' + c.group + ')' : OP_STATE_TEXT[c.state]) + ' — ' + c.summary;
      const focusCell = (i) => {
        for (const td of tds) td.setAttribute('tabindex', '-1');
        tds[i].setAttribute('tabindex', '0');
        tds[i].focus();
        info.textContent = describe(cells[i]);
      };
      for (let r = 0; r < 16; r++) {
        const tr = h('tr', {}, h('th', { scope: 'row' }, r.toString(16).toUpperCase() + '_'));
        for (let c = 0; c < 16; c++) {
          const cell = cells[r * 16 + c];
          const td = h('td', { class: 'op-' + cell.state.replace('á', 'a'), role: 'gridcell', tabindex: r === 0 && c === 0 ? '0' : '-1', 'data-op': String(cell.op), 'aria-label': describe(cell) }, cell.mnemonic || '');
          td.title = describe(cell);
          const i = r * 16 + c;
          td.addEventListener('mouseenter', () => { info.textContent = describe(cell); });
          td.addEventListener('focus', () => { info.textContent = describe(cell); });
          td.addEventListener('click', () => { if (cell.mnemonic) this.show({ kind: 'insn', key: cell.mnemonic }); else focusCell(i); });
          td.addEventListener('keydown', (e) => {
            let j = i;
            if (e.key === 'ArrowRight') j = Math.min(255, i + 1);
            else if (e.key === 'ArrowLeft') j = Math.max(0, i - 1);
            else if (e.key === 'ArrowDown') j = Math.min(255, i + 16);
            else if (e.key === 'ArrowUp') j = Math.max(0, i - 16);
            else if (e.key === 'Home') j = i - (i % 16);
            else if (e.key === 'End') j = i - (i % 16) + 15;
            else if ((e.key === 'Enter' || e.key === ' ') && cell.mnemonic) { e.preventDefault(); this.show({ kind: 'insn', key: cell.mnemonic }); return; }
            else return;
            e.preventDefault();
            focusCell(j);
          });
          tds.push(td);
          tr.appendChild(td);
        }
        tb.appendChild(tr);
      }
      t.appendChild(tb);
      this.body.append(legend, t, info);
      for (const g of this.isa.opRanges || []) {
        this.body.appendChild(h('p', { class: 'small muted' }, hex2(g.from) + (g.to !== g.from ? '–' + hex2(g.to) : '') + ' (' + OP_STATE_TEXT[g.state] + '): ' + g.summary));
      }
    }

    _cond() {
      const isa = this.isa;
      const base = (isa.conds || []).filter((c) => !c.aliasOf);
      const list = filterRows(base, this.q.value, (c) => [c.name, c.aliases.join(' '), 'b' + c.name, c.tests, c.int, c.float, c.summary].join(' '));
      this._setCount(list.length, base.length, 'condições');
      const rows = list.map((c) => {
        const names = [c.name].concat(c.aliases);
        const mn = names.map((n) => 'b' + n.toLowerCase()).concat(names.map((n) => 'b.' + n.toLowerCase())).join(' ');
        return {
          key: c.name.toLowerCase(),
          cells: [names.join(' / '), String(c.code), this._code(mn), c.tests, c.int, c.float],
          card: () => card(isa, { kind: 'branch', key: 'b' + c.name.toLowerCase() })
        };
      });
      this.body.appendChild(this.h('p', { class: 'small muted' }, 'Campo cond (4 bits) de BCOND (0x72). Depois de FCMP: menor = N, igual = Z C, maior = C, unordered (NaN) = C V.'));
      this.body.appendChild(this._table('Condições de desvio', ['Condição', 'Código', 'Mnemônicos', 'Testa', 'Depois de CMP a, b', 'Depois de FCMP a, b'], rows));
    }

    _pseudo() {
      const h = this.h;
      const isa = this.isa;
      const ps = filterRows(isa.pseudos || [], this.q.value, (p) => [p.mnemonic, p.syntax, p.expands, p.summary, (p.detail || []).join(' ')].join(' '));
      const sf = filterRows(isa.shortForms || [], this.q.value, (s) => [s.form, s.expands, s.summary, (s.detail || []).join(' ')].join(' '));
      this._setCount(ps.length + sf.length, (isa.pseudos || []).length + (isa.shortForms || []).length, 'pseudo-instruções e formas');
      const rows = ps.map((p) => ({
        key: p.mnemonic, cells: [p.mnemonic, this._code(p.syntax || p.signature), this._code(p.expands || ''), this._inline(p.summary || p.desc)],
        card: () => card(isa, { kind: 'pseudo', key: p.mnemonic })
      }));
      this.body.appendChild(h('h3', { class: 'ref-h' }, 'Pseudo-instruções (doc 04 §7)'));
      this.body.appendChild(this._table('Pseudo-instruções', ['Pseudo', 'Sintaxe', 'Expande para', 'Resumo'], rows));
      this.body.appendChild(h('h3', { class: 'ref-h' }, 'Formas abreviadas aceitas pelo assembler'));
      const rows2 = sf.map((s) => ({
        key: 'forma:' + s.key,
        cells: [this._code(s.form), this._code(s.expands), this._inline(s.summary + (s.detail && s.detail.length ? ' ' + s.detail.join(' ') : '')), this._code(s.example)]
      }));
      this.body.appendChild(this._table('Formas abreviadas', ['Forma', 'Expande para', 'Resumo', 'Exemplo'], rows2));
    }

    _directive() {
      const isa = this.isa;
      const list = filterRows(isa.directives || [], this.q.value, (d) => [d.name, d.syntax, d.summary, (d.detail || []).join(' ')].join(' '));
      this._setCount(list.length, (isa.directives || []).length, 'diretivas');
      const rows = list.map((d) => ({
        key: d.name, cells: [d.name, this._code(d.syntax || d.name), this._inline(d.summary || d.desc)],
        card: () => card(isa, { kind: 'directive', key: d.name })
      }));
      this.body.appendChild(this._table('Diretivas do assembler', ['Diretiva', 'Sintaxe', 'Resumo'], rows));
    }

    _reg() {
      const isa = this.isa;
      const docs = isa.regDocs || [];
      const list = filterRows(docs, this.q.value, (d) => [d.key, regRange(isa, d), d.summary, d.abi, d.preserve, (d.detail || []).join(' ')].join(' '));
      this._setCount(list.length, docs.length, 'grupos de registradores');
      const rows = list.map((d) => ({
        key: d.key,
        cells: [d.key.replace('-', '–'), d.from === d.to ? 'R' + d.from : 'R' + d.from + '–R' + d.to, regRange(isa, d) || '—', this._inline(d.summary), this._inline(d.abi), d.preserve],
        card: () => card(isa, { kind: 'register', key: d.key.split('-')[0] })
      }));
      this.body.appendChild(this.h('p', { class: 'small muted' }, 'A ABI é convenção (doc 04 §1; detalhes do kscc em kscc/docs/02-abi.md): a VM só impõe zr e o uso de sp por PUSH/POP/CALL/CALLR/RET.'));
      this.body.appendChild(this._table('Registradores', ['Registrador', 'Índice', 'Apelidos', 'Papel', 'ABI (kscc)', 'Preservado por'], rows));
    }

    _sr() {
      const isa = this.isa;
      const list = filterRows(isa.specialRegs || [], this.q.value, (s) => [s.name, s.access, s.summary, (s.detail || []).join(' ')].join(' '));
      this._setCount(list.length, (isa.specialRegs || []).length, 'registradores especiais');
      const rows = list.map((s) => ({
        key: s.name.toLowerCase(),
        cells: [s.name, String(s.num), s.access || '', this._inline(s.summary + (s.detail && s.detail.length ? ' ' + s.detail.join(' ') : ''))]
      }));
      this.body.appendChild(this.h('p', { class: 'small muted' }, 'Lidos com MFSR rd, sr; só FLAGS é gravável (MTSR FLAGS, rb).'));
      this.body.appendChild(this._table('Registradores especiais', ['Nome', 'SR', 'Acesso', 'Descrição'], rows));
    }

    _flag() {
      const isa = this.isa;
      const list = filterRows(isa.flagBits || [], this.q.value, (f) => [f.name, f.summary, (f.detail || []).join(' '), f.setBy.join(' ')].join(' '));
      this._setCount(list.length, (isa.flagBits || []).length, 'flags');
      const rows = list.map((f) => ({
        key: f.name.toLowerCase(),
        cells: [f.name, String(f.bit), this._inline(f.summary + (f.detail && f.detail.length ? ' ' + f.detail.join(' ') : '')), this.h('span', { class: 'ref-list' }, f.setBy.join(' '))]
      }));
      this.body.appendChild(this._table('Flags', ['Flag', 'Bit', 'Significado', 'Alterada por'], rows));
    }

    _format() {
      const h = this.h;
      this.count.textContent = (this.isa.formats || []).length + ' formatos';
      for (const f of this.isa.formats || []) {
        const sec = h('section', { class: 'ref-format-sec', 'data-key': f.name.toLowerCase() });
        const title = h('h3', { class: 'ref-h', tabindex: '-1' }, 'Formato ' + f.name + ' (' + f.len + ' bytes, ' + f.count + ' instruções)');
        this.rowButtons.set(f.name.toLowerCase(), title);
        sec.appendChild(title);
        sec.appendChild(renderEncoding(this.doc, { fields: f.fields, text: 'formato ' + f.name }, { names: true, label: 'Campos do formato ' + f.name + ': ' + f.fields.map((x) => x.name + ' bits ' + x.hi + '–' + x.lo + (x.word ? ' da palavra seguinte' : '')).join(', ') }));
        sec.appendChild(inline(this.doc, f.summary, h('p', {})));
        sec.appendChild(h('p', { class: 'small' }, 'Alcance do imediato: ' + f.range));
        for (const d of f.detail || []) sec.appendChild(inline(this.doc, d, h('p', { class: 'small muted' })));
        const names = this.isa.instructions.filter((i) => i.format === f.name).map((i) => i.mnemonic);
        sec.appendChild(h('p', { class: 'small ref-list' }, names.join(' ')));
        this.body.appendChild(sec);
      }
    }

    _fault() {
      const isa = this.isa;
      const list = filterRows(isa.faults || [], this.q.value, (f) => [f.name, f.code, f.summary, f.addr, (f.detail || []).join(' ')].join(' '));
      this._setCount(list.length, (isa.faults || []).length, 'faults');
      const rows = list.map((f) => ({
        key: f.name.toLowerCase(),
        cells: [f.name, String(f.code), this._inline(f.summary + (f.detail && f.detail.length ? ' ' + f.detail.join(' ') : '')), f.addr || '', String(f.exit)]
      }));
      this.body.appendChild(this.h('p', { class: 'small muted' }, 'Em fault a instrução não tem efeito e o pc fica nela; o ksvm e a IDE terminam com o código 70 + código do fault.'));
      this.body.appendChild(this._table('Faults da VM', ['Fault', 'Código', 'Causa', 'fault_addr', 'Saída'], rows));
    }

    _syscall() {
      const h = this.h;
      const isa = this.isa;
      const list = filterRows(isa.syscalls || [], this.q.value, (s) => [s.name, hex2(s.num), s.groupName, s.args, s.ret, s.summary, (s.detail || []).join(' ')].join(' '));
      this._setCount(list.length, (isa.syscalls || []).length, 'syscalls');
      const rows = list.map((s) => ({
        key: s.name.toLowerCase(),
        cells: [s.name, hex2(s.num), s.group + ' ' + s.groupName, this._inline(s.args || ''), this._inline(s.ret || ''), this._inline(s.summary || s.desc)],
        card: () => card(isa, { kind: 'syscall', key: s.name })
      }));
      this.body.appendChild(h('p', { class: 'small muted' }, 'syscall NOME (ou número): argumentos em r1–r6, retorno em r1 (−1 em erro) e erro em r2. Desconhecida: r1 = −1, r2 = NOSYS, sem fault.'));
      this.body.appendChild(this._table('Syscalls', ['Nome', 'Número', 'Grupo', 'Argumentos', 'Retorno', 'Resumo'], rows));
      this.body.appendChild(h('h3', { class: 'ref-h' }, 'Códigos de erro (r2)'));
      const errs = (isa.syscallErrors || []).map((e) => ({ key: 'err:' + e.name.toLowerCase(), cells: [e.name, String(e.code), e.summary] }));
      this.body.appendChild(this._table('Códigos de erro das syscalls', ['Erro', 'Código', 'Significado'], errs));
    }
  }

  const IsaRef = {
    norm, filterInsns, filterRows, opcodeCells, card, refTarget, renderCard, renderTip, renderEncoding,
    inline, Reference, SECTIONS
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = IsaRef;
  else root.IsaRef = IsaRef;
})(typeof self !== 'undefined' ? self : this);
