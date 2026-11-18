#!/usr/bin/env node
/*
 * run_node.js — testa build/ksvm.wasm em Node contra o ksvm nativo (oráculo).
 *
 *   node test/run_node.js --wasm build/ksvm.wasm --native build/native \
 *        --examples build/examples --ksvm2 ../ksvm2
 *
 * Compara stdout, código de saída e a mensagem de fault/limite com o runner
 * nativo para: todos os exemplos montados da ksvm2 e do ksweb, os casos de
 * tests/tools/test_runner.sh que se aplicam ao navegador (imagens do mkimg)
 * e o trace (--trace). Cobre também a API específica do ksweb: suspensão por
 * falta de entrada e retomada, modo poll, SLEEP_MS/YIELD, limite de
 * instruções, imagens inválidas, RAM insuficiente, ksweb_step + disasm
 * contra o ksdis, breakpoints, paradas em BRK/SYSCALL, mem_read, regiões e
 * cabeçalho.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { KsCore, KsSession, STATE } = require('../web/vmcore.js');

/* ---- argumentos ---- */
const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
const WASM = fs.readFileSync(args.wasm || 'build/ksvm.wasm');
const NATIVE = args.native || 'build/native';
const KSVM = path.join(NATIVE, 'tools/ksvm');
const KSDIS = path.join(NATIVE, 'tools/ksdis');
const MKIMG = path.join(NATIVE, 'mkimg');
const EXDIR = args.examples || 'build/examples';
const WORK = path.resolve(args.work || 'build/test-tmp');

/* ---- mini harness ---- */
let total = 0, failed = 0;
const failures = [];
function test(name, fn) {
  total++;
  try {
    fn();
  } catch (e) {
    failed++;
    failures.push(name);
    console.log('FALHA [' + name + '] ' + (e && e.message ? e.message : e));
  }
}
function eq(a, b, what) {
  if (a !== b) throw new Error((what || 'valor') + ': ' + JSON.stringify(a) + ' != esperado ' + JSON.stringify(b));
}
function ok(c, what) {
  if (!c) throw new Error(what || 'condição falsa');
}
const hex = (v) => '0x' + (v >>> 0).toString(16).toUpperCase().padStart(8, '0');

/* ---- oráculo ---- */
function native(file, opts) {
  opts = opts || {};
  const a = [];
  if (opts.ram) a.push('--ram', String(opts.ram));
  if (opts.stack) a.push('--stack', String(opts.stack));
  if (opts.maxInsns) a.push('--max-insns', String(opts.maxInsns));
  if (opts.trace) a.push('--trace');
  if (opts.noFs) a.push('--no-fs');
  a.push(file);
  const r = spawnSync(KSVM, a, { input: opts.input || '', maxBuffer: 1 << 28 });
  return { rc: r.status, stdout: r.stdout, stderr: r.stderr.toString('latin1') };
}

/* Linha "fault: ..." ou o pc do "limite de N instrucoes" do stderr nativo. */
function nativeFinishLine(stderr) {
  const f = stderr.split('\n').find((l) => l.startsWith('fault: '));
  if (f) return f;
  const m = /limite de (\d+) instrucoes atingido \(pc=(0x[0-9A-F]{8})\)/.exec(stderr);
  if (m) return 'limit ' + m[1] + ' ' + m[2];
  const i = /imagem invalida: (\w+)/.exec(stderr);
  if (i) return 'image ' + i[1];
  return '';
}

function webFinishLine(info) {
  if (!info) return '';
  if (info.kind === 'fault') return info.message;
  if (info.kind === 'limit') return 'limit ' + /de (\d+)/.exec(info.message)[1] + ' ' + /pc=(0x[0-9A-F]{8})/.exec(info.message)[1];
  if (info.kind === 'load' && info.err !== undefined) return 'image ' + /: (\w+)$/.exec(info.message)[1];
  return '';
}

/* ---- execução no wasm ---- */
function newCore() {
  let t = 0;
  return KsCore.createSync(WASM, { clock: () => (t += 0.001) });
}

function web(file, opts) {
  opts = opts || {};
  const core = newCore();
  if (opts.trace) core.traceEnable(65536);
  const s = new KsSession(core, {
    ramSize: opts.ram || (1 << 20), stackSize: opts.stack || 0, maxInsns: opts.maxInsns || 0,
    slice: opts.slice || 200000, stdinBlock: opts.stdinBlock !== false
  });
  const image = fs.readFileSync(file);
  const err = s.load(image);
  if (err) return { rc: err.code, stdout: Buffer.alloc(0), info: err, core };
  if (opts.trace) core.traceEnable(65536);
  const r = s.runSync(opts.input || '');
  return { rc: r.info.code, stdout: Buffer.from(r.stdout), info: r.info, core, run: r };
}

