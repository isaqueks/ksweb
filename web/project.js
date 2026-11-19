/*
 * project.js — projetos da IDE, sem DOM (testado em Node):
 *
 *   Project        arquivos .ksasm (nome -> texto), o principal, breakpoints
 *                  por arquivo/linha, abas abertas; operações do explorador
 *                  (novo, renomear, excluir, duplicar, principal) com
 *                  validação de nomes
 *   ProjectStore   persistência em IndexedDB (banco "ksweb-ide", stores
 *                  "projects" e "meta"), com fallback para localStorage e,
 *                  sem nenhum dos dois, memória
 *   makeZip/readZip  .zip sem dependências (gravação "stored" com CRC-32;
 *                  leitura de stored e deflate, este pelo
 *                  DecompressionStream quando o navegador tem)
 *   projectToZip/projectFromZip  exportar/importar o projeto inteiro
 *                  (arquivos + ksweb-projeto.json com principal e breakpoints)
 *
 * Formato salvo (JSON): {id, name, main, files: [{name, text}],
 * breakpoints: {arquivo: [linhas]}, open: [nomes], active, created, updated}.
 */
(function (root) {
  'use strict';

  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const MANIFEST = 'ksweb-projeto.json';
  const TEXT_EXT = /\.(ksasm|asm|s|inc|txt|md)$/i;

  const NAME_RE = /^[\p{L}\p{N}_][\p{L}\p{N}_.\-]*(\/[\p{L}\p{N}_][\p{L}\p{N}_.\-]*)*$/u;

  /* Mensagem de erro para um nome de arquivo inválido, ou null. */
  function checkName(name) {
    if (typeof name !== 'string' || !name.trim()) return 'nome vazio';
    if (name.length > 200) return 'nome longo demais';
    if (/[\\"]/.test(name)) return 'o nome não pode ter \\ nem aspas (o .include usa "...")';
    if (name.split('/').some((s) => s === '..' || s === '.')) return 'o nome não pode ter "." nem ".." como pasta';
    if (!NAME_RE.test(name)) return 'use letras, dígitos, _ . - e / para pastas';
    if (name.startsWith('.ksweb.')) return 'nome reservado';
    return null;
  }

  function newId() {
    return 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  class Project {
    constructor(data) {
      data = data || {};
      this.id = data.id || newId();
      this.name = data.name || 'projeto';
      this.files = new Map();
      for (const f of data.files || []) this.files.set(f.name, String(f.text));
      this.main = data.main && this.files.has(data.main) ? data.main : (this.files.keys().next().value || null);
      this.breakpoints = new Map();
      for (const [k, v] of Object.entries(data.breakpoints || {})) if (this.files.has(k)) this.breakpoints.set(k, [...new Set(v)].sort((a, b) => a - b));
      this.open = (data.open || []).filter((n) => this.files.has(n));
      this.active = data.active && this.files.has(data.active) ? data.active : (this.open[0] || this.main);
      this.created = data.created || Date.now();
      this.updated = data.updated || this.created;
      this.example = data.example || null;
    }

    static create(name, files, main) {
      return new Project({ name, files: Object.entries(files).map(([n, t]) => ({ name: n, text: t })), main, open: main ? [main] : [] });
    }

    fileNames() { return [...this.files.keys()].sort((a, b) => a.localeCompare(b)); }
    has(name) { return this.files.has(name); }
    text(name) { return this.files.get(name); }

    touch() { this.updated = Date.now(); }

    setText(name, text) {
      if (!this.files.has(name)) throw new Error('arquivo inexistente: ' + name);
      if (this.files.get(name) === text) return false;
      this.files.set(name, text);
      this.touch();
      return true;
    }

    /* Nome livre a partir de base ("x.ksasm" -> "x-2.ksasm", ...). */
    uniqueName(base) {
      if (!this.files.has(base)) return base;
      const m = /^(.*?)(\.[^./]*)?$/.exec(base);
      for (let i = 2; ; i++) {
        const n = m[1].replace(/-\d+$/, '') + '-' + i + (m[2] || '');
        if (!this.files.has(n)) return n;
      }
    }

    addFile(name, text) {
      const err = checkName(name);
      if (err) throw new Error(err);
      if (this.files.has(name)) throw new Error('já existe um arquivo ' + name);
      this.files.set(name, text || '');
      if (!this.main) this.main = name;
      this.touch();
      return name;
    }

    renameFile(from, to) {
      if (!this.files.has(from)) throw new Error('arquivo inexistente: ' + from);
      if (from === to) return to;
      const err = checkName(to);
      if (err) throw new Error(err);
      if (this.files.has(to)) throw new Error('já existe um arquivo ' + to);
      const text = this.files.get(from);
      /* mantém a ordem de inserção */
      const entries = [...this.files].map(([k, v]) => (k === from ? [to, text] : [k, v]));
      this.files = new Map(entries);
      if (this.main === from) this.main = to;
      if (this.breakpoints.has(from)) { this.breakpoints.set(to, this.breakpoints.get(from)); this.breakpoints.delete(from); }
      this.open = this.open.map((n) => (n === from ? to : n));
      if (this.active === from) this.active = to;
      this.touch();
      return to;
    }

    deleteFile(name) {
      if (!this.files.has(name)) throw new Error('arquivo inexistente: ' + name);
      this.files.delete(name);
      this.breakpoints.delete(name);
      this.open = this.open.filter((n) => n !== name);
      if (this.main === name) this.main = this.fileNames()[0] || null;
      if (this.active === name) this.active = this.open[0] || this.main;
      this.touch();
    }

    duplicateFile(name) {
      if (!this.files.has(name)) throw new Error('arquivo inexistente: ' + name);
      const n = this.uniqueName(name.replace(/(\.[^./]*)?$/, (ext) => '-copia' + (ext || '')));
      this.files.set(n, this.files.get(name));
      this.touch();
      return n;
    }

    setMain(name) {
      if (!this.files.has(name)) throw new Error('arquivo inexistente: ' + name);
      this.main = name;
      this.touch();
    }

    openFile(name) {
      if (!this.files.has(name)) return;
      if (!this.open.includes(name)) this.open.push(name);
      this.active = name;
    }

    closeFile(name) {
      this.open = this.open.filter((n) => n !== name);
      if (this.active === name) this.active = this.open[this.open.length - 1] || null;
    }

    setBreakpoints(name, lines) {
      const l = [...new Set(lines)].filter((x) => x > 0).sort((a, b) => a - b);
      if (l.length) this.breakpoints.set(name, l); else this.breakpoints.delete(name);
    }

    toJSON() {
      return {
        id: this.id, name: this.name, main: this.main,
        files: [...this.files].map(([name, text]) => ({ name, text })),
        breakpoints: Object.fromEntries(this.breakpoints), open: this.open.slice(), active: this.active,
        created: this.created, updated: this.updated, example: this.example
      };
    }

    static fromJSON(o) { return new Project(o); }
  }

  /* ---- persistência ---- */

  function idbReq(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('IndexedDB'));
    });
  }

  class IdbBackend {
    constructor(idb, name) { this.idb = idb; this.name = name; this.kind = 'indexeddb'; }
    async open() {
      const req = this.idb.open(this.name, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
      };
      this.db = await idbReq(req);
    }
    _store(name, mode) { return this.db.transaction(name, mode).objectStore(name); }
    async list() { return (await idbReq(this._store('projects', 'readonly').getAll())) || []; }
    async get(id) { return (await idbReq(this._store('projects', 'readonly').get(id))) || null; }
    async put(obj) { await idbReq(this._store('projects', 'readwrite').put(obj)); }
    async del(id) { await idbReq(this._store('projects', 'readwrite').delete(id)); }
    async getMeta(k) { const v = await idbReq(this._store('meta', 'readonly').get(k)); return v === undefined ? null : v; }
    async setMeta(k, v) { await idbReq(this._store('meta', 'readwrite').put(v, k)); }
  }

  class LocalBackend {
    constructor(ls, prefix) { this.ls = ls; this.p = prefix; this.kind = 'localstorage'; }
    async open() { const k = this.p + 'probe'; this.ls.setItem(k, '1'); this.ls.removeItem(k); }
    _ids() { try { return JSON.parse(this.ls.getItem(this.p + 'ids') || '[]'); } catch (e) { return []; } }
    async list() { return this._ids().map((id) => this._get(id)).filter(Boolean); }
    _get(id) { try { return JSON.parse(this.ls.getItem(this.p + 'project:' + id)); } catch (e) { return null; } }
    async get(id) { return this._get(id); }
    async put(obj) {
      this.ls.setItem(this.p + 'project:' + obj.id, JSON.stringify(obj));
      const ids = this._ids();
      if (!ids.includes(obj.id)) { ids.push(obj.id); this.ls.setItem(this.p + 'ids', JSON.stringify(ids)); }
    }
    async del(id) {
      this.ls.removeItem(this.p + 'project:' + id);
      this.ls.setItem(this.p + 'ids', JSON.stringify(this._ids().filter((x) => x !== id)));
    }
    async getMeta(k) { const v = this.ls.getItem(this.p + 'meta:' + k); return v === null ? null : JSON.parse(v); }
    async setMeta(k, v) { this.ls.setItem(this.p + 'meta:' + k, JSON.stringify(v)); }
  }

  class MemoryBackend {
    constructor() { this.kind = 'memory'; this.p = new Map(); this.m = new Map(); }
    async open() {}
    async list() { return [...this.p.values()].map((x) => JSON.parse(x)); }
    async get(id) { return this.p.has(id) ? JSON.parse(this.p.get(id)) : null; }
    async put(obj) { this.p.set(obj.id, JSON.stringify(obj)); }
    async del(id) { this.p.delete(id); }
    async getMeta(k) { return this.m.has(k) ? this.m.get(k) : null; }
    async setMeta(k, v) { this.m.set(k, v); }
  }

  class ProjectStore {
    /* env: {indexedDB, localStorage} (padrão: os globais) */
    constructor(env) {
      env = env || {};
      this.idb = 'indexedDB' in env ? env.indexedDB : (typeof indexedDB !== 'undefined' ? indexedDB : null);
      this.ls = 'localStorage' in env ? env.localStorage : (typeof localStorage !== 'undefined' ? localStorage : null);
      this.dbName = env.dbName || 'ksweb-ide';
      this.backend = null;
    }

    async open() {
      const tries = [];
      if (this.idb) tries.push(() => new IdbBackend(this.idb, this.dbName));
      if (this.ls) tries.push(() => new LocalBackend(this.ls, this.dbName + ':'));
      tries.push(() => new MemoryBackend());
      for (const make of tries) {
        const b = make();
        try {
          await b.open();
          this.backend = b;
          return b.kind;
        } catch (e) { /* próximo */ }
      }
      return null;
    }

    get kind() { return this.backend ? this.backend.kind : null; }

    async list() {
      const all = await this.backend.list();
      return all.map((p) => ({ id: p.id, name: p.name, updated: p.updated, files: (p.files || []).length, example: p.example || null }))
        .sort((a, b) => b.updated - a.updated);
    }
    async load(id) { const o = await this.backend.get(id); return o ? Project.fromJSON(o) : null; }
    async save(project) { await this.backend.put(project.toJSON()); }
    async remove(id) { await this.backend.del(id); }
    async getMeta(k) { return this.backend.getMeta(k); }
    async setMeta(k, v) { return this.backend.setMeta(k, v); }
  }

  /* ---- zip ---- */

  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(b) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  function dosTime(d) {
    return {
      time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
      date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
    };
  }

  /* entries: [{name, data: Uint8Array|string}] -> Uint8Array (método stored). */
  function makeZip(entries, when) {
    const t = dosTime(when || new Date());
    const parts = [], central = [];
    let off = 0;
    for (const e of entries) {
      const name = enc.encode(e.name);
      const data = typeof e.data === 'string' ? enc.encode(e.data) : e.data;
      const crc = crc32(data);
      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true);
      lh.setUint16(8, 0, true); lh.setUint16(10, t.time, true); lh.setUint16(12, t.date, true);
      lh.setUint32(14, crc, true); lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true);
      lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
      parts.push(new Uint8Array(lh.buffer), name, data);
      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true);
      ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true); ch.setUint16(12, t.time, true); ch.setUint16(14, t.date, true);
      ch.setUint32(16, crc, true); ch.setUint32(20, data.length, true); ch.setUint32(24, data.length, true);
      ch.setUint16(28, name.length, true); ch.setUint32(42, off, true);
      central.push(new Uint8Array(ch.buffer), name);
      off += 30 + name.length + data.length;
    }
    const cdSize = central.reduce((a, b) => a + b.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, entries.length, true); end.setUint16(10, entries.length, true);
    end.setUint32(12, cdSize, true); end.setUint32(16, off, true);
    const all = parts.concat(central, [new Uint8Array(end.buffer)]);
    const out = new Uint8Array(all.reduce((a, b) => a + b.length, 0));
    let p = 0;
    for (const b of all) { out.set(b, p); p += b.length; }
    return out;
  }

  /* inflate (RFC 1951) mínimo, no estilo do puff.c do zlib: o
   * DecompressionStream('deflate-raw') não existe em todo navegador nem no
   * Node 18, e os projetos são pequenos. */
  const LBASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
  const LEXT = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
  const DBASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
  const DEXT = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
  const CLORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

  function inflateRaw(src) {
    let pos = 0, bitbuf = 0, bitcnt = 0, out = new Uint8Array(Math.max(1024, src.length * 4)), n = 0;
    const bad = () => new Error('deflate inválido');
    function bits(k) {
      while (bitcnt < k) {
        if (pos >= src.length) throw bad();
        bitbuf |= src[pos++] << bitcnt;
        bitcnt += 8;
      }
      const v = bitbuf & ((1 << k) - 1);
      bitbuf >>>= k;
      bitcnt -= k;
      return v;
    }
    function put(b) {
      if (n === out.length) { const o = new Uint8Array(out.length * 2); o.set(out); out = o; }
      out[n++] = b;
    }
    function table(lengths) {
      const count = new Uint16Array(16), offs = new Uint16Array(16), symbol = new Uint16Array(lengths.length);
      for (const l of lengths) count[l]++;
      count[0] = 0;
      for (let i = 1; i < 16; i++) offs[i] = offs[i - 1] + count[i - 1];
      lengths.forEach((l, i) => { if (l) symbol[offs[l]++] = i; });
      return { count, symbol };
    }
    function decode(h) {
      let code = 0, first = 0, index = 0;
      for (let len = 1; len < 16; len++) {
        code |= bits(1);
        const c = h.count[len];
        if (code - c < first) return h.symbol[index + (code - first)];
        index += c; first += c; first <<= 1; code <<= 1;
      }
      throw bad();
    }
    function codes(lit, dist) {
      for (;;) {
        const sym = decode(lit);
        if (sym < 256) put(sym);
        else if (sym === 256) return;
        else {
          const li = sym - 257;
          if (li >= 29) throw bad();
          const len = LBASE[li] + bits(LEXT[li]);
          const di = decode(dist);
          if (di >= 30) throw bad();
          const d = DBASE[di] + bits(DEXT[di]);
          if (d > n) throw bad();
          for (let i = 0; i < len; i++) put(out[n - d]);
        }
      }
    }
    let last;
    do {
      last = bits(1);
      const type = bits(2);
      if (type === 0) {
        bitbuf = 0; bitcnt = 0;
        if (pos + 4 > src.length) throw bad();
        const len = src[pos] | (src[pos + 1] << 8);
        pos += 4;
        if (pos + len > src.length) throw bad();
        for (let i = 0; i < len; i++) put(src[pos++]);
      } else if (type === 1) {
        const l = new Array(288);
        for (let i = 0; i < 288; i++) l[i] = i < 144 ? 8 : i < 256 ? 9 : i < 280 ? 7 : 8;
        codes(table(l), table(new Array(30).fill(5)));
      } else if (type === 2) {
        const nlen = bits(5) + 257, ndist = bits(5) + 1, ncode = bits(4) + 4;
        const cl = new Array(19).fill(0);
        for (let i = 0; i < ncode; i++) cl[CLORDER[i]] = bits(3);
        const clt = table(cl);
        const lengths = [];
        while (lengths.length < nlen + ndist) {
          const sym = decode(clt);
          if (sym < 16) lengths.push(sym);
          else {
            let rep, val = 0;
            if (sym === 16) { if (!lengths.length) throw bad(); val = lengths[lengths.length - 1]; rep = 3 + bits(2); }
            else if (sym === 17) rep = 3 + bits(3);
            else rep = 11 + bits(7);
            for (let i = 0; i < rep; i++) lengths.push(val);
          }
        }
        if (lengths.length > nlen + ndist) throw bad();
        codes(table(lengths.slice(0, nlen)), table(lengths.slice(nlen)));
      } else throw bad();
    } while (!last);
    return out.slice(0, n);
  }

  /* bytes -> [{name, data}] (pastas são ignoradas). */
  async function readZip(bytes) {
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    let eocd = -1;
    for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('não é um arquivo .zip');
    const count = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    const out = [];
    for (let i = 0; i < count; i++) {
      if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('.zip corrompido');
      const method = dv.getUint16(p + 10, true);
      const crc = dv.getUint32(p + 16, true);
      const csize = dv.getUint32(p + 20, true);
      const nlen = dv.getUint16(p + 28, true), xlen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
      const lho = dv.getUint32(p + 42, true);
      const name = dec.decode(b.subarray(p + 46, p + 46 + nlen));
      p += 46 + nlen + xlen + clen;
      if (name.endsWith('/')) continue;
      const lnlen = dv.getUint16(lho + 26, true), lxlen = dv.getUint16(lho + 28, true);
      const raw = b.subarray(lho + 30 + lnlen + lxlen, lho + 30 + lnlen + lxlen + csize);
      let data;
      if (method === 0) data = raw.slice();
      else if (method === 8) data = inflateRaw(raw);
      else throw new Error(name + ': método de compressão ' + method + ' não suportado');
      if (crc32(data) !== crc) throw new Error(name + ': CRC errado');
      out.push({ name, data });
    }
    return out;
  }

  function projectToZip(project) {
    const entries = project.fileNames().map((n) => ({ name: n, data: project.text(n) }));
    entries.push({ name: MANIFEST, data: JSON.stringify({ name: project.name, main: project.main, breakpoints: Object.fromEntries(project.breakpoints) }, null, 1) + '\n' });
    return makeZip(entries);
  }

  /* .zip -> Project. Com o manifesto (zip exportado pela IDE), a pasta dele é
   * a raiz do projeto e todos os arquivos com nome válido entram (o
   * explorador aceita qualquer extensão: exportar e reimportar não perde
   * nada). Sem manifesto, só fontes/texto (TEXT_EXT), e uma pasta-raiz
   * única ("proj/a.ksasm") é removida. */
  async function projectFromZip(bytes, fallbackName) {
    const entries = await readZip(bytes);
    let manifest = null, base = null;
    for (const e of entries) {
      if (e.name !== MANIFEST && !e.name.endsWith('/' + MANIFEST)) continue;
      const dir = e.name.slice(0, e.name.length - MANIFEST.length);
      if (base !== null && dir.length >= base.length) continue;      /* o mais raso */
      try { manifest = JSON.parse(dec.decode(e.data)); base = dir; } catch (x) { /* ignora */ }
    }
    if (!manifest || typeof manifest !== 'object') { manifest = null; base = null; }
    const isManifest = (n) => n === MANIFEST || n.endsWith('/' + MANIFEST);
    let files, strip;
    if (base !== null) {
      files = entries.filter((e) => e.name.startsWith(base) && e.name !== base + MANIFEST);
      strip = base.length;
    } else {
      files = entries.filter((e) => !isManifest(e.name) && TEXT_EXT.test(e.name));
      const tops = new Set(files.map((f) => (f.name.includes('/') ? f.name.split('/')[0] : '')));
      strip = tops.size === 1 && !tops.has('') ? [...tops][0].length + 1 : 0;
    }
    const p = new Project({ name: (manifest && typeof manifest.name === 'string' && manifest.name) || fallbackName || 'importado' });
    for (const f of files) {
      const n = f.name.slice(strip);
      if (checkName(n)) continue;
      p.files.set(n, dec.decode(f.data));
    }
    if (!p.files.size) throw new Error('o .zip não tem arquivos de fonte (.ksasm, .asm, .s, .inc)');
    const names = p.fileNames();
    p.main = manifest && p.files.has(manifest.main) ? manifest.main : (names.find((n) => /(^|\/)main\.ksasm$/.test(n)) || names.find((n) => n.endsWith('.ksasm')) || names[0]);
    if (manifest && manifest.breakpoints && typeof manifest.breakpoints === 'object') {
      for (const [k, v] of Object.entries(manifest.breakpoints)) {
        if (p.files.has(k) && Array.isArray(v)) p.setBreakpoints(k, v.filter((x) => Number.isInteger(x)));
      }
    }
    p.open = [p.main];
    p.active = p.main;
    return p;
  }

  const api = {
    Project, ProjectStore, checkName, makeZip, readZip, crc32, projectToZip, projectFromZip,
    MemoryBackend, LocalBackend, IdbBackend, MANIFEST, TEXT_EXT, inflateRaw
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.KsProject = api;
})(typeof self !== 'undefined' ? self : this);
