#!/usr/bin/env node
/*
 * test_project.js — projetos da IDE (web/project.js), em Node:
 *
 * - operações do explorador: novo, renomear (principal, breakpoints e abas
 *   acompanham), excluir, duplicar, principal, nomes inválidos;
 * - persistência com um IndexedDB falso (assíncrono, sobrevive a "reabrir a
 *   página"), fallback para localStorage quando o IndexedDB falha e para
 *   memória sem nenhum dos dois; meta (último projeto);
 * - .zip: ida e volta, leitura de entradas deflate (zlib), CRC, pasta-raiz
 *   única, manifesto com principal e breakpoints, e o zip gerado aberto pelo
 *   zipfile do Python (se houver python3).
 */
'use strict';
const zlib = require('zlib');
const { spawnSync } = require('child_process');
const P = require('../web/project.js');

let total = 0, failed = 0;
const queue = [];
function test(name, fn) { queue.push([name, fn]); }
function eq(a, b, what) {
  const sa = JSON.stringify(a), sb = JSON.stringify(b);
  if (sa !== sb) throw new Error((what || 'valor') + ': ' + sa + ' != esperado ' + sb);
}
function ok(c, what) { if (!c) throw new Error(what || 'condição falsa'); }
async function throwsMsg(fn, re) {
  try { await fn(); } catch (e) { ok(re.test(e.message), 'mensagem: ' + e.message); return; }
  throw new Error('deveria falhar');
}

/* ---- IndexedDB falso (o suficiente para project.js) ---- */
function fakeIndexedDB(opts) {
  opts = opts || {};
  const dbs = new Map();          /* nome -> {version, stores: Map(nome -> {keyPath, data: Map})} */
  const later = (fn) => setTimeout(fn, 0);
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  function request(fn) {
    const req = { result: undefined, error: null, onsuccess: null, onerror: null };
    later(() => {
      try { req.result = fn(); if (req.onsuccess) req.onsuccess({ target: req }); }
      catch (e) { req.error = e; if (req.onerror) req.onerror({ target: req }); }
    });
    return req;
  }
  function makeDb(rec) {
    return {
      objectStoreNames: { contains: (n) => rec.stores.has(n) },
      createObjectStore(n, o) { rec.stores.set(n, { keyPath: o && o.keyPath, data: new Map() }); },
      transaction(n, mode) {
        return {
          objectStore(name) {
            const st = rec.stores.get(name);
            if (!st) throw new Error('store inexistente ' + name);
            const ro = mode !== 'readwrite';
            return {
              get: (k) => request(() => clone(st.data.get(k))),
              getAll: () => request(() => [...st.data.values()].map(clone)),
              put: (v, k) => request(() => { if (ro) throw new Error('readonly'); st.data.set(st.keyPath ? v[st.keyPath] : k, clone(v)); }),
              delete: (k) => request(() => { if (ro) throw new Error('readonly'); st.data.delete(k); })
            };
          }
        };
      }
    };
  }
  return {
    dbs,
    open(name, version) {
      const req = { result: null, error: null, onsuccess: null, onerror: null, onupgradeneeded: null };
      later(() => {
        if (opts.fail) { req.error = new Error('IndexedDB bloqueado'); if (req.onerror) req.onerror({}); return; }
        let rec = dbs.get(name);
        const upgrade = !rec || rec.version < version;
        if (!rec) { rec = { version, stores: new Map() }; dbs.set(name, rec); }
        req.result = makeDb(rec);
        if (upgrade && req.onupgradeneeded) req.onupgradeneeded({});
        rec.version = version;
        if (req.onsuccess) req.onsuccess({});
      });
      return req;
    }
  };
}

function fakeLocalStorage(fail) {
  const m = new Map();
  return {
    m,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { if (fail) throw new Error('QuotaExceeded'); m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); }
  };
}

/* ---- operações ---- */