function compare(name, file, opts) {
  test(name, () => {
    const n = native(file, opts), w = web(file, opts);
    eq(w.rc, n.rc, 'código de saída');
    eq(w.stdout.toString('latin1'), n.stdout.toString('latin1'), 'stdout');
    eq(webFinishLine(w.info), nativeFinishLine(n.stderr), 'mensagem final');
    if (opts && opts.trace) {
      let nl = n.stderr.split('\n').filter((l) => l && !l.startsWith('fault: ') && !l.startsWith('ksvm: '));
      const wt = w.core.traceText();
      if (w.core.traceTotal() > w.core.traceCount()) {
        /* o anel guarda só os últimos 65536 registros: compara a cauda */
        nl = nl.slice(nl.length - (wt.split('\n').length - 1));
      }
      const nt = nl.join('\n') + '\n';
      if (wt !== nt) {
        const a = wt.split('\n'), b = nt.split('\n');
        let i = 0;
        while (i < a.length && a[i] === b[i]) i++;
        throw new Error('trace difere na linha ' + (i + 1) + ':\n  wasm:   ' + a[i] + '\n  nativo: ' + b[i]);
      }
    }
  });
}

/* ---- preparação: imagens do mkimg (test_runner.sh) ---- */
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });
const MK = {};
for (const p of ['hello', 'halt42', 'fault', 'trap', 'loop', 'echo', 'files', 'stack', 'rawedge']) {
  MK[p] = path.join(WORK, p + '.ksx');
  const r = spawnSync(MKIMG, [p, MK[p]]);
  if (r.status !== 0) { console.log('mkimg ' + p + ' falhou'); process.exit(1); }
}
const helloBytes = fs.readFileSync(MK.hello);
fs.writeFileSync(path.join(WORK, 'bad.ksx'), helloBytes.subarray(0, 50));
const corrupt = Buffer.from(helloBytes);
corrupt[100] = 'X'.charCodeAt(0);
fs.writeFileSync(path.join(WORK, 'corrupt.ksx'), corrupt);
fs.writeFileSync(path.join(WORK, 'empty'), Buffer.alloc(0));
const badMagic = Buffer.from(helloBytes);
badMagic[0] = 0;
fs.writeFileSync(path.join(WORK, 'badmagic.ksx'), badMagic);

/* ---- 1. exemplos (ksvm2/examples e ksweb/examples) ---- */
const INPUTS = { ask_name: 'Isaque\n', maiusculas: 'abc\nKsvm 2\nfim sem newline' };
const examples = fs.readdirSync(EXDIR).filter((f) => f.endsWith('.ksx')).sort();
ok(examples.length >= 10, 'poucos exemplos em ' + EXDIR);
for (const f of examples) {
  const name = path.basename(f, '.ksx');
  compare('exemplo-' + name, path.join(EXDIR, f), { input: INPUTS[name] || '' });
  compare('exemplo-' + name + '-trace', path.join(EXDIR, f), { input: INPUTS[name] || '', trace: true });
}

/* ---- 2. casos do test_runner.sh ---- */
compare('runner-hello', MK.hello, {});
compare('runner-halt42', MK.halt42, {});
compare('runner-fault', MK.fault, {});
compare('runner-trap', MK.trap, {});
compare('runner-max-insns', MK.loop, { maxInsns: 1000 });
compare('runner-stack-ok', MK.stack, {});
compare('runner-stack-override', MK.stack, { stack: 8 });
compare('runner-small-ram', MK.hello, { ram: 64 });
compare('runner-bad-image', path.join(WORK, 'bad.ksx'), {});
compare('runner-corrupt-checksum', path.join(WORK, 'corrupt.ksx'), {});
compare('runner-bad-magic', path.join(WORK, 'badmagic.ksx'), {});
compare('runner-empty-file', path.join(WORK, 'empty'), {});
compare('runner-max-insns-exact-4', MK.halt42, { maxInsns: 4 });
compare('runner-max-insns-exact-3', MK.halt42, { maxInsns: 3 });
compare('runner-ram-1k', MK.halt42, { ram: 1024, maxInsns: 16 });
compare('runner-echo-block', MK.echo, { input: 'abc\nde' });
compare('runner-echo-poll', MK.echo, { input: 'xyz', stdinBlock: false });
compare('runner-files-no-fs', MK.files, { noFs: true });
compare('runner-trace-halt42-brk', MK.halt42, { trace: true });
compare('runner-trace-hello', MK.hello, { trace: true });
compare('runner-trace-fault', MK.fault, { trace: true });
compare('runner-trace-rawedge', MK.rawedge, { trace: true, maxInsns: 100000 });
compare('runner-trace-echo', MK.echo, { trace: true, input: 'ab\nc' });
compare('runner-trace-limit', MK.loop, { trace: true, maxInsns: 50 });

