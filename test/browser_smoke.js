#!/usr/bin/env node
/*
 * browser_smoke.js — teste de fumaça da IDE num Chrome/Edge real, pelo
 * DevTools Protocol (opcional: fora do "make test", que não exige
 * navegador). Requer Node >= 22 (WebSocket global).
 *
 *   node test/browser_smoke.js [--chrome CAMINHO] [--dist dist] [--shots DIR]
 *
 * Abre dist/ksweb-single.html por file:// e dist/index.html por HTTP (um
 * servidor estático embutido), e em cada um:
 *   - exemplos pelo menu (hello, vtdemo, float), stdin no modo linha e no
 *     raw (maiusculas, ask_name);
 *   - o roteiro da IDE: abrir o exemplo fib, editar o fonte (lint sem
 *     erros), montar com Ctrl+B, breakpoint clicando no gutter, F5 até
 *     parar (linha destacada no editor), F10 por cima do call, F11 para
 *     dentro (abre a aba de lib/io.ksasm), Shift+F11 de volta, ler
 *     registradores, breakpoint em linha sem código movido para a próxima,
 *     remover e terminar, recarregar a página (projeto recuperado do
 *     IndexedDB), desassembly com breakpoint por endereço;
 *   - modo simples: um .ksx pelo seletor de arquivo roda direto e mostra o
 *     desassembly; F1 abre a ajuda.
 * Falha em qualquer exceção ou console.error da página. --shots salva PNGs.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');
const { spawn } = require('child_process');

const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
const DIST = path.resolve(args.dist || 'dist');
const CHROME = args.chrome || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
].find((p) => fs.existsSync(p));
const SHOTS = args.shots ? path.resolve(args.shots) : null;
const PORT = 9300 + Math.floor(Math.random() * 500);

if (typeof WebSocket === 'undefined') { console.log('browser_smoke: precisa de Node >= 22 (WebSocket); pulando'); process.exit(0); }
if (!CHROME) { console.log('browser_smoke: Chrome/Edge não encontrado; pulando'); process.exit(0); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const log = (...a) => console.log(...a);

function serve(dir) {
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.ksx': 'application/octet-stream', '.json': 'application/json' };
  const srv = http.createServer((req, res) => {
    const p = path.join(dir, decodeURIComponent(req.url.split('?')[0]).replace(/^\/$/, '/index.html'));
    if (!p.startsWith(dir) || !fs.existsSync(p)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': types[path.extname(p)] || 'application/octet-stream' });
    res.end(fs.readFileSync(p));
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)));
}

const VK = { Enter: 13, Backspace: 8, Tab: 9, Escape: 27, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, F1: 112, F5: 116, F9: 120, F10: 121, F11: 122 };

class Cdp {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.wait = new Map(); this.events = [];
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.wait.has(m.id)) { this.wait.get(m.id)(m); this.wait.delete(m.id); }
      else if (m.method) this.events.push(m);
    };
  }
  send(method, params) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params: params || {} }));
    return new Promise((res, rej) => this.wait.set(id, (m) => (m.error ? rej(new Error(method + ': ' + m.error.message)) : res(m.result))));
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error('eval: ' + (r.exceptionDetails.exception ? r.exceptionDetails.exception.description : r.exceptionDetails.text));
    return r.result.value;
  }
  async until(expr, ms, what) {
    const t0 = Date.now();
    for (;;) {
      let v = null;
      try {
        v = await this.eval('(() => { const v = (' + expr + '); return v && typeof v === "object" ? true : v; })()');
      } catch (e) {
        if (Date.now() - t0 > (ms || 8000)) throw e;        /* página ainda carregando */
      }
      if (v) return v;
      if (Date.now() - t0 > (ms || 8000)) throw new Error('timeout: ' + (what || expr));
      await sleep(50);
    }
  }
  /* modifiers: 1 Alt, 2 Ctrl, 4 Meta, 8 Shift */
  async key(key, opts) {
    opts = opts || {};
    const vk = VK[key] || key.toUpperCase().charCodeAt(0);
    const code = key.length === 1 ? (/[a-z]/i.test(key) ? 'Key' + key.toUpperCase() : 'Digit' + key) : key;
    const base = { key, code, windowsVirtualKeyCode: vk, modifiers: opts.modifiers || 0 };
    const text = key === 'Enter' ? '\r' : (key.length === 1 && !(opts.modifiers & 2) ? key : undefined);
    await this.send('Input.dispatchKeyEvent', Object.assign({ type: text ? 'keyDown' : 'rawKeyDown', text }, base));
    await this.send('Input.dispatchKeyEvent', Object.assign({ type: 'keyUp' }, base));
  }
  async type(s) { for (const ch of s) await this.key(ch); }
  async click(x, y) {
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  }
  async shot(name) {
    if (!SHOTS) return;
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.mkdirSync(SHOTS, { recursive: true });
    fs.writeFileSync(path.join(SHOTS, name + '.png'), Buffer.from(r.data, 'base64'));
  }
  problems() {
    return this.events.filter((e) => e.method === 'Runtime.exceptionThrown' ||
      (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error') ||
      (e.method === 'Log.entryAdded' && e.params.entry.level === 'error' && !/favicon/.test(e.params.entry.url || '')))
      .map((e) => JSON.stringify(e.params).slice(0, 300));
  }
}

