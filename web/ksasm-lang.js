/*
 * ksasm-lang.js — a linguagem do ksas para o editor, sem DOM e sem
 * CodeMirror (testada em Node): tokenizer de realce, rótulos do arquivo,
 * contexto e opções de autocomplete, palavra sob o cursor e texto de
 * ajuda das instruções. O vocabulário vem de isa.json (KSWEB_ISA).
 *
 *   KsasmLang.setIsa(isa)            vocabulário (instruções, pseudos...)
 *   KsasmLang.streamParser           {startState, token, copyState}: o
 *                                    formato do StreamLanguage do CM6
 *   KsasmLang.tokenizeLine(text)     [{from, to, type, text}] (testes)
 *   KsasmLang.scanLabels(text)       [{name, line, kind: 'label'|'equ'}]
 *   KsasmLang.labelCompletions(text, prefix, line?)  rótulos para completar
 *   KsasmLang.completionContext(lineText, col)
 *   KsasmLang.completionOptions(ctx, labels)
 *   KsasmLang.wordAt(lineText, col)  {word, from, to}
 *   KsasmLang.describe(word)         {kind, title, signature, detail, desc}
 *   KsasmLang.statementKind(text)    'insn' | 'directive' | 'equ' | 'label' | 'empty'
 *
 * Regras léxicas do ksas (lexer.c): comentários ';', '#' e '//';
 * identificadores [A-Za-z_][A-Za-z0-9_.]*; diretivas '.' + identificador;
 * números decimais, 0x, 0b (com '_'); 'c' e "texto" com escapes \n \t \r
 * \0 \\ \" \' \xHH; mnemônicos e registradores sem diferenciar maiúsculas,
 * rótulos diferenciando.
 */