test('runner-ram-invalida', () => {
  const core = newCore();
  const s = new KsSession(core, { ramSize: 0 });
  eq(s.load(helloBytes).code, 64, 'RAM 0 = uso (64), como ksvm --ram 0');
  const s2 = new KsSession(newCore(), { ramSize: 2 * 1024 * 1024 * 1024 - 1 });
  eq(s2.load(helloBytes).code, 64, 'RAM acima do máximo do ksweb');
});

/* ---- 3. entrada: suspensão e retomada ---- */
test('stdin-suspende-sem-girar', () => {
  const core = newCore();
  const s = new KsSession(core, { slice: 1000 });
  eq(s.load(fs.readFileSync(MK.echo)), null, 'load');
  let r = s.tick();
  eq(r.action, 'wait', 'primeira fatia sem entrada');
  const n0 = core.insnCount(), pc0 = core.pc();
  for (let i = 0; i < 5; i++) {
    r = s.tick();
    eq(r.action, 'wait', 'continua esperando');
  }
  eq(core.insnCount(), n0, 'nenhuma instrução executada enquanto espera');
  eq(core.pc(), pc0, 'pc parado na syscall');
  eq(core.disasmAt(pc0).text, 'syscall 0x11', 'pc aponta para GETC');
  s.pushInput(Buffer.from('hi'));
  r = s.tick();
  eq(r.action, 'wait', 'consumiu e voltou a esperar');
  eq(Buffer.from(core.takeOutput()).toString(), 'hi', 'eco');
  s.eof();
  r = s.tick();
  eq(r.action, 'done', 'EOF termina');
  eq(r.info.code, 0, 'exit 0');
});

test('stdin-gets-linha-em-pedacos', () => {
  const core = newCore();
  const s = new KsSession(core, {});
  s.load(fs.readFileSync(path.join(EXDIR, 'ask_name.ksx')));
  eq(s.tick().action, 'wait', 'espera a linha');
  s.pushInput(Buffer.from('Isa'));
  eq(s.tick().action, 'wait', 'linha incompleta: GETS repete (bloqueante)');
  eq(core.inputPending(), 3, 'bytes devolvidos ao anel');
  s.pushInput(Buffer.from('que\n'));
  const r = s.tick();
  eq(r.action, 'done', 'termina');
  const n = native(path.join(EXDIR, 'ask_name.ksx'), { input: 'Isaque\n' });
  eq(Buffer.from(core.takeOutput()).toString('latin1'), n.stdout.toString('latin1'), 'mesma saída do nativo');
});

test('stdin-poll-yield', () => {
  const core = newCore();
  const s = new KsSession(core, { stdinBlock: false, slice: 5000 });
  s.load(fs.readFileSync(path.join(EXDIR, 'maiusculas.ksx')));
  let r = s.tick();
  eq(r.action, 'sleep', 'modo poll: GETS devolve 0 e o programa faz YIELD');
  eq(r.ms, 0, 'YIELD sem prazo');
  s.pushInput(Buffer.from('xy\n'));
  s.eof();
  for (let i = 0; i < 20 && r.action !== 'done'; i++) r = s.tick();
  eq(r.action, 'done', 'termina');
  eq(Buffer.from(core.takeOutput()).toString(), '> XY\n> 1 linhas\n', 'saída (prompt uma vez; GETS vazio só repete)');
  eq(r.info.code, 1, 'exit = linhas');
});

test('stdin-arquivo-grande-maior-que-o-anel', () => {
  const lines = [];
  for (let i = 0; i < 4000; i++) lines.push('linha numero ' + i + ' abcdefghij');
  const input = lines.join('\n') + '\n';
  ok(input.length > 65536, 'entrada maior que o anel de 64 KiB');
  compare('stdin-grande', path.join(EXDIR, 'maiusculas.ksx'), { input });
});

