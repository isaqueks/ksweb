/*
 * asmtools.js — montagem no navegador com o ksas.wasm e a interpretação
 * da saída dele, sem DOM (usado pelo worker do assembler e pelos testes):
 *
 *   AsmTools.assemble(ksas, {files, main, debug, defines}) -> resultado
 *       roda "ksas MAIN -o .ksweb.ksx -l .ksweb.lst [-g] [-DX]" pelo shim
 *       WASI e devolve {ok, exitCode, stderr, diagnostics, image,
 *       listingText, listing, info, ms}
 *   AsmTools.disassemble(ksdis, image, raw) -> {ok, text, stderr}
 *   AsmTools.parseDiagnostics(stderr) -> [{file, line, col, message, text}]
 *   AsmTools.parseListing(text) -> {rows, sections, header, symbols, files}
 *   AsmTools.buildDebugInfo(listing) -> mapa linha <-> endereço
 *   AsmTools.resolveBreakpoint(info, file, line) -> {line, addr, moved} | null
 *   AsmTools.parseKsdis(text) -> [{text, addr, label, section}]
 *   AsmTools.byteColToChar(lineText, col) coluna do ksas (bytes UTF-8,
 *       1-based) -> índice de caractere (0-based)
 *
 * O listing do ksas (src/tools/ksas/listing.c) tem uma linha por linha do
 * fonte, "ENDERECO  BYTES  LINHA  FONTE", "; arquivo X" quando muda de
 * arquivo (.include), e no fim as seções e a tabela de símbolos. Uma linha
 * "gera código" quando tem bytes e o comando é uma instrução (não uma
 * diretiva de dados): só essas recebem breakpoints.
 */
