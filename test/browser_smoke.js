#!/usr/bin/env node
/*
 * browser_smoke.js — teste de fumaça da página num Chrome/Edge real, pelo
 * DevTools Protocol (opcional: fora do "make test", que não exige
 * navegador). Requer Node >= 22 (WebSocket global).
 *
 *   node test/browser_smoke.js [--chrome CAMINHO] [--dist dist] [--shots DIR]
 *
 * Abre dist/ksweb-single.html por file:// e dist/index.html por HTTP (um
 * servidor estático embutido), e em cada um: espera o wasm, roda exemplos
 * pelo menu (hello, vtdemo, float), digita no terminal para o exemplo de
 * stdin (modo linha, Enter, Ctrl+D), abre o depurador, para num breakpoint,
 * dá um passo e confere registradores/disassembly/memória. Falha em
 * qualquer exceção ou console.error da página. --shots salva PNGs.
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
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.ksx': 'application/octet-stream' };
  const srv = http.createServer((req, res) => {
    const p = path.join(dir, decodeURIComponent(req.url.split('?')[0]).replace(/^\/$/, '/index.html'));
    if (!p.startsWith(dir) || !fs.existsSync(p)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': types[path.extname(p)] || 'application/octet-stream' });
    res.end(fs.readFileSync(p));
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)));
}

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
      const v = await this.eval(expr);
      if (v) return v;
      if (Date.now() - t0 > (ms || 8000)) throw new Error('timeout: ' + (what || expr));
      await sleep(50);
    }
  }
  async key(key, opts) {
    opts = opts || {};
    const special = { Enter: 13, Backspace: 8, Tab: 9, Escape: 27, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39 };
    const vk = special[key] || key.toUpperCase().charCodeAt(0);
    const base = { key, code: key.length === 1 ? 'Key' + key.toUpperCase() : key, windowsVirtualKeyCode: vk, modifiers: opts.modifiers || 0 };
    const text = key === 'Enter' ? '\r' : (key.length === 1 && !opts.modifiers ? key : undefined);
    await this.send('Input.dispatchKeyEvent', Object.assign({ type: text ? 'keyDown' : 'rawKeyDown', text }, base));
    await this.send('Input.dispatchKeyEvent', Object.assign({ type: 'keyUp' }, base));
  }
  async type(s) { for (const ch of s) await this.key(ch); }
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
const pickExpr = (name) => `(() => { const s = document.querySelector('#examples'); s.value = '${name}'; s.dispatchEvent(new Event('change')); return true; })()`;

async function check(label, fn) {
  try { await fn(); log('  ok  ' + label); } catch (e) { failures++; log('  FALHA ' + label + ': ' + e.message); }
}

async function scenario(cdp, label) {
  /* escolhe um exemplo e espera a tela já limpa mostrar a carga dele (o
   * redesenho é no próximo quadro: sem isso innerText ainda é o anterior) */
  cdp.pick = async (name) => {
    await cdp.eval(pickExpr(name));
    await cdp.until('document.querySelector("#prog-name").textContent === "' + name + '.ksx"', 5000, 'carga de ' + name);
    await cdp.eval('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))');
  };
  log(label);
  await check('wasm carregado', () => cdp.until(termText + '.includes("em WebAssembly")', 10000));
  await check('hello', async () => {
    await cdp.pick('hello');
    await cdp.until(termText + '.includes("fim: código de saída 0")', 8000);
    const t = await cdp.eval(termText);
    if (!t.includes('Hello, KSVM!')) throw new Error('sem saída: ' + t.slice(0, 300));
    if (!t.includes('entry 0x00000000')) throw new Error('sem cabeçalho');
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
    await cdp.until('document.querySelector("#status").dataset.state === "waiting"', 8000, 'esperando entrada');
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
    await cdp.until('document.querySelector("#status").dataset.state === "waiting"', 8000);
    await cdp.eval('document.querySelector("#term").focus()');
    await cdp.type('Zoe');
    await cdp.eval('(() => { document.querySelector("#btn-eof").click(); })()');
    await cdp.until(termText + '.includes("Your name is Zoe")', 4000);
    await cdp.eval('(() => { const s = document.querySelector("#opt-mode"); s.value = "line"; s.dispatchEvent(new Event("change")); })()');
  });
  await check('depurador: breakpoint, passo, registradores, memória', async () => {
    await cdp.eval('document.querySelector("#opt-autorun").checked = false');
    await cdp.eval('document.querySelector("#btn-dbg").click()');
    await cdp.pick('fib');
    await cdp.until('!document.querySelector("#btn-run").disabled', 5000, 'pronto');
    await cdp.until('document.querySelectorAll("#dbg-dis .dl").length > 5', 5000, 'disassembly');
    /* breakpoint clicando na 4a linha do disassembly */
    const addr = await cdp.eval('(() => { const l = document.querySelectorAll("#dbg-dis .dl")[3]; l.click(); return l.querySelector(".ad").textContent; })()');
    await cdp.until('document.querySelector("#dbg-bps").innerText.includes("0x' + addr + '")', 3000, 'lista de bps');
    await cdp.eval('document.querySelector("#btn-run").click()');
    await cdp.until('document.querySelector("#status").dataset.state === "break"', 5000, 'parou no bp');
    const cur = await cdp.eval('document.querySelector("#dbg-dis .dl.cur .ad").textContent');
    if (cur !== addr) throw new Error('pc ' + cur + ' != bp ' + addr);
    await cdp.eval('document.querySelector("#btn-step").click()');
    await cdp.until('document.querySelectorAll("#dbg-regs td.chg").length > 0', 3000, 'registradores alterados destacados');
    const regs = await cdp.eval('document.querySelector("#dbg-regs").innerText');
    if (!/sp\s+0x/.test(regs) || !/flags/.test(regs)) throw new Error('tabela: ' + regs.slice(0, 200));
    await cdp.until('document.querySelectorAll("#dbg-mem .hl").length === 16', 3000, 'hexdump');
    await cdp.until('document.querySelectorAll("#dbg-stack .sl").length === 32', 3000, 'pilha');
    await cdp.shot(label + '-debugger');
    await cdp.eval('document.querySelector("#dbg-bps button").click()');
    await cdp.eval('document.querySelector("#btn-run").click()');
    await cdp.until(termText + '.includes("4181")', 5000, 'termina sem bp');
    await cdp.eval('document.querySelector("#opt-autorun").checked = true');
    await cdp.eval('document.querySelector("#btn-dbg").click()');
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
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Page.reload');
  await sleep(300);
  return cdp;
}

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ksweb-chrome-'));
  const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', 'about:blank'], { stdio: 'ignore' });
  let srv;
  try {
    for (let i = 0; i < 100; i++) {
      try { await fetch('http://127.0.0.1:' + PORT + '/json/version'); break; } catch (e) { await sleep(100); }
    }
    const single = 'file:///' + path.join(DIST, 'ksweb-single.html').replace(/\\/g, '/');
    await scenario(await openPage(single), 'single');
    srv = await serve(DIST);
    await scenario(await openPage('http://127.0.0.1:' + srv.address().port + '/index.html'), 'http');
    const light = await openPage(single);
    await light.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
    log('tema claro');
    await check('tema claro aplica as cores', async () => {
      await light.until(termText + '.includes("em WebAssembly")', 10000);
      const bg = await light.eval('getComputedStyle(document.querySelector("#term")).backgroundColor');
      if (bg !== 'rgb(251, 251, 248)') throw new Error(bg);
      await light.eval(pickExpr('vtdemo'));
      await light.until(termText + '.includes("pronto!")', 10000);
      await light.shot('light-vtdemo');
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
