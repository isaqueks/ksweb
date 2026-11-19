/*
 * editor.js — o editor da IDE: CodeMirror 6 (global CM, de
 * web/vendor/codemirror.bundle.js) com a linguagem ksasm (ksasm-lang.js).
 *
 * Uma EditorView e um EditorState por arquivo (cada arquivo guarda seu
 * histórico de desfazer, breakpoints e marcadores). Gutter próprio com
 * breakpoints (clique), a seta da linha atual da depuração e um ponto nas
 * linhas que geraram código (endereço no título); erros do ksas pelo
 * @codemirror/lint (setDiagnostics); autocomplete e ajuda ao passar o mouse
 * pelas funções puras de KsasmLang; busca, comentar linha, desfazer etc.
 * dos pacotes do CodeMirror.
 *
 *   const ed = new KsEditor(parent, {
 *     onChange(name, text), onCursor(line, col), onBreakpoints(name, lines),
 *     labels(name, text, line) -> [{name, line, kind, addr?, file?}],
 *     hover({word, type, file, line}) -> Promise<HTMLElement|null>,
 *     keys: {Ctrl-b: fn, F9: fn, ...}   (atalhos extras, Mod = Ctrl/Cmd)
 *   });
 *   ed.open(name, text) / close / rename / setText / getText / has
 *   ed.setDiagnostics(name, [{line, col, message, severity}])
 *   ed.setCodeLines(name, [{line, addr}]) / setDebugLine(name, line|null)
 *   ed.setBreakpoints(name, lines) / getBreakpoints(name) / toggleBreakpoint()
 *   ed.gotoLine(name, line, col) / focus() / cursor()
 */