test('stdin-eof-pegajoso', () => {
  const r = web(MK.echo, { input: '' });
  eq(r.rc, 0, 'EOF imediato');
});

/* ---- 4. SLEEP_MS / YIELD ---- */
test('sleep-yield-com-prazo', () => {
  const w = web(path.join(EXDIR, 'vtdemo.ksx'), {});
  eq(w.run.sleeps.length, 40, 'um SLEEP_MS por quadro');
  ok(w.run.sleeps.every((ms) => ms === 25), 'prazo de 25 ms');
  eq(w.rc, 0, 'exit');
});

/* ---- 5. limite e step ---- */
test('limite-de-instrucoes-exato', () => {
  const w = web(MK.loop, { maxInsns: 12345, slice: 1000 });
  eq(w.rc, 124, 'código');
  eq(w.core.insnCount(), 12345, 'insn_count');
});

/* ksdis: "    00000010:  78 00 48 00              syscall 0x12" */
function ksdisMap(file) {
  const r = spawnSync(KSDIS, [file]);
  const m = new Map();
  for (const l of r.stdout.toString('latin1').split('\n')) {
    const x = /^ +([0-9A-F]{8}):  ((?:[0-9A-F]{2} )+) +(.*)$/.exec(l);
    if (x) m.set(parseInt(x[1], 16), x[3].replace(/ +;.*$/, '').trim());
  }
  return m;
}

for (const f of examples.concat(['../test-tmp/hello.ksx', '../test-tmp/rawedge.ksx'])) {
  const file = path.join(EXDIR, f);
  const name = path.basename(f, '.ksx');
  test('step-disasm-ksdis-' + name, () => {
    const dis = ksdisMap(file);
    const nt = native(file, { trace: true, input: INPUTS[name] || '', maxInsns: 400 }).stderr
      .split('\n').filter((l) => /^[0-9A-F]{8}: /.test(l));
    const core = newCore();
    const s = new KsSession(core, {});
    s.load(fs.readFileSync(file));
    s.pushInput(Buffer.from(INPUTS[name] || ''));
    s.eof();
    let checked = 0;
    for (let i = 0; i < 400; i++) {
      const pc = core.pc();
      const d = core.disasmAt(pc);
      const ref = dis.get(pc);
      if (ref !== undefined && !ref.startsWith('.word') && !ref.startsWith(';')) {
        /* O ksdis troca o deslocamento de um desvio pelo nome do alvo quando
         * há símbolo (ex.: "call _start"); o disasm do ksweb, como o trace
         * do runner, mostra sempre o deslocamento. */
        const symbolic = /[+-]0x[0-9A-F]+$/.test(d.text) && /\s[A-Za-z_.][\w.]*$/.test(ref) &&
          d.text.split(' ')[0] === ref.split(' ')[0];
        if (!symbolic) {
          eq(d.text, ref, 'disasm em ' + hex(pc) + ' (ksdis)');
          checked++;
        }
      }
      const tl = nt[i];
      if (tl) {
        eq(hex(pc).slice(2), tl.slice(0, 8), 'pc do passo ' + i + ' (trace nativo)');
        ok(tl.includes('  ' + d.text), 'texto do passo ' + i + ' no trace nativo: ' + d.text + ' / ' + tl);
      }
      const r = s.tick(true);
      if (r.action === 'done') break;
    }
    ok(checked > 0, 'nenhuma instrução comparada com o ksdis');
  });
}

/* ---- 6. depurador ---- */
function traceLines(file, input, max) {
  return native(file, { trace: true, input: input || '', maxInsns: max || 100000 }).stderr
    .split('\n').filter((l) => /^[0-9A-F]{8}: /.test(l));
}

test('breakpoint-para-no-pc-certo', () => {
  const file = path.join(EXDIR, 'fib.ksx');
  const tl = traceLines(file);
  const target = parseInt(tl[40].slice(0, 8), 16);         /* pc da 41a instrução */
  const firstHit = tl.findIndex((l) => parseInt(l.slice(0, 8), 16) === target);
  const hits = tl.filter((l) => parseInt(l.slice(0, 8), 16) === target).length;
  const core = newCore();
  const s = new KsSession(core, {});
  s.load(fs.readFileSync(file));
  eq(core.bpSet(target), 0, 'bp_set');
  let r = s.tick();
  eq(r.action, 'break', 'parou');
  eq(r.reason, 'breakpoint', 'motivo');
  eq(core.pc(), target, 'pc');
  eq(core.insnCount(), firstHit, 'instruções antes da parada');
  let n = 1;
  for (;;) {
    r = s.tick();
    if (r.action !== 'break') break;
    eq(core.pc(), target, 'pc na parada ' + n);
    n++;
  }
  eq(n, hits, 'paradas = vezes que o pc passa no bp');
  eq(r.action, 'done', 'termina');
  eq(Buffer.from(core.takeOutput()).toString('latin1'), native(file).stdout.toString('latin1'), 'saída intacta');
  eq(core.bpClear(target), 0, 'bp_clear');
  eq(core.bpClear(target), -1, 'bp_clear de novo');
});