const termText = 'document.querySelector("#term").innerText';
const vmState = 'ksweb.state.vmState';
const pickExpr = (name) => `(() => { const s = document.querySelector('#examples'); s.value = '${name}'; s.dispatchEvent(new Event('change')); return true; })()`;
/* linha (1-based) da seta da depuração no editor, ou null */
const debugLine = '(() => { const v = ksweb.editor.view, p = v.state.field(ksweb.editor._fx.dbgField); return p === null ? null : v.state.doc.lineAt(p).number; })()';
const activeTab = "((document.querySelector('#tabs .tab[aria-selected=true]') || {}).title || null)";

async function check(label, fn) {
  try { await fn(); log('  ok  ' + label); } catch (e) { failures++; log('  FALHA ' + label + ': ' + e.message); }
}

/* Centro do gutter de breakpoints na linha n do arquivo ativo. */
async function gutterXY(cdp, n) {
  await cdp.eval(`(() => { const v = ksweb.editor.view; v.dispatch({ effects: CM.EditorView.scrollIntoView(v.state.doc.line(${n}).from, { y: 'center' }) }); return true; })()`);
  await cdp.eval('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))');
  return cdp.eval(`(() => {
    const v = ksweb.editor.view;
    const b = v.lineBlockAt(v.state.doc.line(${n}).from);
    const g = document.querySelector('.cm-ks-gutter').getBoundingClientRect();
    const top = v.documentTop + b.top;
    return [g.left + g.width / 2, top + b.height / 2];
  })()`);
}
async function lineOf(cdp, re) {
  return cdp.eval(`(() => { const d = ksweb.editor.view.state.doc; for (let i = 1; i <= d.lines; i++) if (${re}.test(d.line(i).text)) return i; return null; })()`);
}

