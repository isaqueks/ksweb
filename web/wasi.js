/*
 * wasi.js — shim WASI preview1 mínimo, sem dependências, com sistema de
 * arquivos em memória. Roda comandos WASI (o ksas.wasm e o ksdis.wasm,
 * compilados com wasi-libc) de forma síncrona, num Worker ou no Node.
 *
 *   runWasi(wasm, {args, files, env, stdin}) -> {exitCode, stdout, stderr,
 *                                               stdoutBytes, stderrBytes, files}
 *
 *   wasm   Uint8Array/ArrayBuffer com o módulo, ou um WebAssembly.Module já
 *          compilado (compileWasi compila e guarda num cache)
 *   args   argv completo, inclusive argv[0] ("ksas")
 *   files  Map (ou objeto) caminho -> Uint8Array | string; caminhos
 *          relativos à raiz ("main.ksasm", "lib/io.ksasm")
 *   env    objeto NOME -> valor (padrão: vazio)
 *   stdin  Uint8Array | string (padrão: vazio)
 *
 * Devolve os arquivos finais (os de entrada mais os criados, menos os
 * apagados) num Map novo; stdout/stderr em texto (UTF-8) e em bytes. Há
 * dois diretórios pré-abertos, "/" (fd 3) e "." (fd 4), ambos a mesma raiz:
 * a wasi-libc resolve caminhos relativos por qualquer um deles.
 *
 * Implementados: args_*, environ_*, clock_*, random_get, sched_yield,
 * proc_exit, fd_read/write/seek/tell/close/sync/fdstat_get/
 * fdstat_set_flags/filestat_get/filestat_set_size/prestat_get/
 * prestat_dir_name, path_open, path_filestat_get, path_unlink_file,
 * path_create_directory, path_remove_directory. Qualquer outro import do
 * módulo devolve ENOSYS (52).
 *
 * Script clássico: importScripts, <script>, Blob e require() do Node.
 */
