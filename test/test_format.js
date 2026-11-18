#!/usr/bin/env node
/* test_format.js — formatadores puros do depurador (web/format.js). */
'use strict';
const F = require('../web/format.js');

let total = 0, failed = 0;
function test(name, fn) {
  total++;
  try { fn(); } catch (e) { failed++; console.log('FALHA [' + name + '] ' + e.message); }
}
function eq(a, b, what) {
  const sa = JSON.stringify(a), sb = JSON.stringify(b);
  if (sa !== sb) throw new Error((what || 'valor') + ': ' + sa + ' != esperado ' + sb);
}

test('hexdump-texto', () => {
  const bytes = Buffer.from('Hello, KSVM!\n\x00\x01\x02ABC');
  const t = F.hexdumpText(0x20, bytes);
  eq(t.split('\n'), [
    '00000020  48 65 6C 6C 6F 2C 20 4B  53 56 4D 21 0A 00 01 02  |Hello, KSVM!....|',
    '00000030  41 42 43                                          |ABC             |'
  ]);
});

test('hexdump-ilegivel-e-alterados', () => {
  const bytes = new Uint8Array([1, 2, 3, 4]), mask = new Uint8Array([1, 1, 0, 1]);
  const prev = { base: 0x100, bytes: new Uint8Array([1, 9, 3, 4]), mask: new Uint8Array([1, 1, 1, 1]) };
  const rows = F.hexdumpRows(0x100, bytes, mask, {
    prev, regions: [{ name: 'data', base: 0x100, size: 2 }, { name: 'bss', base: 0x102, size: 10 }]
  });
  eq(rows.length, 1);
  const c = rows[0].cells;
  eq(c.slice(0, 4).map((x) => x.text), ['01', '02', '??', '04']);
  eq(c.slice(0, 4).map((x) => x.changed), [false, true, false, false]);
  eq(c.slice(0, 4).map((x) => x.region), ['data', 'data', 'bss', 'bss']);
  eq(c[4], null, 'linha incompleta');
  eq(rows[0].ascii.slice(0, 4), '.. .');
});

test('f32', () => {
  eq(F.f32Str(0x3FC00000), '1.5');
  eq(F.f32Str(0x3EAAAAAB), '0.333333343');
  eq(F.f32Str(0x80000000), '-0');
  eq(F.f32Str(0x00000000), '0');
  eq(F.f32Str(0x7FC00000), 'nan');
  eq(F.f32Str(0x7F800000), 'inf');
  eq(F.f32Str(0xFF800000), '-inf');
  eq(F.f32Str(0x00000001), '1.40129846e-45');
  eq(F.f32Str(0x4B189680), '10000000');
  eq(F.f32FromBits(0x40490FDB).toFixed(5), '3.14159');
});

test('registradores', () => {
  const cpu = { r: new Array(32).fill(0), pc: 0, flags: 0 };
  cpu.r[1] = 0xFFFFFFFF; cpu.r[2] = 0x3FC00000;
  const prev = { r: cpu.r.slice() };
  prev.r[2] = 0;
  const rows = F.regRows(cpu, prev);
  eq(rows[0].name, 'zr'); eq(rows[30].name, 'fp'); eq(rows[31].name, 'sp');
  eq([rows[1].hex, rows[1].dec, rows[1].udec], ['0xFFFFFFFF', '-1', '4294967295']);
  eq([rows[2].changed, rows[1].changed], [true, false]);
  eq(rows[2].f32, '1.5');
});

test('flags', () => {
  eq(F.flagsStr(0), '----'); eq(F.flagsStr(0x5), 'Z-C-'); eq(F.flagsStr(0xF), 'ZNCV');
  eq(F.flagsList(2).filter((f) => f.set).map((f) => f.name), ['N']);
});

test('regs-dump-formato-runner', () => {
  const cpu = { r: new Array(32).fill(0), pc: 0x10, flags: 5, insns: 4 };
  cpu.r[1] = 42;
  const d = F.regsDump(cpu).split('\n');
  eq(d[0], 'pc=0x00000010 flags=Z-C- insns=4');
  eq(d[1], ' zr=0x00000000   r1=0x0000002A   r2=0x00000000   r3=0x00000000');
  eq(d[8], 'r28=0x00000000  r29=0x00000000   fp=0x00000000   sp=0x00000000');
});

test('parse-endereco', () => {
  const cpu = { r: new Array(32).fill(0), pc: 0x40 };
  cpu.r[31] = 0x1000; cpu.r[5] = 0x20;
  eq(F.parseAddress('0x1F0', cpu), 0x1F0);
  eq(F.parseAddress('496', cpu), 496);
  eq(F.parseAddress('pc', cpu), 0x40);
  eq(F.parseAddress('sp+8', cpu), 0x1008);
  eq(F.parseAddress('r5 - 0x10', cpu), 0x10);
  eq(F.parseAddress('SP', cpu), 0x1000);
  eq(F.parseAddress('buf+1', cpu, { buf: 0x300 }), 0x301);
  eq(F.parseAddress('zzz', cpu), null);
  eq(F.parseAddress('', cpu), null);
  eq(F.parseAddress('0-4', cpu), 0xFFFFFFFC, 'modular');
});

test('janela-disasm-com-formato-L', () => {
  /* código: 0:L(8) 8:R 12:L(8) 20:R 24:R 28:L 36:R ... */
  const lens = { 0: 8, 8: 4, 12: 8, 20: 4, 24: 4, 28: 8, 36: 4, 40: 4, 44: 4 };
  const get = (a) => (lens[a] ? { len: lens[a], text: 'i' + a } : (a < 48 ? { len: 4, text: 'x' + a } : { len: 0 }));
  const w = F.disasmWindow(28, get, 0, 48, 4, 3);
  eq(w.map((x) => x.addr), [8, 12, 20, 24, 28, 36, 40, 44]);
  eq(w.find((x) => x.current).addr, 28);
  const w2 = F.disasmWindow(0, get, 0, 48, 4, 1);
  eq(w2.map((x) => x.addr), [0, 8], 'pc no início');
  const w3 = F.disasmWindow(100, get, 0, 48, 4, 4);
  eq(w3.length, 1, 'pc fora do código: só a linha do pc'); eq(w3[0].text, '??');
});

test('pilha', () => {
  const cpu = { r: new Array(32).fill(0) };
  cpu.r[31] = 0x1000; cpu.r[30] = 0x1008;
  const rows = F.stackRows(0x1000, [5, 0x14, 0x2000, 0x16], null, cpu, 0x100);
  eq(rows.map((r) => r.marks), [['sp'], ['ret?'], ['fp'], []]);
  eq(rows[1].hex, '0x00000014');
});

test('mapa-de-memoria', () => {
  const h = { ramBase: 0x30, codeSize: 0x29, dataSize: 4, bssSize: 16, stackLimit: 0x1000, sp0: 0x1100, heapStart: 0x44 };
  const m = F.memoryMap(h);
  eq(m.map((r) => r.name), ['code', 'data', 'bss', 'stack', 'heap']);
  eq(F.regionOf(0x35, m), 'bss');
  eq(F.regionOf(0x10F0, m), 'stack');
});

console.log('test_format: ' + total + ' casos, ' + failed + ' falhas');
process.exit(failed ? 1 : 0);