async function scenario(cdp, label) {
  cdp.pick = async (name) => {
    await cdp.eval(pickExpr(name));
    await cdp.until('document.querySelector("#prog-name").textContent === "' + name + '.ksx"', 8000, 'carga de ' + name);
    await cdp.eval('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))');
  };
  log(label);
  await check('wasm e assembler carregados', async () => {
    await cdp.until(termText + '.includes("em WebAssembly")', 10000);
    await cdp.until('ksweb.state.asm.ready', 10000, 'asm worker');
    await cdp.until('document.querySelector(".cm-editor .cm-content")', 5000, 'editor');
    await cdp.eval('(ksweb.layout._size("bottom", 560), true)');      /* terminal com linhas para o vtdemo */
  });
  await check('hello (exemplo vira projeto e roda)', async () => {
    await cdp.pick('hello');
    await cdp.until(termText + '.includes("fim: código de saída 0")', 8000);
    const t = await cdp.eval(termText);
    if (!t.includes('Hello, KSVM!')) throw new Error('sem saída: ' + t.slice(0, 300));
    if (!t.includes('entry 0x00000000')) throw new Error('sem cabeçalho');
    const files = await cdp.eval('ksweb.state.project.fileNames().join(",")');
    if (files !== 'hello.ksasm') throw new Error('arquivos: ' + files);
  });
  await check('vtdemo (caixa DEC, cores)', async () => {
    await cdp.pick('vtdemo');
    await cdp.until(termText + '.includes("pronto!")', 10000);
    const t = await cdp.eval(termText);
    if (!t.includes('┌' + '─'.repeat(40) + '┐')) throw new Error('caixa ausente');
    if (!t.includes('progresso: 100%')) throw new Error('barra');
    const bg = await cdp.eval('getComputedStyle(document.querySelector("#term .term-screen .tl:nth-child(5) span[style]")).backgroundColor');
    if (!/rgb\(255, 0, 80\)/.test(bg)) throw new Error('truecolor: ' + bg);
    await cdp.shot(label + '-vtdemo');
  });
  await check('float', async () => {
    await cdp.pick('float');
    await cdp.until(termText + '.includes("fim: código de saída")', 8000);
    const t = await cdp.eval(termText);
    if (!t.includes('1/3 = 0x3EAAAAAB')) throw new Error(t.slice(0, 200));
  });
  await check('stdin: modo linha, Enter, Ctrl+D', async () => {
    await cdp.pick('maiusculas');
    await cdp.until(vmState + ' === "waiting"', 8000, 'esperando entrada');
    await cdp.eval('document.querySelector("#term").focus()');
    await cdp.type('abc');
    await cdp.key('Enter');
    await cdp.until(termText + '.includes("ABC")', 4000, 'eco em maiúsculas');
    await cdp.type('ksvm');
    await cdp.key('Enter');
    await cdp.until(termText + '.includes("KSVM")', 4000);
    await cdp.key('d', { modifiers: 2 });
    await cdp.until(termText + '.includes("2 linhas")', 4000, 'EOF');
    await cdp.until(termText + '.includes("fim: código de saída 2")', 4000);
    await cdp.shot(label + '-stdin');
  });
  await check('modo raw: tecla vai direto', async () => {
    await cdp.eval('(() => { const s = document.querySelector("#opt-mode"); s.value = "raw"; s.dispatchEvent(new Event("change")); })()');
    await cdp.pick('ask_name');
    await cdp.until(vmState + ' === "waiting"', 8000);
    await cdp.eval('document.querySelector("#term").focus()');
    await cdp.type('Zoe');
    await cdp.eval('document.querySelector("#btn-eof").click()');
    await cdp.until(termText + '.includes("Your name is Zoe")', 4000);
    await cdp.eval('(() => { const s = document.querySelector("#opt-mode"); s.value = "line"; s.dispatchEvent(new Event("change")); })()');
  });

  /* ---- roteiro da IDE ---- */
  let callLine = null;
  await check('IDE: abrir exemplo, editar, lint e Ctrl+B', async () => {
    await cdp.pick('fib');
    await cdp.until(termText + '.includes("4181")', 8000, 'fib roda');
    const n = await lineOf(cdp, '/^COUNT = 20/');
    if (!n) throw new Error('linha COUNT');
    await cdp.eval(`(() => { const v = ksweb.editor.view, l = v.state.doc.line(${n}); v.dispatch({ selection: { anchor: l.to - 2, head: l.to } }); v.focus(); })()`);
    await cdp.send('Input.insertText', { text: '5' });
    await cdp.until('ksweb.state.project.text("fib.ksasm").includes("COUNT = 5\\n")', 3000, 'texto no projeto');
    await cdp.until('ksweb.state.lint && ksweb.state.lint.version === ksweb.state.version', 4000, 'lint');
    const errs = await cdp.eval('document.querySelector("#problem-count").textContent');
    if (errs !== '0') throw new Error('erros de lint: ' + errs);
    await cdp.key('b', { modifiers: 2 });
    await cdp.until('document.querySelector("#asm-output").textContent.includes("= 0x00000005")', 4000, 'listing do Ctrl+B');
    await cdp.until('document.querySelectorAll("#disasm .dr.code").length > 40', 4000, 'desassembly');
  });
  await check('IDE: breakpoint no gutter, F5 até parar', async () => {
    callLine = await lineOf(cdp, '/^\\s+call\\s+print_u32/');
    const [x, y] = await gutterXY(cdp, callLine);
    await cdp.click(x, y);
    await cdp.until('ksweb.breakpoints().some((b) => b.line === ' + callLine + ' && b.addr === 0x10)', 3000, 'bp resolvido em 0x10');
    await cdp.eval('ksweb.editor.focus()');
    await cdp.key('F5');
    await cdp.until(vmState + ' === "break"', 5000, 'parou');
    await cdp.until(debugLine + ' === ' + callLine, 3000, 'linha destacada');
    await cdp.until('document.querySelector(".cm-debug-line")', 2000, 'decoração da linha');
    await cdp.shot(label + '-ide-break');
  });
  await check('IDE: F10 por cima do call, registradores', async () => {
    await cdp.key('F10');
    await cdp.until(debugLine + ' === ' + (callLine + 1), 4000, 'linha seguinte ao call');
    await cdp.until('/\\n0\\s*$/.test(' + termText + ')', 3000, 'print_u32 escreveu 0');
    const reg = (n) => cdp.eval('(() => { const t = [...document.querySelectorAll("#dbg-regs td.rn")].find((x) => x.textContent === "' + n + '"); return t ? t.nextElementSibling.textContent + " " + t.nextElementSibling.nextElementSibling.textContent : null; })()');
    const r17 = await reg('r17');
    if (r17 !== '0x00000001 1') throw new Error('r17 = 1 (b do Fibonacci): ' + r17);
    if (!/^0x[0-9A-F]{8} /.test(await reg('sp'))) throw new Error('tabela sem sp');
    if (!(await cdp.eval('[...document.querySelectorAll("#dbg-regs td.rn")].some((x) => x.textContent === "flags")'))) throw new Error('tabela sem flags');
    await cdp.until('document.querySelectorAll("#dbg-regs td.chg").length > 0', 3000, 'alterados destacados');
    await cdp.until('document.querySelectorAll("#dbg-mem .hl").length === 16', 3000, 'hexdump');
    await cdp.until('document.querySelectorAll("#dbg-stack .sl").length === 32', 3000, 'pilha');
  });
  await check('IDE: F11 entra em lib/io.ksasm, Shift+F11 volta', async () => {
    await cdp.key('F5');
    await cdp.until(vmState + ' === "break" && ' + debugLine + ' === ' + callLine, 5000, 'parou de novo no call');
    await cdp.key('F11');
    await cdp.until(activeTab + ' === "lib/io.ksasm"', 4000, 'aba do arquivo incluído');
    await cdp.until(debugLine + ' !== null && /subi\\s+sp/.test(ksweb.editor.view.state.doc.line(' + debugLine + ').text)', 3000,
      'linha de print_u32 destacada');
    await cdp.key('F11', { modifiers: 8 });
    await cdp.until(activeTab + ' === "fib.ksasm" && ' + debugLine + ' === ' + (callLine + 1), 4000, 'voltou ao chamador');
    await cdp.shot(label + '-ide-out');
  });
  await check('IDE: breakpoint em linha sem código vai para a próxima', async () => {
    const lbl = await lineOf(cdp, '/^loop:/');
    if (!lbl) throw new Error('"loop:" não achado no arquivo ativo ' + await cdp.eval(activeTab) + ': ' + await cdp.eval('ksweb.state.events.slice(-25).join(" / ")'));
    const [x, y] = await gutterXY(cdp, lbl);
    await cdp.click(x, y);
    await cdp.until('ksweb.breakpoints().some((b) => b.line === ' + (lbl + 1) + ' && b.moved === ' + lbl + ')', 3000, 'movido de loop: para a instrução');
    const lines = await cdp.eval('ksweb.editor.getBreakpoints("fib.ksasm").join(",")');
    if (lines !== (lbl + 1) + ',' + callLine) throw new Error('gutter: ' + lines);
    await cdp.until('document.querySelector("#dbg-bps").innerText.includes("movido")', 2000, 'lista mostra o movimento');
  });
  await check('IDE: 3 linhas acima dos breakpoints com a imagem antiga; Ctrl+B não troca o mapa; Continuar para na mesma instrução', async () => {
    const before = await cdp.eval('JSON.stringify(ksweb.breakpoints().map((b) => [b.line, b.addr]).sort((x, y) => x[0] - y[0]))');
    const bps = JSON.parse(before);
    if (bps.length !== 2 || bps.some((b) => b[1] === null)) throw new Error('breakpoints antes: ' + before);
    await cdp.eval('(() => { ksweb.editor.view.dispatch({ changes: { from: 0, insert: "; um\\n        nop\\n; três\\n" } }); return true; })()');
    await cdp.until('!document.querySelector("#stale").hidden', 2000, 'faixa de desatualizado');
    const want = JSON.stringify(bps.map(([l, a]) => [l + 3, a]));
    await cdp.until('JSON.stringify(ksweb.breakpoints().map((b) => [b.line, b.addr]).sort((x, y) => x[0] - y[0])) === ' + JSON.stringify(want), 3000,
      'mesmos endereços nas linhas +3: ' + want);
    /* uma linha nova com breakpoint fica pendente (não vai para a VM; com a
     * montagem desatualizada ele também não é movido) */
    await cdp.eval('(() => { const v = ksweb.editor.view; v.dispatch({ effects: ksweb.editor._fx.bpToggle.of({ pos: v.state.doc.line(2).from }) }); return true; })()');
    await cdp.until('ksweb.breakpoints().some((b) => b.line === 2 && b.pending && b.addr === null)', 2000, 'breakpoint pendente');
    await cdp.until('document.querySelector(".cm-ks-mark.bp.pending")', 2000, 'marca de pendente no gutter');
    await cdp.eval('(() => { const v = ksweb.editor.view; v.dispatch({ effects: ksweb.editor._fx.bpToggle.of({ pos: v.state.doc.line(2).from }) }); return true; })()');
    /* Ctrl+B monta o fonte novo (o nop desloca o código em 4 bytes), mas a
     * VM continua com a imagem antiga e com o mapa dela */
    await cdp.key('b', { modifiers: 2 });
    await cdp.until('ksweb.state.built && ksweb.state.built.version === ksweb.state.version', 4000, 'montou');
    await cdp.until('ksweb.state.built.result.info.symByName.get("_start").addr === 4', 2000, 'nova montagem deslocada');
    const after = await cdp.eval('JSON.stringify(ksweb.breakpoints().map((b) => [b.line, b.addr]).sort((x, y) => x[0] - y[0]))');
    if (after !== want) throw new Error('Ctrl+B trocou o mapa ativo: ' + after + ' != ' + want);
    const pc0 = await cdp.eval('ksweb.state.pc');
    await cdp.eval('ksweb.editor.focus()');
    await cdp.key('F5');
    await cdp.until(vmState + ' === "break" && ksweb.state.pc !== ' + pc0, 5000, 'parou');
    const pc = await cdp.eval('ksweb.state.pc');
    const hit = bps.find((b) => b[1] === pc);
    if (!hit) throw new Error('parou em 0x' + pc.toString(16) + ', fora dos breakpoints ' + before);
    await cdp.until(debugLine + ' === ' + (hit[0] + 3), 3000, 'linha atual = linha do breakpoint (+3)');
  });
  await check('IDE: remover breakpoints e terminar; projeto recuperado ao recarregar', async () => {
    await cdp.eval('document.querySelector("#dbg-bps").parentElement.querySelector("button:nth-of-type(2)").click()');
    await cdp.until('ksweb.breakpoints().length === 0', 2000, 'Limpar');
    await cdp.key('F5');
    await cdp.until(termText + '.includes("fim: código de saída 0")', 5000, 'terminou');
    const t = await cdp.eval(termText);
    if (!/0 1 1 2 3\n/.test(t)) throw new Error('saída com COUNT = 5: ' + t.slice(-200));
    await cdp.key('s', { modifiers: 2 });
    await sleep(400);
    await cdp.send('Page.reload');
    await sleep(500);
    await cdp.until('window.ksweb && ksweb.state.project && ksweb.state.project.name === "exemplo: fib"', 10000, 'projeto reaberto');
    await cdp.until('ksweb.state.project.text("fib.ksasm").includes("COUNT = 5\\n")', 3000, 'edição persistida');
    await cdp.until('ksweb.state.asm.ready && ksweb.state.ready', 10000, 'workers');
  });
  await check('IDE: desassembly com breakpoint por endereço', async () => {
    await cdp.eval('ksweb.build()');
    await cdp.until('document.querySelectorAll("#disasm .dr.code").length > 40', 4000);
    await cdp.eval('document.querySelector("[data-panel=disasm]").click()');
    await cdp.eval('document.querySelector("#disasm .dr.code[data-addr=\\"16\\"]").click()');
    await cdp.until('ksweb.breakpoints().some((b) => b.addr === 16 && b.file === "fib.ksasm")', 2000, 'vira breakpoint de fonte');
    await cdp.eval('document.querySelector("#btn-run").click()');
    await cdp.until(vmState + ' === "break"', 5000, 'parou');
    await cdp.until('document.querySelector("#disasm .dr.cur") && document.querySelector("#disasm .dr.cur").dataset.addr === "16"', 3000, 'pc destacado no desassembly');
    await cdp.shot(label + '-disasm');
    await cdp.eval('document.querySelector("#disasm .dr.code[data-addr=\\"16\\"]").click()');
    await cdp.eval('document.querySelector("#btn-continue").click()');
    await cdp.until(termText + '.includes("fim: código de saída 0")', 5000);
  });
  await check('modo simples: .ksx roda direto com desassembly; F1', async () => {
    const doc = await cdp.send('DOM.getDocument');
    const n = await cdp.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#file-ksx' });
    await cdp.send('DOM.setFileInputFiles', { nodeId: n.nodeId, files: [path.join(DIST, 'examples', 'hello.ksx')] });
    await cdp.until(termText + '.includes("Hello, KSVM!")', 6000, 'executou');
    await cdp.until('!document.querySelector("#ksx-view").hidden && document.querySelectorAll("#ksx-dis .dr.code").length > 3', 4000, 'desassembly no centro');
    await cdp.shot(label + '-ksx');
    await cdp.eval('document.body.focus()');
    await cdp.key('F1');
    await cdp.until('document.querySelector("#dlg-help").open', 2000, 'ajuda');
    await cdp.key('Escape');
    await cdp.until('!document.querySelector("#dlg-help").open', 2000, 'fecha');
    await cdp.eval('ksweb.openTab(ksweb.state.project.main)');
  });
  const p = cdp.problems();
  await check('sem exceções nem console.error', async () => { if (p.length) throw new Error(p.join('\n')); });
}