test('explorador: novo, renomear, duplicar, excluir, principal', async () => {
  const p = P.Project.create('demo', { 'main.ksasm': '_start: halt\n', 'lib/io.ksasm': '; io\n' }, 'main.ksasm');
  eq(p.fileNames(), ['lib/io.ksasm', 'main.ksasm']);
  eq(p.main, 'main.ksasm');
  p.addFile('util.ksasm', 'x');
  await throwsMsg(() => p.addFile('util.ksasm', ''), /já existe/);
  await throwsMsg(() => p.addFile('../fora.ksasm', ''), /\.\./);
  await throwsMsg(() => p.addFile('a"b.ksasm', ''), /aspas/);
  await throwsMsg(() => p.addFile('', ''), /vazio/);
  await throwsMsg(() => p.addFile('/abs.ksasm', ''), /letras/);
  await throwsMsg(() => p.addFile('.ksweb.ksx', ''), /letras|reservado/);
  p.addFile('ção/ação.ksasm', '');
  p.setBreakpoints('main.ksasm', [3, 1, 3]);
  p.openFile('main.ksasm');
  p.openFile('util.ksasm');
  p.renameFile('main.ksasm', 'prog.ksasm');
  eq([p.main, p.breakpoints.get('prog.ksasm'), p.open, p.active], ['prog.ksasm', [1, 3], ['prog.ksasm', 'util.ksasm'], 'util.ksasm']);
  ok(!p.has('main.ksasm') && p.text('prog.ksasm') === '_start: halt\n', 'texto acompanha');
  await throwsMsg(() => p.renameFile('prog.ksasm', 'util.ksasm'), /já existe/);
  const d = p.duplicateFile('util.ksasm');
  eq(d, 'util-copia.ksasm');
  eq(p.duplicateFile('util.ksasm'), 'util-copia-2.ksasm');
  eq(p.uniqueName('novo.ksasm'), 'novo.ksasm');
  p.addFile('novo.ksasm', '');
  eq(p.uniqueName('novo.ksasm'), 'novo-2.ksasm');
  p.setMain('util.ksasm');
  p.deleteFile('util.ksasm');
  ok(p.main && p.main !== 'util.ksasm', 'principal reatribuído: ' + p.main);
  eq(p.open, ['prog.ksasm']);
  eq(p.active, 'prog.ksasm');
  p.deleteFile('prog.ksasm');
  ok(!p.breakpoints.has('prog.ksasm'), 'breakpoints do arquivo excluído');
  ok(p.setText('novo.ksasm', 'abc') && !p.setText('novo.ksasm', 'abc'), 'setText detecta mudança');
});

test('JSON: ida e volta', async () => {
  const p = P.Project.create('x', { 'a.ksasm': 'A', 'b.ksasm': 'B' }, 'b.ksasm');
  p.setBreakpoints('a.ksasm', [2]);
  p.openFile('a.ksasm');
  const q = P.Project.fromJSON(JSON.parse(JSON.stringify(p.toJSON())));
  eq(q.toJSON(), p.toJSON());
  const r = P.Project.fromJSON({ name: 'y', files: [{ name: 'z.ksasm', text: '' }], main: 'naoexiste', breakpoints: { 'naoexiste.ksasm': [1] }, open: ['fantasma'] });
  eq([r.main, r.breakpoints.size, r.open], ['z.ksasm', 0, []], 'referências inválidas descartadas');
});

/* ---- persistência ---- */

test('IndexedDB falso: salvar, listar, reabrir a página, excluir, meta', async () => {
  const idb = fakeIndexedDB();
  const s1 = new P.ProjectStore({ indexedDB: idb, localStorage: null });
  eq(await s1.open(), 'indexeddb');
  const a = P.Project.create('alfa', { 'main.ksasm': 'halt\n' }, 'main.ksasm');
  const b = P.Project.create('beta', { 'b.ksasm': 'nop\n' }, 'b.ksasm');
  await s1.save(a);
  b.updated = a.updated + 10;
  await s1.save(b);
  await s1.setMeta('last', b.id);
  eq((await s1.list()).map((x) => x.name), ['beta', 'alfa'], 'mais recente primeiro');
  /* "reabrir a página": outro ProjectStore sobre o mesmo banco */
  const s2 = new P.ProjectStore({ indexedDB: idb, localStorage: null });
  await s2.open();
  eq(await s2.getMeta('last'), b.id);
  const b2 = await s2.load(b.id);
  eq(b2.toJSON(), b.toJSON(), 'projeto recuperado igual');
  b2.setText('b.ksasm', 'halt\n');
  await s2.save(b2);
  eq((await s1.load(b.id)).text('b.ksasm'), 'halt\n', 'autosave visível');
  await s2.remove(a.id);
  eq((await s2.list()).length, 1);
  eq(await s2.load('nada'), null);
  eq(await s2.getMeta('nada'), null);
});

test('fallback: IndexedDB falha -> localStorage; nada -> memória', async () => {
  const ls = fakeLocalStorage();
  const s = new P.ProjectStore({ indexedDB: fakeIndexedDB({ fail: true }), localStorage: ls });
  eq(await s.open(), 'localstorage');
  const p = P.Project.create('gama', { 'g.ksasm': 'halt\n' }, 'g.ksasm');
  await s.save(p);
  await s.setMeta('layout', { left: 200 });
  const s2 = new P.ProjectStore({ indexedDB: null, localStorage: ls });
  eq(await s2.open(), 'localstorage');
  eq((await s2.load(p.id)).name, 'gama');
  eq(await s2.getMeta('layout'), { left: 200 });
  eq((await s2.list()).map((x) => x.name), ['gama']);
  await s2.remove(p.id);
  eq((await s2.list()).length, 0);
  const s3 = new P.ProjectStore({ indexedDB: null, localStorage: fakeLocalStorage(true) });
  eq(await s3.open(), 'memory', 'localStorage cheio/bloqueado');
  await s3.save(p);
  eq((await s3.load(p.id)).name, 'gama');
});