(function (root) {
  'use strict';

  const E = Object.freeze({
    SUCCESS: 0, ACCES: 2, BADF: 8, EXIST: 20, INVAL: 28, IO: 29, ISDIR: 31,
    NOENT: 44, NOSYS: 52, NOTDIR: 54, NOTEMPTY: 55, SPIPE: 70
  });
  const FT = { UNKNOWN: 0, CHAR: 2, DIR: 3, FILE: 4 };
  const O_CREAT = 1, O_DIRECTORY = 2, O_EXCL = 4, O_TRUNC = 8;
  const FDFLAG_APPEND = 1;
  const RIGHT_FD_READ = 2n, RIGHT_FD_WRITE = 64n;
  const ALL_RIGHTS = 0x1FFFFFFFn;

  const enc = new TextEncoder();
  const dec = new TextDecoder();

  class WasiExit extends Error {
    constructor(code) { super('proc_exit(' + code + ')'); this.code = code; }
  }

  function toBytes(v) {
    if (v instanceof Uint8Array) return v;
    if (typeof v === 'string') return enc.encode(v);
    if (v instanceof ArrayBuffer) return new Uint8Array(v);
    if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
    return new Uint8Array(0);
  }

  /* Caminho normalizado relativo à raiz, sem "/" inicial; null se sai dela. */
  function normPath(base, p) {
    const parts = [];
    const all = (p.startsWith('/') ? p : (base ? base + '/' : '') + p).split('/');
    for (const s of all) {
      if (s === '' || s === '.') continue;
      if (s === '..') { if (!parts.length) return null; parts.pop(); continue; }
      parts.push(s);
    }
    return parts.join('/');
  }

  const modCache = new WeakMap();

  /* Compila (e guarda) o módulo; aceita bytes ou um Module. */
  function compileWasi(wasm) {
    if (wasm instanceof WebAssembly.Module) return wasm;
    const key = wasm instanceof ArrayBuffer ? wasm : wasm.buffer;
    const hit = key && modCache.get(key);
    if (hit && hit.len === wasm.byteLength && hit.off === (wasm.byteOffset || 0)) return hit.mod;
    const mod = new WebAssembly.Module(toBytes(wasm));
    if (key) modCache.set(key, { mod, len: wasm.byteLength, off: wasm.byteOffset || 0 });
    return mod;
  }

  function runWasi(wasm, opts) {
    opts = opts || {};
    const mod = compileWasi(wasm);
    const args = (opts.args || ['prog']).map(String);
    const env = Object.entries(opts.env || {}).map(([k, v]) => k + '=' + v);
    const files = new Map();
    const srcFiles = opts.files instanceof Map ? opts.files : new Map(Object.entries(opts.files || {}));
    for (const [k, v] of srcFiles) {
      const n = normPath('', k);
      if (n) files.set(n, toBytes(v).slice());
    }
    const dirs = new Set();          /* diretórios criados explicitamente */
    const stdin = toBytes(opts.stdin || '');
    let stdinPos = 0;
    const out = { 1: [], 2: [] };

    /* fd -> {type, path, data, size, pos, read, write, append, dirty} */
    const fds = new Map();
    fds.set(0, { type: 'stdin' });
    fds.set(1, { type: 'out', n: 1 });
    fds.set(2, { type: 'out', n: 2 });
    fds.set(3, { type: 'dir', path: '', pre: '/' });
    fds.set(4, { type: 'dir', path: '', pre: '.' });
    let nextFd = 5;

    let memory = null;
    const dv = () => new DataView(memory.buffer);
    const u8 = () => new Uint8Array(memory.buffer);
    const str = (ptr, len) => dec.decode(u8().subarray(ptr, ptr + len));

    function isDir(path) {
      if (path === '' || dirs.has(path)) return true;
      const pre = path + '/';
      for (const k of files.keys()) if (k.startsWith(pre)) return true;
      for (const d of dirs) if (d.startsWith(pre)) return true;
      return false;
    }

    function resolve(dirfd, ptr, len) {
      const d = fds.get(dirfd);
      if (!d) return { err: E.BADF };
      if (d.type !== 'dir') return { err: E.NOTDIR };
      const p = normPath(d.path, str(ptr, len));
      if (p === null) return { err: E.ACCES };
      return { path: p };
    }

    function commit(f) {
      if (f.type === 'file' && f.dirty) {
        files.set(f.path, f.data.slice(0, f.size));
        f.dirty = false;
      }
    }

    function ensureCap(f, need) {
      if (need <= f.data.length) return;
      let cap = Math.max(256, f.data.length * 2);
      while (cap < need) cap *= 2;
      const nb = new Uint8Array(cap);
      nb.set(f.data.subarray(0, f.size));
      f.data = nb;
    }

    function writeFilestat(ptr, type, size) {
      const v = dv();
      for (let i = 0; i < 64; i += 8) v.setBigUint64(ptr + i, 0n, true);
      v.setBigUint64(ptr + 8, 1n, true);
      v.setUint8(ptr + 16, type);
      v.setBigUint64(ptr + 24, 1n, true);
      v.setBigUint64(ptr + 32, BigInt(size), true);
    }

    function iovecs(iovs, n) {
      const v = dv(), list = [];
      for (let i = 0; i < n; i++) list.push([v.getUint32(iovs + 8 * i, true), v.getUint32(iovs + 8 * i + 4, true)]);
      return list;
    }

    function strList(list, ptrs, buf) {
      const v = dv(), m = u8();
      let p = buf;
      list.forEach((s, i) => {
        const b = enc.encode(s);
        v.setUint32(ptrs + 4 * i, p, true);
        m.set(b, p);
        m[p + b.length] = 0;
        p += b.length + 1;
      });
      return E.SUCCESS;
    }
    function strSizes(list, countPtr, sizePtr) {
      const v = dv();
      v.setUint32(countPtr, list.length, true);
      v.setUint32(sizePtr, list.reduce((a, s) => a + enc.encode(s).length + 1, 0), true);
      return E.SUCCESS;
    }

    const wasi = {
      args_sizes_get: (c, s) => strSizes(args, c, s),
      args_get: (p, b) => strList(args, p, b),
      environ_sizes_get: (c, s) => strSizes(env, c, s),
      environ_get: (p, b) => strList(env, p, b),

      clock_res_get(id, ptr) { dv().setBigUint64(ptr, 1000n, true); return E.SUCCESS; },
      clock_time_get(id, prec, ptr) {
        const ms = id === 0 ? Date.now() : (typeof performance !== 'undefined' ? performance.now() : Date.now());
        dv().setBigUint64(ptr, BigInt(Math.round(ms * 1e6)), true);
        return E.SUCCESS;
      },
      random_get(ptr, len) {
        const m = u8();
        for (let i = 0; i < len; i++) m[ptr + i] = (Math.random() * 256) | 0;
        return E.SUCCESS;
      },
      sched_yield: () => E.SUCCESS,
      proc_exit(code) { throw new WasiExit(code >>> 0); },

      fd_write(fd, iovs, n, nwritten) {
        const f = fds.get(fd);
        if (!f) return E.BADF;
        let total = 0;
        for (const [p, l] of iovecs(iovs, n)) {
          const chunk = u8().slice(p, p + l);
          if (f.type === 'out') out[f.n].push(chunk);
          else if (f.type === 'file') {
            if (!f.write) return E.BADF;
            if (f.append) f.pos = f.size;
            ensureCap(f, f.pos + l);
            /* escrita além do fim: o buraco é zero (o buffer pode guardar
             * bytes antigos depois de O_TRUNC ou de um ftruncate menor) */
            if (f.pos > f.size) f.data.fill(0, f.size, f.pos);
            f.data.set(chunk, f.pos);
            f.pos += l;
            if (f.pos > f.size) f.size = f.pos;
            f.dirty = true;
          } else return E.BADF;
          total += l;
        }
        dv().setUint32(nwritten, total, true);
        return E.SUCCESS;
      },
      fd_read(fd, iovs, n, nread) {
        const f = fds.get(fd);
        if (!f) return E.BADF;
        let total = 0;
        for (const [p, l] of iovecs(iovs, n)) {
          let src, pos, size;
          if (f.type === 'stdin') { src = stdin; pos = stdinPos; size = stdin.length; }
          else if (f.type === 'file') { if (!f.read) return E.BADF; src = f.data; pos = f.pos; size = f.size; }
          else return f.type === 'dir' ? E.ISDIR : E.BADF;
          const k = Math.max(0, Math.min(l, size - pos));
          u8().set(src.subarray(pos, pos + k), p);
          if (f.type === 'stdin') stdinPos += k; else f.pos += k;
          total += k;
          if (k < l) break;
        }
        dv().setUint32(nread, total, true);
        return E.SUCCESS;
      },
      fd_seek(fd, offset, whence, ptr) {
        const f = fds.get(fd);
        if (!f) return E.BADF;
        if (f.type !== 'file') return E.SPIPE;
        const base = whence === 0 ? 0 : whence === 1 ? f.pos : whence === 2 ? f.size : -1;
        if (base < 0) return E.INVAL;
        const np = base + Number(offset);
        if (np < 0) return E.INVAL;
        f.pos = np;
        dv().setBigUint64(ptr, BigInt(np), true);
        return E.SUCCESS;
      },
      fd_tell(fd, ptr) {
        const f = fds.get(fd);
        if (!f) return E.BADF;
        if (f.type !== 'file') return E.SPIPE;
        dv().setBigUint64(ptr, BigInt(f.pos), true);
        return E.SUCCESS;
      },
      fd_close(fd) {
        const f = fds.get(fd);
        if (!f) return E.BADF;
        commit(f);
        if (fd > 4) fds.delete(fd);
        return E.SUCCESS;
      },
      fd_sync(fd) { const f = fds.get(fd); if (!f) return E.BADF; commit(f); return E.SUCCESS; },
      fd_datasync(fd) { return wasi.fd_sync(fd); },
      fd_fdstat_get(fd, ptr) {
        const f = fds.get(fd);
        if (!f) return E.BADF;
        const v = dv();
        const type = f.type === 'dir' ? FT.DIR : f.type === 'file' ? FT.FILE : FT.CHAR;
        v.setUint8(ptr, type);
        v.setUint16(ptr + 2, f.append ? FDFLAG_APPEND : 0, true);
        v.setBigUint64(ptr + 8, ALL_RIGHTS, true);
        v.setBigUint64(ptr + 16, ALL_RIGHTS, true);
        return E.SUCCESS;
      },
      fd_fdstat_set_flags(fd, flags) {
        const f = fds.get(fd);
        if (!f) return E.BADF;
        f.append = (flags & FDFLAG_APPEND) !== 0;
        return E.SUCCESS;
      },
      fd_filestat_get(fd, ptr) {
        const f = fds.get(fd);
        if (!f) return E.BADF;
        if (f.type === 'file') writeFilestat(ptr, FT.FILE, f.size);
        else writeFilestat(ptr, f.type === 'dir' ? FT.DIR : FT.CHAR, 0);
        return E.SUCCESS;
      },
      fd_filestat_set_size(fd, size) {
        const f = fds.get(fd);
        if (!f || f.type !== 'file') return E.BADF;
        const n = Number(size);
        ensureCap(f, n);
        if (n > f.size) f.data.fill(0, f.size, n);
        f.size = n;
        f.dirty = true;
        return E.SUCCESS;
      },
      fd_prestat_get(fd, ptr) {
        const f = fds.get(fd);
        if (!f || !f.pre) return E.BADF;
        const v = dv();
        v.setUint8(ptr, 0);
        v.setUint32(ptr + 4, enc.encode(f.pre).length, true);
        return E.SUCCESS;
      },
      fd_prestat_dir_name(fd, ptr, len) {
        const f = fds.get(fd);
        if (!f || !f.pre) return E.BADF;
        u8().set(enc.encode(f.pre).subarray(0, len), ptr);
        return E.SUCCESS;
      },

      path_open(dirfd, dirflags, p, plen, oflags, rbase, rinh, fdflags, fdPtr) {
        const r = resolve(dirfd, p, plen);
        if (r.err) return r.err;
        const path = r.path;
        const exists = files.has(path);
        const dir = !exists && isDir(path);
        if ((oflags & O_DIRECTORY) && !dir) return exists ? E.NOTDIR : E.NOENT;
        if (dir) {
          if ((oflags & (O_CREAT | O_TRUNC)) && !(oflags & O_DIRECTORY)) return E.ISDIR;
          const fd = nextFd++;
          fds.set(fd, { type: 'dir', path });
          dv().setUint32(fdPtr, fd, true);
          return E.SUCCESS;
        }
        if (exists && (oflags & O_CREAT) && (oflags & O_EXCL)) return E.EXIST;
        if (!exists && !(oflags & O_CREAT)) return E.NOENT;
        const slash = path.lastIndexOf('/');
        if (!exists && slash >= 0 && !isDir(path.slice(0, slash))) return E.NOENT;
        const rights = BigInt(rbase);
        const f = {
          type: 'file', path, pos: 0,
          read: (rights & RIGHT_FD_READ) !== 0n,
          write: (rights & RIGHT_FD_WRITE) !== 0n,
          append: (fdflags & FDFLAG_APPEND) !== 0,
          dirty: false
        };
        const cur = exists ? files.get(path) : new Uint8Array(0);
        f.data = cur.slice();
        f.size = cur.length;
        if (!exists || (oflags & O_TRUNC)) {
          f.size = 0;
          f.dirty = true;
          commit(f);                       /* cria/trunca já na abertura */
        }
        const fd = nextFd++;
        fds.set(fd, f);
        dv().setUint32(fdPtr, fd, true);
        return E.SUCCESS;
      },
      path_filestat_get(dirfd, flags, p, plen, ptr) {
        const r = resolve(dirfd, p, plen);
        if (r.err) return r.err;
        if (files.has(r.path)) writeFilestat(ptr, FT.FILE, files.get(r.path).length);
        else if (isDir(r.path)) writeFilestat(ptr, FT.DIR, 0);
        else return E.NOENT;
        return E.SUCCESS;
      },
      path_unlink_file(dirfd, p, plen) {
        const r = resolve(dirfd, p, plen);
        if (r.err) return r.err;
        if (!files.has(r.path)) return isDir(r.path) ? E.ISDIR : E.NOENT;
        files.delete(r.path);
        for (const f of fds.values()) if (f.type === 'file' && f.path === r.path) f.dirty = false;
        return E.SUCCESS;
      },
      path_create_directory(dirfd, p, plen) {
        const r = resolve(dirfd, p, plen);
        if (r.err) return r.err;
        if (files.has(r.path) || isDir(r.path)) return E.EXIST;
        dirs.add(r.path);
        return E.SUCCESS;
      },
      path_remove_directory(dirfd, p, plen) {
        const r = resolve(dirfd, p, plen);
        if (r.err) return r.err;
        if (!isDir(r.path)) return files.has(r.path) ? E.NOTDIR : E.NOENT;
        const pre = r.path + '/';
        for (const k of files.keys()) if (k.startsWith(pre)) return E.NOTEMPTY;
        dirs.delete(r.path);
        return E.SUCCESS;
      }
    };

    /* Imports que o módulo pede e o shim não tem: ENOSYS. */
    const imports = { wasi_snapshot_preview1: {} };
    for (const imp of WebAssembly.Module.imports(mod)) {
      if (imp.kind !== 'function') continue;
      if (imp.module !== 'wasi_snapshot_preview1') {
        throw new Error('import não suportado: ' + imp.module + '.' + imp.name);
      }
      imports.wasi_snapshot_preview1[imp.name] = wasi[imp.name] || (() => E.NOSYS);
    }

    const inst = new WebAssembly.Instance(mod, imports);
    memory = inst.exports.memory;
    let exitCode = 0;
    try {
      if (inst.exports._start) inst.exports._start();
      else if (inst.exports._initialize) inst.exports._initialize();
    } catch (e) {
      if (e instanceof WasiExit) exitCode = e.code;
      else throw e;
    }
    for (const f of fds.values()) commit(f);
    const join = (chunks) => {
      const n = chunks.reduce((a, c) => a + c.length, 0), b = new Uint8Array(n);
      let o = 0;
      for (const c of chunks) { b.set(c, o); o += c.length; }
      return b;
    };
    const so = join(out[1]), se = join(out[2]);
    return { exitCode, stdout: dec.decode(so), stderr: dec.decode(se), stdoutBytes: so, stderrBytes: se, files };
  }

  const api = { runWasi, compileWasi, WasiExit, WASI_ERRNO: E, normPath };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else Object.assign(root, api);
})(typeof self !== 'undefined' ? self : this);