async function openPage(url) {
  const list = await (await fetch('http://127.0.0.1:' + PORT + '/json/new?' + encodeURIComponent(url), { method: 'PUT' })).json();
  const ws = new WebSocket(list.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  const cdp = new Cdp(ws);
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('Page.enable');
  await cdp.send('DOM.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 920, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Page.reload');
  await sleep(300);
  return cdp;
}

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ksweb-chrome-'));
  const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--allow-file-access-from-files', 'about:blank'], { stdio: 'ignore' });
  let srv;
  try {
    for (let i = 0; i < 100; i++) {
      try { await fetch('http://127.0.0.1:' + PORT + '/json/version'); break; } catch (e) { await sleep(100); }
    }
    const single = 'file:///' + path.join(DIST, 'ksweb-single.html').replace(/\\/g, '/');
    await scenario(await openPage(single), 'single');
    srv = await serve(DIST);
    await scenario(await openPage('http://127.0.0.1:' + srv.address().port + '/index.html'), 'http');
    log('duas abas da IDE');
    await check('aba ociosa fechada/recarregada não sobrescreve o que a outra salvou', async () => {
      const url = 'http://127.0.0.1:' + srv.address().port + '/index.html';
      const a = await openPage(url);
      await a.until('window.ksweb && ksweb.state.project && ksweb.state.asm.ready', 10000, 'aba A');
      const b = await openPage(url);
      await b.until('window.ksweb && ksweb.state.project && ksweb.state.asm.ready', 10000, 'aba B');
      const id = await a.eval('ksweb.state.project.id');
      if (await b.eval('ksweb.state.project.id') !== id) throw new Error('as abas abriram projetos diferentes');
      const main = await b.eval('ksweb.state.project.main');
      await b.eval(`(() => { ksweb.openTab(${JSON.stringify(main)}); ksweb.editor.view.dispatch({ changes: { from: 0, insert: '; editado na aba B\\n' } }); return true; })()`);
      const saved = `ksweb.state.store.load(${JSON.stringify(id)}).then((p) => p.text(${JSON.stringify(main)}).startsWith('; editado na aba B'))`;
      for (let i = 0; !(await b.eval(saved)); i++) { if (i > 80) throw new Error('B não salvou'); await sleep(50); }
      await a.send('Page.reload');                       /* beforeunload na aba A, que não editou nada */
      await sleep(500);
      await a.until('window.ksweb && ksweb.state.project && ksweb.state.store', 10000, 'A recarregada');
      const t = await a.eval(`ksweb.state.store.load(${JSON.stringify(id)}).then((p) => p.text(${JSON.stringify(main)}).slice(0, 40))`);
      if (!t.startsWith('; editado na aba B')) throw new Error('a edição da aba B se perdeu: ' + JSON.stringify(t));
      const p = a.problems().concat(b.problems());
      if (p.length) throw new Error(p.join('\n'));
    });
    const light = await openPage(single);
    await light.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
    log('tema claro');
    await check('tema claro aplica as cores', async () => {
      await light.until(termText + '.includes("em WebAssembly")', 10000);
      const bg = await light.eval('getComputedStyle(document.querySelector("#term")).backgroundColor');
      if (bg !== 'rgb(251, 251, 248)') throw new Error(bg);
      const ed = await light.eval('getComputedStyle(document.querySelector(".cm-editor")).backgroundColor');
      if (ed !== 'rgb(255, 255, 255)') throw new Error('editor: ' + ed);
      await light.eval(pickExpr('vtdemo'));
      await light.until(termText + '.includes("pronto!")', 10000);
      await light.shot('light-vtdemo');
    });
    log('lint de arquivo incluído');
    await check('erro no principal não vira erros falsos no incluído aberto', async () => {
      const c = await openPage(single);
      await c.until('window.ksweb && ksweb.state.project && ksweb.state.asm.ready', 10000, 'IDE');
      await c.eval(`(() => { const p = ksweb.state.project;
        p.addFile('t/principal.ksasm', 'LIMITE = 3\\n_start:\\n  call usa\\n  bogus r1\\n  halt\\n  .include "./usa.ksasm"\\n');
        p.addFile('t/usa.ksasm', 'usa:\\n  li r1, LIMITE\\n  ret\\n');
        ksweb.setMain('t/principal.ksasm'); ksweb.openTab('t/usa.ksasm'); return true; })()`);
      await c.until('ksweb.state.lint && ksweb.state.lint.version === ksweb.state.version && (ksweb.state.diags.get("t/principal.ksasm") || []).length === 1', 5000, 'erro no principal');
      await sleep(300);
      const d = await c.eval('JSON.stringify(ksweb.state.diags.get("t/usa.ksasm") || [])');
      if (d !== '[]') throw new Error('erros no incluído: ' + d);
    });
    log('armazenamento bloqueado e layout salvo corrompido');
    await check('localStorage e IndexedDB bloqueados (SecurityError): a IDE abre só em memória', async () => {
      const c = await openPage(single);
      await c.send('Page.addScriptToEvaluateOnNewDocument', { source:
        "for (const k of ['localStorage', 'indexedDB']) Object.defineProperty(window, k, { configurable: true, get() { throw new DOMException('bloqueado', 'SecurityError'); } });" });
      await c.send('Page.reload');
      await sleep(300);
      await c.until('window.ksweb && ksweb.state.project && ksweb.state.asm.ready', 10000, 'IDE carregada');
      const st = await c.eval('document.querySelector("#sb-store").textContent');
      if (st !== 'sem persistência') throw new Error('barra de status: ' + st);
      await c.eval('ksweb.build()');
      await c.until('document.querySelector("#asm-output").textContent.includes("; simbolos")', 4000, 'montou');
      const p = c.problems();
      if (p.length) throw new Error(p.join('\n'));
    });
    await check('layout salvo com tipos errados, tamanhos enormes ou JSON inválido', async () => {
      const c = await openPage(single);
      await c.until('window.ksweb && ksweb.layout', 10000);
      for (const saved of ['{"left":"x","right":50000,"bottom":-40,"no":7,"panel":3}', '{"left":2000,"right":2000,"no":{"left":"sim"}}', '{nao é json', '[1,2]']) {
        await c.eval('localStorage.setItem("ksweb-ide:layout", ' + JSON.stringify(saved) + ')');
        await c.send('Page.reload');
        await sleep(300);
        await c.until('window.ksweb && ksweb.layout && document.querySelector(".cm-editor")', 10000, 'recarregou');
        const w = await c.eval('document.querySelector(".center").getBoundingClientRect().width');
        if (!(w >= 300)) throw new Error(saved + ': centro com ' + w + 'px');
        const vars = await c.eval('["--left-w","--right-w","--bottom-h"].map((v) => document.documentElement.style.getPropertyValue(v)).join(" ")');
        if (!/^\d+px \d+px \d+px$/.test(vars)) throw new Error(saved + ': ' + vars);
      }
      await c.eval('localStorage.removeItem("ksweb-ide:layout")');
      const p = c.problems();
      if (p.length) throw new Error(p.join('\n'));
    });
    const fileIdx = await openPage('file:///' + path.join(DIST, 'index.html').replace(/\\/g, '/'));
    log('index.html por file://');
    await check('mensagem de orientação', () => fileIdx.until(termText + '.includes("WebAssembly") || ' + termText + '.includes("ksweb-single.html")', 8000));
  } catch (e) {
    failures++;
    log('FALHA geral: ' + e.stack);
  } finally {
    chrome.kill();
    if (srv) srv.close();
  }
  log('browser_smoke: ' + (failures ? failures + ' falhas' : 'ok'));
  process.exit(failures ? 1 : 0);
})();