(function (root) {
  'use strict';
  /* global CM, KsasmLang, AsmTools */

  const PHRASES_PT = {
    'Find': 'Buscar', 'Replace': 'Substituir', 'next': 'próximo', 'previous': 'anterior', 'all': 'todos',
    'match case': 'maiúsc./minúsc.', 'by word': 'palavra inteira', 'regexp': 'expressão regular',
    'replace': 'substituir', 'replace all': 'substituir todos', 'close': 'fechar',
    'current match': 'ocorrência atual', 'replaced match on line $': 'substituída a ocorrência na linha $',
    'replaced $ matches': '$ ocorrências substituídas', 'on line': 'na linha', 'Go to line': 'Ir para a linha',
    'go': 'ir', 'Diagnostics': 'Problemas', 'No diagnostics': 'Sem problemas', 'Selection deleted': 'Seleção apagada',
    'Folded lines': 'Linhas recolhidas', 'Unfolded lines': 'Linhas expandidas', 'to': 'até', 'folded code': 'código recolhido',
    'unfold': 'expandir', 'Fold line': 'Recolher linha', 'Unfold line': 'Expandir linha', 'Completions': 'Sugestões'
  };

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  const hex8 = (v) => '0x' + (v >>> 0).toString(16).toUpperCase().padStart(8, '0');

  class KsEditor {
    constructor(parent, opts) {
      this.opts = opts || {};
      this.parent = parent;
      this.states = new Map();
      this.diags = new Map();
      this.active = null;
      this._silent = false;
      this._buildExtensions();
      this.view = new CM.EditorView({ parent, state: this._newState('') });
      this.view.dom.setAttribute('aria-label', 'Editor de código assembly');
      this.view.contentDOM.setAttribute('aria-label', 'Código-fonte');
    }

    _buildExtensions() {
      const C = CM;
      const self = this;
      const t = C.tags;

      /* ---- campos de estado: breakpoints, linha da depuração, linhas com código ---- */
      const bpToggle = C.StateEffect.define({ map: (v, m) => ({ pos: m.mapPos(v.pos), on: v.on }) });
      const bpSet = C.StateEffect.define();
      /* startSide 1: inserir texto no começo da linha leva a marca junto com a linha */
      class BpMarker extends C.GutterMarker {}
      BpMarker.prototype.startSide = 1;
      const bpMark = new BpMarker();
      const bpField = C.StateField.define({
        create: () => C.RangeSet.empty,
        update(set, tr) {
          set = set.map(tr.changes);
          for (const e of tr.effects) {
            if (e.is(bpToggle)) {
              const line = tr.state.doc.lineAt(e.value.pos);
              let had = false;
              set.between(line.from, line.to, () => { had = true; });
              if (had) set = set.update({ filter: (from) => from < line.from || from > line.to, filterFrom: line.from, filterTo: line.to });
              if (e.value.on === true || (e.value.on === undefined && !had)) set = set.update({ add: [bpMark.range(line.from)] });
            } else if (e.is(bpSet)) {
              const doc = tr.state.doc;
              const ranges = [...new Set(e.value.filter((l) => l >= 1 && l <= doc.lines))].sort((a, b) => a - b).map((l) => bpMark.range(doc.line(l).from));
              set = C.RangeSet.of(ranges);
            }
          }
          return set;
        }
      });

      const dbgSet = C.StateEffect.define();
      const dbgField = C.StateField.define({
        create: () => null,
        update(v, tr) {
          if (v !== null && tr.docChanged) v = tr.changes.mapPos(v, 1);
          for (const e of tr.effects) if (e.is(dbgSet)) v = e.value === null ? null : tr.state.doc.line(Math.min(e.value, tr.state.doc.lines)).from;
          return v;
        },
        provide: (f) => C.EditorView.decorations.from(f, (pos) => {
          if (pos === null) return C.Decoration.none;
          return C.Decoration.set([C.Decoration.line({ class: 'cm-debug-line' }).range(pos)]);
        })
      });

      class CodeMarker extends C.GutterMarker {
        constructor(addr) { super(); this.addr = addr; }
        eq(o) { return o.addr === this.addr; }
      }
      CodeMarker.prototype.startSide = 1;
      const codeSet = C.StateEffect.define();
      const codeField = C.StateField.define({
        create: () => C.RangeSet.empty,
        update(set, tr) {
          set = set.map(tr.changes);
          for (const e of tr.effects) {
            if (!e.is(codeSet)) continue;
            const doc = tr.state.doc, seen = new Set(), ranges = [];
            for (const c of e.value.slice().sort((a, b) => a.line - b.line)) {
              if (c.line < 1 || c.line > doc.lines || seen.has(c.line)) continue;
              seen.add(c.line);
              ranges.push(new CodeMarker(c.addr).range(doc.line(c.line).from));
            }
            set = C.RangeSet.of(ranges);
          }
          return set;
        }
      });

      class LineMarker extends C.GutterMarker {
        constructor(bp, dbg, addr) { super(); this.bp = bp; this.dbg = dbg; this.addr = addr; }
        eq(o) { return o.bp === this.bp && o.dbg === this.dbg && o.addr === this.addr; }
        toDOM() {
          const s = el('span', 'cm-ks-mark' + (this.bp ? ' bp' : '') + (this.dbg ? ' dbg' : '') + (this.addr !== null ? ' code' : ''));
          s.textContent = this.dbg ? '➤' : this.bp ? '●' : this.addr !== null ? '·' : '';
          const where = this.addr !== null ? hex8(this.addr) : 'sem código';
          s.title = (this.bp ? 'breakpoint · ' : '') + (this.dbg ? 'linha atual · ' : '') + where;
          return s;
        }
      }

      const markGutter = C.gutter({
        class: 'cm-ks-gutter',
        lineMarker(view, line) {
          const st = view.state;
          let bp = false, addr = null;
          st.field(bpField).between(line.from, line.to, () => { bp = true; });
          st.field(codeField).between(line.from, line.to, (f, to, m) => { addr = m.addr; });
          const d = st.field(dbgField);
          const dbg = d !== null && d >= line.from && d <= line.to;
          if (!bp && !dbg && addr === null) return null;
          return new LineMarker(bp, dbg, addr);
        },
        lineMarkerChange: (u) => u.startState.field(bpField) !== u.state.field(bpField) ||
          u.startState.field(dbgField) !== u.state.field(dbgField) || u.startState.field(codeField) !== u.state.field(codeField),
        initialSpacer: () => new LineMarker(true, false, null),
        domEventHandlers: {
          mousedown(view, line) {
            view.dispatch({ effects: bpToggle.of({ pos: line.from }) });
            return true;
          }
        }
      });

      this._fx = { bpToggle, bpSet, bpField, dbgSet, dbgField, codeSet, codeField };

      /* ---- linguagem e realce ---- */
      const lang = C.StreamLanguage.define(Object.assign({}, KsasmLang.streamParser, {
        tokenTable: {
          mnemonic: t.keyword, pseudo: t.macroName, directive: t.processingInstruction, register: t.variableName,
          labelDef: t.definition(t.labelName), label: t.labelName, number: t.number, string: t.string, char: t.character,
          comment: t.lineComment, operator: t.operator, punct: t.punctuation, invalid: t.invalid, syscall: t.constant(t.name)
        }
      }));
      const hl = C.HighlightStyle.define([
        { tag: t.keyword, color: 'var(--hl-insn)', fontWeight: '600' },
        { tag: t.macroName, color: 'var(--hl-pseudo)', fontWeight: '600' },
        { tag: t.processingInstruction, color: 'var(--hl-dir)' },
        { tag: t.variableName, color: 'var(--hl-reg)' },
        { tag: t.definition(t.labelName), color: 'var(--hl-label)', fontWeight: '600' },
        { tag: t.labelName, color: 'var(--hl-label)' },
        { tag: t.number, color: 'var(--hl-num)' },
        { tag: [t.string, t.character], color: 'var(--hl-str)' },
        { tag: t.lineComment, color: 'var(--hl-comment)', fontStyle: 'italic' },
        { tag: t.operator, color: 'var(--hl-op)' },
        { tag: t.punctuation, color: 'var(--hl-op)' },
        { tag: t.invalid, color: 'var(--hl-invalid)', textDecoration: 'underline wavy' },
        { tag: t.constant(t.name), color: 'var(--hl-sys)' }
      ]);

      /* ---- autocomplete ---- */
      const complete = (context) => {
        const line = context.state.doc.lineAt(context.pos);
        const col = context.pos - line.from;
        const ctx = KsasmLang.completionContext(line.text, col);
        if (ctx.kind === 'none') return null;
        if (!context.explicit && !ctx.prefix) return null;
        const labels = self.opts.labels ? self.opts.labels(self.active, context.state.doc.toString(), line.number) : KsasmLang.labelCompletions(context.state.doc.toString(), '', line.number);
        const options = KsasmLang.completionOptions(ctx, labels).map((o) => {
          const base = { label: o.label, type: o.type, detail: o.detail, info: o.info, boost: o.boost || 0 };
          return o.snippet && o.snippet !== o.label ? C.snippetCompletion(o.snippet, base) : base;
        });
        if (!options.length) return null;
        return { from: line.from + ctx.from, options, validFor: /^[\w.]*$/ };
      };

      /* ---- ajuda ao passar o mouse ---- */
      const hover = C.hoverTooltip(async (view, pos) => {
        const line = view.state.doc.lineAt(pos);
        const w = KsasmLang.wordAt(line.text, pos - line.from);
        if (!w || !self.opts.hover) return null;
        const tok = KsasmLang.tokenAt(line.text, Math.min(w.from + 1, w.to));
        if (tok && (tok.type === 'comment' || tok.type === 'string' || tok.type === 'char')) return null;
        const dom = await self.opts.hover({ word: w.word, type: tok ? tok.type : null, file: self.active, line: line.number });
        if (!dom) return null;
        return { pos: line.from + w.from, end: line.from + w.to, above: true, create: () => ({ dom }) };
      }, { hoverTime: 350 });

      /* ---- atalhos ---- */
      const extraKeys = [];
      for (const [key, fn] of Object.entries(this.opts.keys || {})) {
        extraKeys.push({ key, run: () => { fn(); return true; }, preventDefault: true });
      }
      extraKeys.push({ key: 'F9', run: () => { self.toggleBreakpoint(); return true; } });

      const listener = C.EditorView.updateListener.of((u) => {
        if (self._silent || !self.active) return;
        if (u.docChanged && self.opts.onChange) self.opts.onChange(self.active, u.state.doc.toString());
        if (u.selectionSet || u.docChanged) {
          const head = u.state.selection.main.head, l = u.state.doc.lineAt(head);
          if (self.opts.onCursor) self.opts.onCursor(l.number, head - l.from + 1);
        }
        if (u.startState.field(bpField) !== u.state.field(bpField) && self.opts.onBreakpoints) {
          const lines = self._bpLines(u.state);
          if (lines.join() !== self._bpLines(u.startState).join()) self.opts.onBreakpoints(self.active, lines);
        }
      });

      const theme = C.EditorView.theme({
        '&': { height: '100%', backgroundColor: 'var(--editor-bg)', color: 'var(--fg)' },
        '.cm-content': { fontFamily: 'var(--mono)', caretColor: 'var(--fg)' },
        '.cm-scroller': { fontFamily: 'var(--mono)', lineHeight: '1.45' },
        '.cm-gutters': { backgroundColor: 'var(--gutter-bg)', color: 'var(--muted)', borderRight: '1px solid var(--border)' },
        '.cm-activeLine': { backgroundColor: 'var(--active-line)' },
        '.cm-activeLineGutter': { backgroundColor: 'var(--active-line)' },
        '&.cm-focused .cm-cursor': { borderLeftColor: 'var(--fg)' },
        '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: 'var(--selection)' },
        '.cm-tooltip': { backgroundColor: 'var(--panel)', color: 'var(--fg)', border: '1px solid var(--border)' },
        '.cm-panels': { backgroundColor: 'var(--panel)', color: 'var(--fg)' },
        '.cm-searchMatch': { backgroundColor: 'var(--chg)' }
      });

      this._extensions = [
        markGutter,
        C.lineNumbers(),
        C.lintGutter(),
        C.highlightActiveLineGutter(),
        C.highlightSpecialChars(),
        C.history(),
        C.drawSelection(),
        C.dropCursor(),
        C.EditorState.allowMultipleSelections.of(true),
        C.indentUnit.of('        '),
        C.bracketMatching(),
        C.closeBrackets(),
        C.highlightActiveLine(),
        C.highlightSelectionMatches(),
        C.search({ top: true }),
        C.autocompletion({ override: [complete], icons: false, activateOnTypingDelay: 80 }),
        hover,
        lang,
        C.syntaxHighlighting(hl),
        bpField, dbgField, codeField,
        C.EditorState.phrases.of(PHRASES_PT),
        C.Prec.high(C.keymap.of(extraKeys)),
        C.keymap.of([
          ...C.closeBracketsKeymap, ...C.defaultKeymap, ...C.searchKeymap, ...C.historyKeymap,
          ...C.completionKeymap, ...C.lintKeymap, C.indentWithTab,
          { key: 'Mod-/', run: C.toggleComment }
        ]),
        listener,
        theme
      ];
    }

    _newState(text) {
      return CM.EditorState.create({ doc: text, extensions: this._extensions });
    }

    _bpLines(state) {
      const out = new Set();
      state.field(this._fx.bpField).between(0, state.doc.length, (from) => { out.add(state.doc.lineAt(from).number); });
      return [...out].sort((a, b) => a - b);
    }

    _state(name) { return name === this.active ? this.view.state : this.states.get(name); }

    /* Aplica efeitos/transação ao estado de "name" (ativo ou guardado). */
    _apply(name, spec) {
      if (name === this.active) { this._silent = !spec.userEvent; this.view.dispatch(spec); this._silent = false; return; }
      const st = this.states.get(name);
      if (st) this.states.set(name, st.update(spec).state);
    }

    has(name) { return this.states.has(name) || this.active === name; }

    open(name, text) {
      if (this.active === name) return;
      if (this.active !== null) this.states.set(this.active, this.view.state);
      let st = this.states.get(name);
      if (!st) { st = this._newState(text || ''); this.states.set(name, st); }
      this._silent = true;
      this.view.setState(st);
      this._silent = false;
      this.active = name;
      this.states.delete(name);
      const head = st.selection.main.head, l = st.doc.lineAt(head);
      if (this.opts.onCursor) this.opts.onCursor(l.number, head - l.from + 1);
    }

    /* Fecha o arquivo (o estado fica guardado: reabrir mantém o desfazer). */
    deactivate() {
      if (this.active === null) return;
      this.states.set(this.active, this.view.state);
      this.active = null;
      this._silent = true;
      this.view.setState(this._newState(''));
      this._silent = false;
    }

    forget(name) {
      if (this.active === name) this.deactivate();
      this.states.delete(name);
      this.diags.delete(name);
    }

    rename(from, to) {
      if (this.active === from) this.active = to;
      if (this.states.has(from)) { this.states.set(to, this.states.get(from)); this.states.delete(from); }
      if (this.diags.has(from)) { this.diags.set(to, this.diags.get(from)); this.diags.delete(from); }
    }

    getText(name) { const st = this._state(name); return st ? st.doc.toString() : null; }

    setText(name, text) {
      const st = this._state(name);
      if (!st) { this.states.set(name, this._newState(text)); return; }
      if (st.doc.toString() === text) return;
      this._apply(name, { changes: { from: 0, to: st.doc.length, insert: text } });
    }

    /* [{line, col, message, severity}] -> diagnósticos do @codemirror/lint. */
    setDiagnostics(name, list) {
      this.diags.set(name, list);
      const st = this._state(name);
      if (!st) return;
      const doc = st.doc;
      const ds = [];
      for (const d of list) {
        const ln = doc.line(Math.max(1, Math.min(d.line || 1, doc.lines)));
        let from = ln.from, to = ln.to;
        if (d.col > 0) {
          const c = AsmTools.byteColToChar(ln.text, d.col);
          from = ln.from + Math.min(c, ln.length);
          const w = /^[\w.$"']+|^\S/.exec(ln.text.slice(c));
          to = Math.min(ln.to, from + (w ? w[0].length : 1));
          if (to <= from) to = Math.min(ln.to, from + 1);
        }
        ds.push({ from, to, severity: d.severity === 'info' ? 'info' : 'error', message: d.message, source: 'ksas' });
      }
      this._apply(name, CM.setDiagnostics(st, ds));
    }

    setCodeLines(name, list) { if (this._state(name)) this._apply(name, { effects: this._fx.codeSet.of(list || []) }); }

    setDebugLine(name, line) {
      for (const n of [this.active, ...this.states.keys()]) {
        if (n === null || n === name) continue;
        const st = this._state(n);
        if (st && st.field(this._fx.dbgField) !== null) this._apply(n, { effects: this._fx.dbgSet.of(null) });
      }
      if (name === null || !this._state(name)) return;
      const spec = { effects: [this._fx.dbgSet.of(line)] };
      if (line !== null && name === this.active) {
        const st = this.view.state, pos = st.doc.line(Math.max(1, Math.min(line, st.doc.lines))).from;
        spec.effects.push(CM.EditorView.scrollIntoView(pos, { y: 'center' }));
      }
      this._apply(name, spec);
    }

    setBreakpoints(name, lines) { if (this._state(name)) this._apply(name, { effects: this._fx.bpSet.of(lines || []) }); }

    getBreakpoints(name) { const st = this._state(name); return st ? this._bpLines(st) : []; }

    toggleBreakpoint(line) {
      if (this.active === null) return;
      const st = this.view.state;
      const pos = line ? st.doc.line(Math.min(line, st.doc.lines)).from : st.selection.main.head;
      this.view.dispatch({ effects: this._fx.bpToggle.of({ pos }) });
    }

    gotoLine(name, line, col) {
      if (name !== this.active) return;
      const st = this.view.state;
      const ln = st.doc.line(Math.max(1, Math.min(line || 1, st.doc.lines)));
      const pos = ln.from + Math.min(Math.max(0, (col || 1) - 1), ln.length);
      this.view.dispatch({ selection: { anchor: pos }, effects: CM.EditorView.scrollIntoView(pos, { y: 'center' }) });
      this.view.focus();
    }

    cursor() {
      const st = this.view.state, head = st.selection.main.head, l = st.doc.lineAt(head);
      return { line: l.number, col: head - l.from + 1 };
    }

    focus() { this.view.focus(); }
    openSearch() { CM.openSearchPanel(this.view); }
  }

  root.KsEditor = KsEditor;
})(typeof self !== 'undefined' ? self : this);