test('breakpoint-lista-e-limite', () => {
  const core = newCore();
  core.init(4096, 0);
  for (let i = 0; i < 64; i++) eq(core.bpSet(i * 4), 0, 'bp ' + i);
  eq(core.bpSet(0x1000), -1, 'tabela cheia');
  eq(core.bpSet(8), 0, 'repetido não ocupa');
  eq(core.bpList().length, 64, 'lista');
  core.bpClearAll();
  eq(core.bpList().length, 0, 'limpa');
});

test('parar-em-syscall-e-brk', () => {
  const core = newCore();
  const s = new KsSession(core, {});
  s.load(fs.readFileSync(path.join(EXDIR, 'hello.ksx')));
  core.setStopFlags(false, true);
  let r = s.tick();
  eq(r.reason, 'syscall', 'motivo');
  eq(core.disasmAt(core.pc()).text, 'syscall 0x12', 'parado antes do PUTS');
  eq(core.takeOutput().length, 0, 'nada impresso ainda');
  r = s.tick();
  eq(r.action, 'done', 'continua sem parar de novo na mesma syscall');
  const c2 = newCore();
  const s2 = new KsSession(c2, {});
  s2.load(fs.readFileSync(MK.halt42));
  c2.setStopFlags(true, false);
  r = s2.tick();
  eq(r.reason, 'BRK', 'motivo BRK');
  eq(c2.pc(), 8, 'pc do BRK');
  eq(s2.tick().info.code, 42, 'termina');
});

test('bp-em-syscall-de-entrada-nao-repete-apos-espera', () => {
  const core = newCore();
  const s = new KsSession(core, {});
  s.load(fs.readFileSync(MK.echo));
  core.bpSet(0);                                           /* GETC está em 0 */
  let r = s.tick();
  eq(r.action, 'break', 'para no GETC');
  r = s.tick();
  eq(r.action, 'wait', 'executa o GETC e espera entrada');
  s.pushInput(Buffer.from('a'));
  r = s.tick();
  eq(r.action, 'break', 'depois da entrada, para de novo só na próxima volta do laço');
  eq(Buffer.from(core.takeOutput()).toString(), 'a', 'eco feito');
});

test('trace-ring-n-configuravel', () => {
  const core = newCore();
  const s = new KsSession(core, {});
  s.load(fs.readFileSync(path.join(EXDIR, 'fib.ksx')));
  core.traceEnable(100);
  s.runSync('');
  eq(core.traceCount(), 100, 'guarda só os últimos 100');
  ok(core.traceTotal() > 100, 'total maior');
  const all = traceLines(path.join(EXDIR, 'fib.ksx'));
  const last = all.slice(-100).join('\n') + '\n';
  eq(core.traceText(), last, 'são os 100 últimos do trace nativo');
  const tail = core.traceTail(3);
  eq(tail.length, 3, 'traceTail');
  eq(tail[2].pc, parseInt(all[all.length - 1].slice(0, 8), 16), 'pc do último');
});

test('fault-mostra-instrucao-culpada', () => {
  const w = web(MK.fault, {});
  eq(w.info.kind, 'fault', 'fault');
  eq(w.core.pc(), 8, 'pc fica na instrução');
  ok(/^(ld|st)/.test(w.core.disasmAt(8).text), 'instrução de memória: ' + w.core.disasmAt(8).text);
});