(function (root) {
  'use strict';

  const isNode = typeof module !== 'undefined' && module.exports;
  const Lang = isNode ? require('./ksasm-lang.js') : root.KsasmLang;
  const Wasi = isNode ? require('./wasi.js') : root;

  const OUT_KSX = '.ksweb.ksx';
  const OUT_LST = '.ksweb.lst';
  const dec = new TextDecoder();

  /* Nome de arquivo como o ksas o cita (.include "./lib/x" vira "./lib/x",
   * "lib/../lib/x" fica assim) -> o caminho do projeto ("lib/x"), o mesmo
   * que o shim WASI abriu. Fora da raiz ou vazio: como veio. */
  function normFile(name) {
    if (!name) return name;
    /* a regra do normPath do wasi.js (que a página não carrega) */
    const parts = [];
    for (const s of name.split('/')) {
      if (s === '' || s === '.') continue;
      if (s === '..') { if (!parts.length) return name; parts.pop(); continue; }
      parts.push(s);
    }
    return parts.length ? parts.join('/') : name;
  }

  /* ---- diagnósticos ---- */

  function parseDiagnostics(stderr) {
    const out = [];
    for (const text of String(stderr || '').split('\n')) {
      if (!text) continue;
      let m = /^(.*?):(\d+):(\d+): erro: (.*)$/.exec(text);
      if (m) { out.push({ file: normFile(m[1]), line: +m[2], col: +m[3], message: m[4], text, severity: 'error' }); continue; }
      m = /^(.*?):(\d+): erro: (.*)$/.exec(text);
      if (m) { out.push({ file: normFile(m[1]), line: +m[2], col: 0, message: m[3], text, severity: 'error' }); continue; }
      m = /^(.*?): erro: (.*)$/.exec(text);
      if (m) { out.push({ file: normFile(m[1]), line: 0, col: 0, message: m[2], text, severity: 'error' }); continue; }
      m = /^ksas: (.*)$/.exec(text);
      if (m) {
        const summary = /erro\(s\); nenhuma saida gerada/.test(m[1]);
        out.push({ file: null, line: 0, col: 0, message: m[1], text, severity: summary ? 'info' : 'error' });
        continue;
      }
      out.push({ file: null, line: 0, col: 0, message: text, text, severity: 'error' });
    }
    return out;
  }

  /* Coluna do ksas (bytes, 1-based) -> índice de caractere JS (0-based). */
  function byteColToChar(lineText, col) {
    if (!col || col <= 1) return 0;
    let bytes = 0, i = 0;
    const target = col - 1;
    while (i < lineText.length && bytes < target) {
      const cp = lineText.codePointAt(i);
      bytes += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
      i += cp > 0xFFFF ? 2 : 1;
    }
    return i;
  }

  /* ---- listing ---- */

  function parseBytes(s) {
    if (!/^[0-9A-F]{2}( [0-9A-F]{2})*$/.test(s)) return null;
    return s.split(' ').map((x) => parseInt(x, 16));
  }

  function parseListing(text) {
    const rows = [], sections = [], symbols = [], files = [];
    let header = null, file = null, mode = 'rows', last = null;
    for (const line of String(text).split('\n')) {
      if (mode === 'rows') {
        if (line.startsWith('ENDERECO')) continue;
        let m = /^; arquivo (.*)$/.exec(line);
        if (m) { file = normFile(m[1]); if (!files.includes(file)) files.push(file); continue; }
        if (line === '; secoes') { mode = 'sections'; continue; }
        if (line === '') continue;
        m = /^(.{8})  (.*?)  +(\d+)  (.*)$/.exec(line);
        if (m && /^([0-9A-F]{8}| {8})$/.test(m[1])) {
          const addrText = m[1].trim(), bytesText = m[2].trim();
          const row = {
            file, line: +m[3], src: m[4], addr: addrText ? parseInt(addrText, 16) : null,
            bytesText, bytes: parseBytes(bytesText), kind: 'none', value: null
          };
          if (bytesText.startsWith('= 0x')) { row.kind = 'equ'; row.value = parseInt(bytesText.slice(4), 16); }
          else if (bytesText.startsWith('(reserva ')) { row.kind = 'data'; row.size = parseInt(bytesText.slice(9), 10); }
          else if (row.bytes) { row.kind = Lang.statementKind(row.src) === 'insn' ? 'insn' : 'data'; row.size = row.bytes.length; }
          else if (/\.\.\. \((\d+)\)$/.test(bytesText)) { row.kind = 'data'; row.size = +/\((\d+)\)$/.exec(bytesText)[1]; }
          else if (row.addr !== null) row.kind = 'label';
          rows.push(row);
          last = row;
          continue;
        }
        m = /^([0-9A-F]{8})  (.*)$/.exec(line);          /* continuação de dados */
        if (m && last) {
          const b = parseBytes(m[2].trim());
          if (b && last.bytes) { last.bytes = last.bytes.concat(b); last.size = last.bytes.length; }
        }
        continue;
      }
      if (line === '; simbolos') { mode = 'symbols'; continue; }
      if (mode === 'sections') {
        let m = /^;\s+(\.\w+)\s+0x([0-9A-F]{8})\s+(\d+) bytes/.exec(line);
        if (m) { sections.push({ name: m[1], base: parseInt(m[2], 16), size: +m[3] }); continue; }
        m = /^; entry 0x([0-9A-F]{8})\s+code (\d+)\s+data (\d+)\s+bss (\d+)\s+ram_base 0x([0-9A-F]{8})\s+stack (\d+)(\s+PIC)?/.exec(line);
        if (m) {
          header = { entry: parseInt(m[1], 16), codeSize: +m[2], dataSize: +m[3], bssSize: +m[4], ramBase: parseInt(m[5], 16), stackSize: +m[6], pic: !!m[7] };
        }
        continue;
      }
      if (mode === 'symbols') {
        const m = /^;\s+0x([0-9A-F]{8})\s+(\S+)\s+(\S+?)(  \(global\))?$/.exec(line);
        if (m) symbols.push({ addr: parseInt(m[1], 16), kind: m[2], name: m[3], global: !!m[4] });
      }
    }
    return { rows, sections, header, symbols, files };
  }

  /*
   * Mapa linha <-> endereço:
   *   lines     Map "arquivo\nlinha" -> {file, line, addr, size, kind}
   *   code      Map arquivo -> [linhas com instrução, em ordem]
   *   addrLine  Map endereço de instrução -> {file, line}
   *   symbols   [{name, addr, kind, global, file?, line?}], symByName Map
   */
  function buildDebugInfo(listing) {
    const lines = new Map(), code = new Map(), addrLine = new Map(), labelAt = new Map();
    for (const r of listing.rows) {
      if (r.addr === null && r.kind !== 'equ') continue;
      const key = r.file + '\n' + r.line;
      if (!lines.has(key)) lines.set(key, { file: r.file, line: r.line, addr: r.addr, size: r.size || 0, kind: r.kind, value: r.value });
      if (r.kind === 'insn') {
        if (!code.has(r.file)) code.set(r.file, []);
        const arr = code.get(r.file);
        if (arr[arr.length - 1] !== r.line) arr.push(r.line);
        if (!addrLine.has(r.addr)) addrLine.set(r.addr, { file: r.file, line: r.line });
      }
      if (r.kind === 'label' || r.kind === 'equ' || r.kind === 'insn' || r.kind === 'data') {
        for (const t of Lang.tokenizeLine(r.src)) {
          if (t.type === 'labelDef') labelAt.set(t.text, { file: r.file, line: r.line });
        }
      }
    }
    for (const arr of code.values()) arr.sort((a, b) => a - b);
    const symbols = listing.symbols.map((s) => Object.assign({}, s, labelAt.get(s.name) || {}));
    const symByName = new Map(symbols.map((s) => [s.name, s]));
    return { lines, code, addrLine, symbols, symByName, header: listing.header, files: listing.files };
  }

  /* Endereço da instrução de (file, line); se a linha não gera código, a
   * próxima linha com código do mesmo arquivo (como as IDEs fazem). */
  function resolveBreakpoint(info, file, line) {
    const arr = info && info.code.get(file);
    if (!arr) return null;
    let lo = 0, hi = arr.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] < line) lo = mid + 1; else hi = mid; }
    if (lo >= arr.length) return null;
    const l = arr[lo];
    return { line: l, addr: info.lines.get(file + '\n' + l).addr, moved: l !== line };
  }

  /* Arquivos alcançados a partir de main pelos .include (estático, como o
   * ksas resolve: relativo ao arquivo que inclui). Serve para saber se um
   * arquivo faz parte da montagem quando ela falhou e não há listing. */
  function includeClosure(files, main) {
    const fm = toFileMap(files), seen = new Set(), stack = [normFile(main)];
    while (stack.length) {
      const f = stack.pop();
      if (seen.has(f) || !fm.has(f)) continue;
      seen.add(f);
      const v = fm.get(f), text = typeof v === 'string' ? v : dec.decode(v);
      const dir = f.includes('/') ? f.slice(0, f.lastIndexOf('/') + 1) : '';
      for (const m of text.matchAll(/^[^;#"\n]*?\.include\s+"([^"\n]*)"/gim)) {
        const p = m[1];
        stack.push(normFile(p.startsWith('/') ? p : dir + p));
      }
    }
    return seen;
  }

  /* ---- execução das ferramentas ---- */

  function toFileMap(files) {
    const m = new Map();
    if (files instanceof Map) { for (const [k, v] of files) m.set(k, v); }
    else for (const k of Object.keys(files || {})) m.set(k, files[k]);
    return m;
  }

  function assemble(ksas, opts) {
    const t0 = (typeof performance !== 'undefined' ? performance : Date).now();
    const files = toFileMap(opts.files);
    files.delete(OUT_KSX);
    files.delete(OUT_LST);
    const argv = ['ksas', opts.main, '-o', OUT_KSX, '-l', OUT_LST];
    if (opts.debug !== false) argv.push('-g');
    for (const d of opts.defines || []) argv.push('-D' + d);
    const r = Wasi.runWasi(ksas, { args: argv, files });
    const res = {
      ok: r.exitCode === 0, exitCode: r.exitCode, stderr: r.stderr,
      diagnostics: parseDiagnostics(r.stderr), image: null, listingText: '', listing: null, info: null,
      main: opts.main
    };
    if (res.ok) {
      res.image = r.files.get(OUT_KSX) || null;
      res.listingText = r.files.has(OUT_LST) ? dec.decode(r.files.get(OUT_LST)) : '';
      res.listing = parseListing(res.listingText);
      res.info = buildDebugInfo(res.listing);
      if (!res.image) { res.ok = false; res.diagnostics.push({ file: null, line: 0, col: 0, message: 'ksas não gerou a imagem', text: '', severity: 'error' }); }
    }
    res.ms = (typeof performance !== 'undefined' ? performance : Date).now() - t0;
    return res;
  }

  function disassemble(ksdis, image, raw) {
    const argv = ['ksdis', 'prog.ksx'];
    if (raw) argv.push('--raw');
    const r = Wasi.runWasi(ksdis, { args: argv, files: new Map([['prog.ksx', image]]) });
    return { ok: r.exitCode === 0, text: r.stdout, stderr: r.stderr, exitCode: r.exitCode };
  }

  /* Linhas da listagem do ksdis com o endereço de cada instrução/dado. */
  function parseKsdis(text) {
    const out = [];
    let section = null;
    for (const line of String(text).split('\n')) {
      let m = /^; ---- (\.\w+)/.exec(line);
      if (m) section = m[1];
      m = /^\s+([0-9A-F]{8}):\s/.exec(line);
      const lb = /^([A-Za-z_][\w.]*):\s*$/.exec(line);
      out.push({ text: line, addr: m ? parseInt(m[1], 16) : null, label: lb ? lb[1] : null, section, code: !!m && section === '.text' });
    }
    if (out.length && out[out.length - 1].text === '') out.pop();
    return out;
  }

  const api = {
    assemble, disassemble, parseDiagnostics, parseListing, buildDebugInfo, resolveBreakpoint,
    parseKsdis, byteColToChar, normFile, includeClosure, OUT_KSX, OUT_LST
  };
  if (isNode) module.exports = api;
  else root.AsmTools = api;
})(typeof self !== 'undefined' ? self : this);