(function (root) {
  'use strict';

  let ISA = null;
  const V = {
    insn: new Map(), pseudo: new Map(), branch: new Map(), directive: new Map(),
    register: new Map(), syscall: new Map(), sr: new Map()
  };

  function setIsa(isa) {
    ISA = isa;
    for (const k in V) V[k].clear();
    if (!isa) return;
    for (const i of isa.instructions) V.insn.set(i.mnemonic, i);
    for (const p of isa.pseudos) V.pseudo.set(p.mnemonic, p);
    for (const b of isa.branches) V.branch.set(b.mnemonic, b);
    for (const d of isa.directives) V.directive.set(d.name, d);
    for (const r of isa.registers) V.register.set(r.name, r);
    for (const s of isa.syscalls) V.syscall.set(s.name.toLowerCase(), s);
    for (const s of isa.specialRegs) V.sr.set(s.name.toLowerCase(), s);
  }

  /* Registrador sem a tabela (o lexer do ksas: r0..r31, a0..a3, t0..t10, s0..s13). */
  function isRegister(w) {
    const l = w.toLowerCase();
    if (V.register.size) return V.register.has(l);
    if (l === 'zr' || l === 'fp' || l === 'sp') return true;
    const m = /^([rats])([1-9]?\d)$/.exec(l);
    if (!m || (m[2].length === 2 && m[2][0] === '0')) return false;
    const n = +m[2];
    return { r: 32, a: 4, t: 11, s: 14 }[m[1]] > n;
  }

  function mnemonicKind(w) {
    const l = w.toLowerCase();
    if (V.insn.has(l)) return l === 'bcond' ? 'invalid' : 'mnemonic';
    if (V.pseudo.has(l)) return 'pseudo';
    if (V.branch.has(l)) return 'mnemonic';
    return null;
  }

  /* ---- tokenizer (StreamLanguage) ---- */

  const IDENT = /^[A-Za-z_][A-Za-z0-9_.]*/;
  const FLOAT = /^(?:0[xX][0-9a-fA-F]*\.?[0-9a-fA-F]*[pP][-+]?\d+|(?:\d+\.\d*|\.\d+)(?:[eE][-+]?\d+)?|\d+[eE][-+]?\d+)/;

  function startState() { return { at: 'start', op: null, dir: null }; }
  function copyState(s) { return { at: s.at, op: s.op, dir: s.dir }; }

  function readEscape(stream) {
    const c = stream.next();
    if (c === undefined) return false;
    if ('ntr0\\"\''.includes(c)) return true;
    if (c === 'x') return !!stream.match(/^[0-9a-fA-F]{2}/);
    return false;
  }

  function token(stream, state) {
    if (stream.sol()) { state.at = 'start'; state.op = null; state.dir = null; }
    if (stream.eatSpace()) return null;
    const ch = stream.peek();
    if (ch === ';' || ch === '#' || (ch === '/' && stream.string.charAt(stream.pos + 1) === '/')) {
      stream.skipToEnd();
      return 'comment';
    }
    if (ch === '"') {
      stream.next();
      let bad = false;
      for (;;) {
        const c = stream.next();
        if (c === undefined) return 'invalid';
        if (c === '"') break;
        if (c === '\\' && !readEscape(stream)) bad = true;
      }
      return bad ? 'invalid' : 'string';
    }
    if (ch === '\'') {
      stream.next();
      const c = stream.next();
      let good = c !== undefined && c !== '\'';
      if (c === '\\') good = readEscape(stream);
      if (!stream.eat('\'')) good = false;
      return good ? 'char' : 'invalid';
    }
    const floatCtx = state.op === 'fli' || state.dir === '.float';
    if (floatCtx && stream.match(FLOAT)) {
      if (stream.match(/^[A-Za-z0-9_.]+/)) return 'invalid';
      return 'number';
    }
    if (/\d/.test(ch)) {
      if (stream.match(/^0[xX][0-9a-fA-F_]+/) || stream.match(/^0[bB][01_]+/) || stream.match(/^\d[\d_]*/)) {
        if (stream.match(/^[A-Za-z0-9_.]+/)) return 'invalid';
        return 'number';
      }
    }
    if (ch === '.' && /[A-Za-z_]/.test(stream.string.charAt(stream.pos + 1))) {
      stream.next();
      stream.match(IDENT);
      const name = stream.current().toLowerCase();
      if (state.at === 'start') {
        state.at = 'operands';
        state.dir = name;
        return V.directive.size && !V.directive.has(name) ? 'invalid' : 'directive';
      }
      return 'label';
    }
    const id = stream.match(IDENT);
    if (id) {
      const w = id[0];
      if (state.at === 'start') {
        const rest = stream.string.slice(stream.pos);
        if (/^\s*:/.test(rest)) return 'labelDef';
        if (/^\s*=(?!=)/.test(rest)) { state.at = 'operands'; return 'labelDef'; }
        const k = mnemonicKind(w);
        state.at = 'operands';
        state.op = w.toLowerCase();
        return k || (V.insn.size ? 'invalid' : 'mnemonic');
      }
      if (isRegister(w)) return 'register';
      const l = w.toLowerCase();
      if (state.op === 'syscall' && V.syscall.has(l)) return 'syscall';
      if ((state.op === 'mfsr' || state.op === 'mtsr') && V.sr.has(l)) return 'syscall';
      if (floatCtx && /^[-+]?(inf|infinity|nan)$/i.test(w)) return 'number';
      return 'label';
    }
    stream.next();
    if (ch === ':') { if (state.at === 'start') state.at = 'start'; return 'punct'; }
    if (ch === '<' || ch === '>') { if (stream.eat(ch)) return 'operator'; return 'invalid'; }
    if ('+-*/%&|^~='.includes(ch)) return 'operator';
    if (',[]()'.includes(ch)) return 'punct';
    return 'invalid';
  }

  const streamParser = {
    name: 'ksasm', startState, copyState, token,
    languageData: { commentTokens: { line: ';' } }
  };

  /* StringStream mínimo, compatível com o do CodeMirror (para os testes e
   * para funções puras daqui). */
  class LineStream {
    constructor(s) { this.string = s; this.pos = 0; this.start = 0; }
    sol() { return this.pos === 0; }
    eol() { return this.pos >= this.string.length; }
    peek() { return this.string.charAt(this.pos) || undefined; }
    next() { if (this.pos < this.string.length) return this.string.charAt(this.pos++); return undefined; }
    eat(m) {
      const c = this.string.charAt(this.pos);
      const okc = typeof m === 'string' ? c === m : c && (m instanceof RegExp ? m.test(c) : m(c));
      if (okc) { this.pos++; return c; }
      return undefined;
    }
    eatWhile(m) { const s = this.pos; while (this.eat(m)); return this.pos > s; }
    eatSpace() { const s = this.pos; while (/[\s ]/.test(this.string.charAt(this.pos)) && this.pos < this.string.length) this.pos++; return this.pos > s; }
    skipToEnd() { this.pos = this.string.length; }
    backUp(n) { this.pos -= n; }
    current() { return this.string.slice(this.start, this.pos); }
    match(pat, consume) {
      if (typeof pat === 'string') {
        if (this.string.startsWith(pat, this.pos)) { if (consume !== false) this.pos += pat.length; return true; }
        return null;
      }
      const m = this.string.slice(this.pos).match(pat);
      if (m && m.index > 0) return null;
      if (m && consume !== false) this.pos += m[0].length;
      return m;
    }
  }

  function tokenizeLine(text, state) {
    const st = state || startState();
    const s = new LineStream(text);
    const out = [];
    while (!s.eol()) {
      s.start = s.pos;
      const type = token(s, st);
      if (s.pos === s.start) { s.pos++; }
      if (type) out.push({ from: s.start, to: s.pos, type, text: text.slice(s.start, s.pos) });
    }
    return out;
  }

  /* ---- rótulos e tipo de comando ---- */

  function scanLabels(text) {
    const out = [];
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (!/[A-Za-z_]/.test(lines[i])) continue;
      for (const t of tokenizeLine(lines[i])) {
        if (t.type === 'labelDef') {
          const after = lines[i].slice(t.to);
          out.push({ name: t.text, line: i + 1, kind: /^\s*=/.test(after) ? 'equ' : 'label' });
        }
      }
    }
    return out;
  }

  /* Rótulos definidos em text que começam com prefix (diferencia
   * maiúsculas, como o ksas, mas aceita prefixo em minúsculas), sem
   * repetir e sem o próprio rótulo sendo digitado na linha "line". */
  function labelCompletions(text, prefix, line) {
    const seen = new Set();
    const out = [];
    const p = prefix || '';
    for (const l of scanLabels(text)) {
      if (seen.has(l.name)) continue;
      if (l.line === line && l.name === p) continue;
      if (p && !l.name.startsWith(p) && !l.name.toLowerCase().startsWith(p.toLowerCase())) continue;
      seen.add(l.name);
      out.push(l);
    }
    return out.sort((a, b) => (a.name.startsWith(p) ? 0 : 1) - (b.name.startsWith(p) ? 0 : 1) || a.name.localeCompare(b.name));
  }

  function statementKind(text) {
    const toks = tokenizeLine(text).filter((t) => t.type !== 'comment');
    let i = 0;
    while (i < toks.length && toks[i].type === 'labelDef' && toks[i + 1] && toks[i + 1].text === ':') i += 2;
    if (i >= toks.length) return i > 0 ? 'label' : 'empty';
    const t = toks[i];
    if (t.type === 'labelDef') return 'equ';
    if (t.type === 'directive') return 'directive';
    return 'insn';
  }

  /* ---- autocomplete ---- */

  /*
   * Contexto na coluna col (0-based) da linha:
   *   {kind: 'statement', from, prefix}      início de comando (mnemônico/diretiva)
   *   {kind: 'directive', from, prefix}      digitando ".xxx" no início
   *   {kind: 'operand', from, prefix, op, index}  operando "index" de op
   *   {kind: 'none'}                         comentário/string
   */
  function completionContext(lineText, col) {
    const before = lineText.slice(0, col);
    const toks = tokenizeLine(before);
    const last = toks[toks.length - 1];
    if (last && (last.type === 'comment' || ((last.type === 'string' || last.type === 'invalid') && last.to === col && /^["']/.test(last.text)))) {
      return { kind: 'none' };
    }
    const m = /[A-Za-z0-9_.]*$/.exec(before);
    const prefix = m[0];
    const from = col - prefix.length;
    /* tokens antes da palavra atual */
    const prev = toks.filter((t) => t.to <= from);
    let i = 0;
    while (i < prev.length && prev[i].type === 'labelDef' && prev[i + 1] && prev[i + 1].text === ':') i += 2;
    const rest = prev.slice(i);
    if (rest.length === 0) {
      if (prefix.startsWith('.')) return { kind: 'directive', from, prefix };
      return { kind: 'statement', from, prefix };
    }
    const head = rest[0];
    if (head.type === 'directive') {
      return { kind: 'operand', from, prefix, op: head.text.toLowerCase(), index: rest.filter((t) => t.text === ',').length, directive: true };
    }
    if (head.type === 'labelDef') return { kind: 'operand', from, prefix, op: '=', index: 0 };
    const index = rest.filter((t) => t.text === ',').length;
    const inBracket = rest.filter((t) => t.text === '[').length > rest.filter((t) => t.text === ']').length;
    return { kind: 'operand', from, prefix, op: head.text.toLowerCase(), index, inBracket };
  }

  function insnDoc(e) {
    return { detail: e.signature, info: e.desc + (e.flagsText ? ' · ' + e.flagsText : '') + (e.format ? ' · formato ' + e.format + (e.len ? ', ' + e.len + ' bytes' : '') : '') };
  }

  /*
   * Opções para o contexto: [{label, type, detail, info, snippet?, boost?}].
   * type: 'keyword' (instrução), 'function' (pseudo), 'namespace'
   * (diretiva), 'variable' (registrador), 'constant' (rótulo/equ),
   * 'enum' (syscall/registrador especial).
   */
  function completionOptions(ctx, labels) {
    const out = [];
    if (!ISA || ctx.kind === 'none') return out;
    const p = (ctx.prefix || '').toLowerCase();
    const want = (name) => !p || name.toLowerCase().startsWith(p);
    if (ctx.kind === 'statement' || ctx.kind === 'directive') {
      if (ctx.kind === 'statement') {
        for (const e of ISA.instructions) {
          if (!e.snippet || !want(e.mnemonic)) continue;
          out.push(Object.assign({ label: e.mnemonic, type: 'keyword', snippet: e.snippet }, insnDoc(e)));
        }
        for (const e of ISA.pseudos) {
          if (!want(e.mnemonic)) continue;
          out.push({ label: e.mnemonic, type: 'function', snippet: e.snippet, detail: e.signature, info: 'pseudo-instrução: ' + e.desc, boost: 1 });
        }
        for (const e of ISA.branches) {
          if (e.alias || !want(e.mnemonic)) continue;
          out.push({ label: e.mnemonic, type: 'keyword', snippet: e.snippet, detail: e.signature, info: e.desc });
        }
      }
      for (const d of ISA.directives) {
        if (!want(d.name) && !want(d.name.slice(1))) continue;
        out.push({ label: d.name, type: 'namespace', snippet: d.snippet, detail: (d.name + ' ' + d.args).trim(), info: d.desc });
      }
      return out;
    }
    /* operandos */
    const op = ctx.op;
    if (op === 'syscall') {
      for (const s of ISA.syscalls) {
        if (want(s.name)) out.push({ label: s.name, type: 'enum', detail: 'syscall 0x' + s.num.toString(16).toUpperCase(), info: s.desc, boost: 2 });
      }
      return out;
    }
    if ((op === 'mfsr' && ctx.index === 1) || (op === 'mtsr' && ctx.index === 0)) {
      for (const s of ISA.specialRegs) if (want(s.name)) out.push({ label: s.name, type: 'enum', detail: 'SR ' + s.num, info: s.desc, boost: 2 });
      return out;
    }
    if (op === '.include' || op === '.ascii' || op === '.asciz') return out;
    const e = V.insn.get(op) || V.pseudo.get(op) || V.branch.get(op);
    const shape = e && e.operands ? e.operands[ctx.index] || '' : '';
    const wantsLabel = /rótulo|imm|valor|endereço|símbolo/.test(shape) || !e || ctx.directive || op === '=';
    const wantsReg = !ctx.directive && op !== '=' && (!e || /^r|\[/.test(shape) || ctx.inBracket || /rb\|imm/.test(shape));
    if (wantsReg) {
      for (const r of ISA.registers) {
        if (r.alias || !want(r.name)) continue;
        out.push({ label: r.name, type: 'variable', detail: 'r' + r.index, info: r.desc, boost: /^[rf]/.test(shape) ? 1 : 0 });
      }
    }
    if (wantsLabel || !e) {
      for (const l of labels || []) {
        if (!want(l.name)) continue;
        out.push({ label: l.name, type: 'constant', detail: (l.kind === 'equ' ? 'constante' : 'rótulo') + (l.addr !== undefined ? ' = 0x' + (l.addr >>> 0).toString(16).toUpperCase().padStart(8, '0') : '') + (l.file ? ' (' + l.file + ':' + l.line + ')' : ' (linha ' + l.line + ')'), boost: shape === 'rótulo' ? 3 : 1 });
      }
    }
    return out;
  }

  /* ---- palavra sob o cursor e ajuda ---- */

  function wordAt(lineText, col) {
    const re = /\.?[A-Za-z_][A-Za-z0-9_.]*|0[xXbB][0-9a-fA-F_]+|\d[\d_]*/g;
    let m;
    while ((m = re.exec(lineText))) {
      const end = m.index + m[0].length;
      if (m.index <= col && col <= end) return { word: m[0], from: m.index, to: end };
      if (m.index > col) break;
    }
    return null;
  }

  /* O que é a palavra (sem contexto de valores da VM). */
  function describe(word, tokenType) {
    if (!word) return null;
    const l = word.toLowerCase();
    if (tokenType !== 'label' && tokenType !== 'labelDef') {
      const e = V.insn.get(l);
      if (e && tokenType !== 'register') {
        return {
          kind: 'insn', title: e.mnemonic.toUpperCase() + '  (0x' + e.opcode.toString(16).toUpperCase().padStart(2, '0') + ', formato ' + e.format + ', ' + e.len + ' bytes)',
          signature: e.snippet ? e.signature : 'b<cond> rótulo', desc: e.desc, detail: e.flagsText +
            (e.immForm ? ' · com imediato: ' + e.immForm : '') + (e.long ? ' · forma longa: ' + e.long : '') +
            (e.indexed ? ' · indexado: ' + e.indexed : '') + (e.note ? ' · ' + e.note : '')
        };
      }
      const p = V.pseudo.get(l);
      if (p) return { kind: 'pseudo', title: p.mnemonic + '  (pseudo-instrução)', signature: p.signature, desc: p.desc, detail: '' };
      const b = V.branch.get(l);
      if (b) return { kind: 'branch', title: b.mnemonic + '  (BCOND ' + b.cond + ')', signature: b.signature, desc: b.desc, detail: 'não altera flags' };
      const d = V.directive.get(l);
      if (d) return { kind: 'directive', title: d.name, signature: (d.name + ' ' + d.args).trim(), desc: d.desc, detail: '' };
      if (isRegister(word)) {
        const r = V.register.get(l);
        return { kind: 'register', title: l, signature: r ? 'r' + r.index : l, desc: r ? r.desc : 'registrador', detail: '', index: r ? r.index : null };
      }
      const s = V.syscall.get(l);
      if (s && tokenType === 'syscall') return { kind: 'syscall', title: 'syscall ' + s.name, signature: '0x' + s.num.toString(16).toUpperCase(), desc: s.desc, detail: '' };
      const sr = V.sr.get(l);
      if (sr && tokenType === 'syscall') return { kind: 'sr', title: sr.name, signature: 'SR ' + sr.num, desc: sr.desc, detail: '' };
    }
    if (/^[A-Za-z_]/.test(word)) return { kind: 'label', title: word, signature: '', desc: '', detail: '' };
    return null;
  }

  /* Tipo do token que cobre a coluna col (para a ajuda saber se "b" é
   * mnemônico ou rótulo, "r1" registrador etc.). */
  function tokenAt(lineText, col) {
    for (const t of tokenizeLine(lineText)) {
      if (t.from <= col && col <= t.to) return t;
    }
    return null;
  }

  const api = {
    setIsa, streamParser, tokenizeLine, scanLabels, labelCompletions, statementKind,
    completionContext, completionOptions, wordAt, describe, tokenAt, isRegister, LineStream
  };
  const KsasmLang = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = KsasmLang;
  else root.KsasmLang = KsasmLang;
  if (root.KSWEB_ISA) setIsa(root.KSWEB_ISA);
})(typeof self !== 'undefined' ? self : this);