test('mem-read-regioes-cabecalho', () => {
  const file = path.join(EXDIR, 'strlen.ksx');
  const img = fs.readFileSync(file);
  const core = newCore();
  const s = new KsSession(core, {});
  s.load(img);
  const h = core.header();
  const u32 = (o) => img.readUInt32LE(o);
  eq(h.entry, u32(8), 'entry');
  eq(h.codeSize, u32(0x10), 'code_size');
  eq(h.dataSize, u32(0x18), 'data_size');
  eq(h.bssSize, u32(0x1C), 'bss_size');
  eq(h.stackSize, u32(0x28), 'stack_size');
  eq(h.checksum, u32(0x34), 'checksum');
  eq(h.ramBase, h.ramBaseFile || ((h.codeSize + 15) & ~15), 'ram_base efetivo');
  eq(h.sp0, h.ramBase + (1 << 20), 'sp inicial');
  eq(core.reg(31), h.sp0, 'sp = sp0');
  eq(h.stackLimit, h.sp0 - h.stackSize, 'stack_limit');
  eq(h.heapStart, h.ramBase + h.dataSize + h.bssSize, 'heap_start');
  const regs = core.regions();
  eq(regs.length, 2, 'CODE e RAM');
  eq(regs[0].base, 0, 'CODE em 0');
  eq(regs[0].size, h.codeSize, 'tamanho CODE');
  eq(regs[0].permStr, 'R-X', 'perm CODE');
  eq(regs[0].kindName, 'ROM', 'kind CODE');
  eq(regs[1].base, h.ramBase, 'base RAM');
  eq(regs[1].size, 1 << 20, 'tamanho RAM');
  eq(regs[1].permStr, 'RW-', 'perm RAM');
  const code = core.memRead(0, h.codeSize);
  eq(code.readable, h.codeSize, 'código legível');
  eq(Buffer.from(code.bytes).equals(img.subarray(h.codeOff, h.codeOff + h.codeSize)), true, 'bytes do código');
  const data = core.memRead(h.ramBase, h.dataSize);
  eq(Buffer.from(data.bytes).equals(img.subarray(h.dataOff, h.dataOff + h.dataSize)), true, '.data copiado');
  const gap = core.memRead(h.codeSize, h.ramBase - h.codeSize + 4);
  eq(gap.readable, 4, 'buraco entre CODE e RAM ilegível');
  eq(gap.mask[0], h.codeSize === h.ramBase ? 1 : 0, 'mask');
  const big = core.memRead(h.ramBase, 10000);
  eq(big.readable, 10000, 'leitura em vários pedaços');
  const top = core.memRead(0xFFFFFFF0, 32);
  eq(top.readable, 16, 'topo do espaço ilegível; a leitura dá a volta para 0 (CODE)');
});

test('cpu-snapshot-e-registradores', () => {
  const core = newCore();
  const s = new KsSession(core, {});
  s.load(fs.readFileSync(MK.halt42));
  core.step();
  const c = core.cpu();
  eq(c.r[1], 42, 'r1 após movi');
  eq(c.pc, 4, 'pc');
  eq(core.reg(1), 42, 'ksweb_reg');
  eq(c.insns, 1, 'insns');
});

test('reinit-reaproveita-arena', () => {
  const core = newCore();
  for (let i = 0; i < 50; i++) {
    const s = new KsSession(core, { ramSize: 8 << 20 });
    eq(s.load(fs.readFileSync(path.join(EXDIR, 'sieve.ksx'))), null, 'load ' + i);
    eq(s.runSync('').info.code, 0, 'run ' + i);
  }
  ok(core.mem.buffer.byteLength < 16 << 20, 'memória não cresce a cada reinício: ' + core.mem.buffer.byteLength);
});

test('ram-grande-memory-grow', () => {
  const core = newCore();
  const s = new KsSession(core, { ramSize: 64 << 20 });
  eq(s.load(fs.readFileSync(path.join(EXDIR, 'hello.ksx'))), null, 'load com 64 MiB');
  eq(s.runSync('').info.code, 0, 'roda');
});

test('modo-normal-sem-checagens', () => {
  /* Com bp e trace desligados o caminho é o ksvm_run direto: só uma
   * verificação de tempo grosseira, para pegar regressões grandes. */
  const core = newCore();
  const s = new KsSession(core, { maxInsns: 5000000, slice: 1000000 });
  s.load(fs.readFileSync(MK.loop));
  const t0 = Date.now();
  const r = s.runSync('');
  const dt = Date.now() - t0;
  eq(r.info.code, 124, 'limite');
  console.log('  (desempenho: 5M instruções em ' + dt + ' ms = ' + Math.round(5000 / Math.max(dt, 1)) + ' M instr/s)');
});

console.log('run_node: ' + total + ' casos, ' + failed + ' falhas');
process.exit(failed ? 1 : 0);