/* Cookies/armazenamento bloqueados no navegador: ler window.localStorage ou
 * window.indexedDB lança SecurityError. O ProjectStore com os globais
 * padrão (project.js carregado como <script>, root = self) cai na memória
 * em vez de derrubar a página. */
test('globais localStorage/indexedDB que lançam SecurityError -> memória', async () => {
  const vm = require('vm');
  const ctx = { TextEncoder, TextDecoder, console };
  for (const k of ['localStorage', 'indexedDB']) Object.defineProperty(ctx, k, { get() { throw new Error('SecurityError: bloqueado'); } });
  ctx.self = ctx;
  vm.createContext(ctx);
  vm.runInContext(require('fs').readFileSync(require.resolve('../web/project.js'), 'utf8'), ctx);
  const s = vm.runInContext('new KsProject.ProjectStore()', ctx);
  eq(await s.open(), 'memory');
});

/* ---- zip ---- */

test('zip: ida e volta com nomes UTF-8 e pastas', async () => {
  const files = [{ name: 'main.ksasm', data: '_start: halt\n' }, { name: 'lib/ação.ksasm', data: '; ç\n' }, { name: 'vazio.ksasm', data: '' }];
  const z = P.makeZip(files);
  const back = await P.readZip(z);
  eq(back.map((e) => [e.name, Buffer.from(e.data).toString()]), files.map((f) => [f.name, f.data]));
  eq(P.crc32(Buffer.from('123456789')), 0xCBF43926, 'CRC-32 de referência');
  const bad = z.slice();
  bad[40] ^= 1;                      /* corrompe um byte de dados do primeiro arquivo */
  await throwsMsg(() => P.readZip(bad), /CRC/);
  await throwsMsg(() => P.readZip(new Uint8Array(10)), /zip/);
});

