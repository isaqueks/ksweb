/*
 * format.js — formatadores puros do depurador e do cabeçalho (sem DOM):
 * hexdump, registradores (hex, decimal com sinal, float binary32), flags,
 * pilha, janela de disassembly ao redor do pc e leitura de endereços.
 * Usado pela página (ksweb.js/debugger.js), pelo worker e pelos testes.
 */
(function (root) {
  'use strict';

  const hex = (v, n) => (v >>> 0).toString(16).toUpperCase().padStart(n || 8, '0');
  const REG_NAMES = [];
  for (let i = 0; i < 32; i++) REG_NAMES.push(i === 0 ? 'zr' : i === 30 ? 'fp' : i === 31 ? 'sp' : 'r' + i);
  const FLAG_BITS = [['Z', 1], ['N', 2], ['C', 4], ['V', 8]];

  /* Bits Z N C V do registrador de flags (cpu.h: Z=1 N=2 C=4 V=8). */
  function flagsStr(f) {
    return FLAG_BITS.map(([n, b]) => (f & b ? n : '-')).join('');
  }

  function flagsList(f) {
    return FLAG_BITS.map(([n, b]) => ({ name: n, set: (f & b) !== 0 }));
  }

  const f32buf = new DataView(new ArrayBuffer(4));
  function f32FromBits(u) {
    f32buf.setUint32(0, u >>> 0, true);
    return f32buf.getFloat32(0, true);
  }

  /* Texto curto de um float32: até 9 dígitos significativos (ida e volta). */
  function f32Str(u) {
    const v = f32FromBits(u);
    if (Number.isNaN(v)) return 'nan';
    if (v === Infinity) return 'inf';
    if (v === -Infinity) return '-inf';
    if (v === 0) return (1 / v < 0) ? '-0' : '0';
    let s = v.toPrecision(9);
    if (s.includes('e')) {
      const [m, e] = s.split('e');
      s = m.replace(/\.?0+$/, '') + 'e' + e;
    } else if (s.includes('.')) {
      s = s.replace(/\.?0+$/, '');
    }
    return s;
  }

  function regRow(i, value, prev) {
    return {
      name: REG_NAMES[i], index: i, hex: '0x' + hex(value), dec: String(value | 0),
      udec: String(value >>> 0), f32: f32Str(value), changed: prev !== undefined && prev !== value
    };
  }

  /* Linhas do painel de registradores (r0..r31) com os alterados marcados. */
  function regRows(cpu, prev) {
    const rows = [];
    for (let i = 0; i < 32; i++) rows.push(regRow(i, cpu.r[i] >>> 0, prev ? prev.r[i] >>> 0 : undefined));
    return rows;
  }

  /* ---- hexdump ---- */

  function asciiOf(b) { return b >= 0x20 && b < 0x7F ? String.fromCharCode(b) : '.'; }

  /*
   * Linhas de 16 bytes: {addr, cells:[{off, byte, text, readable, changed,
   * region}], ascii}. base = endereço do primeiro byte (o JS chama com base
   * alinhada a 16); prev (opcional) = {base, bytes} da parada anterior para
   * marcar os alterados; regions = [{base, size, name}] para classificar.
   */
  function hexdumpRows(base, bytes, mask, opts) {
    opts = opts || {};
    const rows = [];
    const prev = opts.prev;
    for (let off = 0; off < bytes.length; off += 16) {
      const cells = [];
      let ascii = '';
      for (let j = 0; j < 16; j++) {
        const i = off + j;
        const addr = (base + i) >>> 0;
        if (i >= bytes.length) { cells.push(null); ascii += ' '; continue; }
        const readable = !mask || mask[i] === 1;
        let changed = false;
        if (prev && readable) {
          const pi = addr - prev.base;
          if (pi >= 0 && pi < prev.bytes.length && (!prev.mask || prev.mask[pi] === 1)) changed = prev.bytes[pi] !== bytes[i];
        }
        cells.push({
          addr, byte: bytes[i], readable, changed,
          text: readable ? hex(bytes[i], 2) : '??', region: regionOf(addr, opts.regions)
        });
        ascii += readable ? asciiOf(bytes[i]) : ' ';
      }
      rows.push({ addr: (base + off) >>> 0, cells, ascii });
    }
    return rows;
  }

  function regionOf(addr, regions) {
    if (!regions) return '';
    for (const r of regions) if (addr >= r.base && addr - r.base < r.size) return r.name;
    return '';
  }

  /* Hexdump em texto: "00000000  48 65 6C 6C 6F 2C 20 4B  53 56 4D 21 0A ..  |Hello, KSVM!.|" */
  function hexdumpText(base, bytes, mask) {
    return hexdumpRows(base, bytes, mask).map((r) => {
      const h = r.cells.map((c, j) => (c ? c.text : '  ') + (j === 7 ? '  ' : ' ')).join('');
      return hex(r.addr) + '  ' + h + ' |' + r.ascii.replace(/\s+$/, (m) => m) + '|';
    }).join('\n');
  }

  /*
   * Regiões do depurador a partir do cabeçalho: CODE (texto e rodata não se
   * distinguem no .ksx: toda a região CODE), .data, .bss, heap, pilha.
   */
  function memoryMap(h) {
    const rb = h.ramBase;
    return [
      { name: 'code', label: 'CODE', base: 0, size: h.codeSize },
      { name: 'data', label: '.data', base: rb, size: h.dataSize },
      { name: 'bss', label: '.bss', base: rb + h.dataSize, size: h.bssSize },
      { name: 'stack', label: 'pilha', base: h.stackLimit, size: (h.sp0 - h.stackLimit) >>> 0 },
      { name: 'heap', label: 'heap', base: h.heapStart, size: Math.max(0, h.stackLimit - h.heapStart) }
    ].filter((r) => r.size > 0);
  }

  /* ---- pilha ---- */

  /* words: palavras lidas a partir de sp; marca sp, fp e prováveis
   * endereços de retorno (valor alinhado dentro de CODE). */
  function stackRows(sp, words, readable, cpu, codeSize) {
    const rows = [];
    for (let i = 0; i < words.length; i++) {
      const addr = (sp + 4 * i) >>> 0, v = words[i] >>> 0;
      const marks = [];
      if (addr === (cpu.r[31] >>> 0)) marks.push('sp');
      if (addr === (cpu.r[30] >>> 0)) marks.push('fp');
      const ok = !readable || readable[i];
      if (ok && v !== 0 && (v & 3) === 0 && v < codeSize) marks.push('ret?');
      rows.push({ addr, value: v, hex: ok ? '0x' + hex(v) : '??', readable: ok, marks });
    }
    return rows;
  }

  /* ---- disassembly ao redor do pc ---- */

  /*
   * Lista de instruções ao redor do pc. getInsn(addr) -> {len, text} (len 0
   * = não executável). Como o formato L tem 8 bytes, não dá para andar para
   * trás: começa "before*8" bytes antes e anda para a frente até cair
   * exatamente no pc (tentando inícios deslocados de 4 se não cair).
   */
  function disasmWindow(pc, getInsn, codeStart, codeEnd, before, after) {
    before = before === undefined ? 32 : before;
    after = after === undefined ? 32 : after;
    pc >>>= 0;
    let pre = [];
    if (pc >= codeStart && pc < codeEnd) {
      for (let back = before * 8; back >= 0; back -= 4) {
        let a = Math.max(codeStart, pc - back) & ~3;
        const seq = [];
        while (a < pc) {
          const ins = getInsn(a);
          const len = ins.len || 4;
          seq.push({ addr: a, len, text: ins.len ? ins.text : '??' });
          a += len;
        }
        if (a === pc) { pre = seq; break; }
      }
    }
    pre = pre.slice(-before);
    const post = [];
    let a = pc;
    for (let i = 0; i <= after; i++) {
      if (a >= codeEnd && i > 0) break;
      const ins = getInsn(a);
      post.push({ addr: a, len: ins.len || 4, text: ins.len ? ins.text : '??', current: i === 0 });
      if (!ins.len) break;
      a += ins.len;
    }
    return pre.concat(post);
  }

  /* ---- endereços ---- */

  /* "0x1F0", "496", "pc", "sp+8", "r5 - 0x10", "data" (rótulos opcionais). */
  function parseAddress(s, cpu, names) {
    s = String(s).trim().toLowerCase();
    if (!s) return null;
    const term = (t) => {
      t = t.trim();
      if (/^0x[0-9a-f]+$/.test(t)) return parseInt(t.slice(2), 16);
      if (/^[0-9]+$/.test(t)) return parseInt(t, 10);
      if (/^[0-9a-f]+h$/.test(t)) return parseInt(t.slice(0, -1), 16);
      if (cpu) {
        if (t === 'pc') return cpu.pc;
        const ri = REG_NAMES.indexOf(t);
        if (ri >= 0) return cpu.r[ri];
        const m = /^r([0-9]|[12][0-9]|3[01])$/.exec(t);
        if (m) return cpu.r[+m[1]];
      }
      if (names && Object.prototype.hasOwnProperty.call(names, t)) return names[t];
      return null;
    };
    const parts = s.split(/([+-])/);
    let v = term(parts[0]);
    if (v === null) return null;
    for (let i = 1; i < parts.length; i += 2) {
      const t = term(parts[i + 1] || '');
      if (t === null) return null;
      v = parts[i] === '+' ? v + t : v - t;
    }
    return v >>> 0;
  }

  /* Linhas do cabeçalho .ksx para o terminal (prefixo do runner). */
  function headerLines(h, name) {
    const kb = (n) => n + ' B';
    return [
      'imagem ' + (name || '') + ': ' + h.imageSize + ' bytes, versão ' + h.verMajor + '.' + h.verMinor +
        ', flags 0x' + hex(h.flags, 4) + (h.flagNames.length ? ' (' + h.flagNames.join(' ') + ')' : ''),
      '  entry 0x' + hex(h.entry) + '  código ' + kb(h.codeSize) + '  .data ' + kb(h.dataSize) +
        '  .bss ' + kb(h.bssSize) + '  pilha ' + kb(h.stackSize) + '  ram_min ' + kb(h.ramMin),
      '  RAM 0x' + hex(h.ramBase) + '..0x' + hex(h.ramBase + h.ramSize - 1) + ' (' + h.ramSize + ' B)' +
        '  sp 0x' + hex(h.sp0) + '  stack_limit 0x' + hex(h.stackLimit) + '  checksum 0x' + hex(h.checksum)
    ];
  }

  /* Registradores no formato do "ksvm --regs" (dump_regs). */
  function regsDump(cpu) {
    let s = 'pc=0x' + hex(cpu.pc) + ' flags=' + flagsStr(cpu.flags) + ' insns=' + (cpu.insns >>> 0) + '\n';
    for (let i = 0; i < 32; i++) {
      s += REG_NAMES[i].padStart(3) + '=0x' + hex(cpu.r[i]) + (i % 4 === 3 ? '\n' : '  ');
    }
    return s;
  }

  const api = {
    hex, REG_NAMES, flagsStr, flagsList, f32FromBits, f32Str, regRow, regRows, hexdumpRows, hexdumpText,
    memoryMap, regionOf, stackRows, disasmWindow, parseAddress, headerLines, regsDump
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.KsFormat = api;
})(typeof self !== 'undefined' ? self : this);