/* zip com entradas deflate (método 8), montado aqui com o zlib do Node */
function deflateZip(files) {
  const parts = [], central = [];
  let off = 0;
  for (const f of files) {
    const name = Buffer.from(f.name), data = Buffer.from(f.data), comp = zlib.deflateRawSync(data);
    const crc = P.crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(name.length, 26);
    parts.push(lh, name, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(off, 42);
    central.push(ch, name);
    off += 30 + name.length + comp.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return new Uint8Array(Buffer.concat(parts.concat([cd, end])));
}

test('zip: entradas deflate e projeto com pasta-raiz', async () => {
  const z = deflateZip([
    { name: 'meuproj/', data: '' },
    { name: 'meuproj/src/main.ksasm', data: '  .include "lib.ksasm"\n'.repeat(20) },
    { name: 'meuproj/src/lib.ksasm', data: 'f: ret\n' },
    { name: 'meuproj/LEIAME.bin', data: '\x00\x01' }
  ]);
  const p = await P.projectFromZip(z, 'meuproj.zip');
  eq(p.fileNames(), ['src/lib.ksasm', 'src/main.ksasm'], 'pasta-raiz removida, binário ignorado');
  eq(p.main, 'src/main.ksasm');
  eq(p.name, 'meuproj.zip');
});

test('inflate: blocos stored, fixos e dinâmicos (zlib níveis 0..9)', async () => {
  let seed = 12345;
  const rnd = () => (seed = (seed * 1103515245 + 12345) >>> 0) >>> 16;
  const samples = [Buffer.alloc(0), Buffer.from('a'), Buffer.from('abcabcabcabc'.repeat(500))];
  const text = Buffer.alloc(70000);
  for (let i = 0; i < text.length; i++) text[i] = ' etaoinshrdlu\n;r0123,'.charCodeAt(rnd() % 21);
  const noise = Buffer.alloc(40000);
  for (let i = 0; i < noise.length; i++) noise[i] = rnd() & 255;
  samples.push(text, noise);
  for (const s of samples) {
    for (let level = 0; level <= 9; level++) {
      const out = P.inflateRaw(zlib.deflateRawSync(s, { level }));
      ok(Buffer.from(out).equals(s), 'nível ' + level + ', ' + s.length + ' bytes');
    }
    const fixed = zlib.deflateRawSync(s, { strategy: zlib.constants.Z_FIXED });
    ok(Buffer.from(P.inflateRaw(fixed)).equals(s), 'Z_FIXED ' + s.length);
  }
  let threw = false;
  try { P.inflateRaw(new Uint8Array([0xFF, 0xFF, 0xFF])); } catch (e) { threw = /deflate/.test(e.message); }
  ok(threw, 'lixo é recusado');
});

test('projeto -> zip -> projeto (manifesto)', async () => {
  const p = P.Project.create('meu', { 'a.ksasm': 'A\n', 'principal.ksasm': 'P\n' }, 'principal.ksasm');
  p.setBreakpoints('principal.ksasm', [1, 7]);
  const q = await P.projectFromZip(P.projectToZip(p));
  eq([q.name, q.main, q.fileNames(), q.breakpoints.get('principal.ksasm')], ['meu', 'principal.ksasm', ['a.ksasm', 'principal.ksasm'], [1, 7]]);
  await throwsMsg(() => P.projectFromZip(P.makeZip([{ name: 'x.bin', data: 'x' }])), /não tem arquivos/);
});

/* Exportar e reimportar não pode perder nem renomear nada: um projeto cujos
 * arquivos estão todos numa pasta ("src/...") não tem pasta-raiz a remover
 * (o manifesto fica na raiz do zip), e arquivos que o explorador aceita sem
 * extensão de fonte (defs.h, Makefile, notas) voltam também. */
test('projeto -> zip -> projeto preserva pastas, breakpoints e todos os arquivos', async () => {
  const p = P.Project.create('src', {
    'src/main.ksasm': '  .include "lib/io.ksasm"\n_start: halt\n', 'src/lib/io.ksasm': 'f: ret\n',
    'src/defs.h': 'N = 3\n', 'src/Makefile': 'all:\n', 'src/notas': 'lembrete\n'
  }, 'src/main.ksasm');
  p.setBreakpoints('src/main.ksasm', [2]);
  p.setBreakpoints('src/lib/io.ksasm', [1]);
  const q = await P.projectFromZip(P.projectToZip(p), 'src.zip');
  eq(q.fileNames(), p.fileNames(), 'mesmos nomes');
  for (const n of p.fileNames()) eq(q.text(n), p.text(n), 'texto de ' + n);
  eq(q.main, 'src/main.ksasm', 'principal');
  eq([q.breakpoints.get('src/main.ksasm'), q.breakpoints.get('src/lib/io.ksasm')], [[2], [1]], 'breakpoints');
  /* o mesmo zip dentro de uma pasta-raiz (extraído e recompactado): ela sai */
  const entries = (await P.readZip(P.projectToZip(p))).map((e) => ({ name: 'exportado/' + e.name, data: e.data }));
  const r = await P.projectFromZip(P.makeZip(entries), 'x.zip');
  eq([r.fileNames(), r.main, r.breakpoints.get('src/main.ksasm')], [p.fileNames(), 'src/main.ksasm', [2]], 'com pasta-raiz');
  /* breakpoints do manifesto que não são listas de linhas são ignorados */
  const bad = P.makeZip([{ name: 'a.ksasm', data: 'halt\n' }, { name: P.MANIFEST, data: JSON.stringify({ main: 'a.ksasm', breakpoints: { 'a.ksasm': '123' } }) }]);
  const s = await P.projectFromZip(bad);
  ok(!s.breakpoints.has('a.ksasm') || s.breakpoints.get('a.ksasm').every((x) => typeof x === 'number'), 'linhas numéricas');
});

test('zip gerado abre no zipfile do Python', async () => {
  const z = P.projectToZip(P.Project.create('py', { 'main.ksasm': 'halt\n', 'lib/x.ksasm': 'nop\n' }, 'main.ksasm'));
  const r = spawnSync('python3', ['-c', 'import sys,zipfile,io\nz=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read()))\nassert z.testzip() is None\nprint(",".join(sorted(z.namelist())))'], { input: Buffer.from(z) });
  if (r.error) { console.log('  (python3 ausente: pulado)'); return; }
  eq(r.status, 0, 'python: ' + r.stderr);
  eq(r.stdout.toString().trim(), 'ksweb-projeto.json,lib/x.ksasm,main.ksasm');
});

(async () => {
  for (const [name, fn] of queue) {
    total++;
    try { await fn(); } catch (e) { failed++; console.log('FALHA [' + name + '] ' + (e && e.stack ? e.stack.split('\n').slice(0, 2).join(' | ') : e)); }
  }
  console.log('test_project: ' + total + ' casos, ' + failed + ' falhas');
  process.exit(failed ? 1 : 0);
})();
