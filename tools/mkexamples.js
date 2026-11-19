#!/usr/bin/env node
/*
 * mkexamples.js — gera examples.js com os exemplos embutidos da página.
 *
 *   node tools/mkexamples.js menu.json DIR_KSX DIR_FONTES... > examples.js
 *
 * Para cada item de menu.json lê DIR_KSX/<name>.ksx e procura
 * <name>.ksasm nos diretórios de fontes (e em v1_ported/): a descrição sai
 * do comentário inicial, e o fonte com os arquivos que ele inclui
 * (.include, recursivo, relativo a quem inclui) vira o projeto que a IDE
 * abre. Saída: um script clássico que define KSWEB_EXAMPLES = [{name,
 * title, stdin, desc, b64, main, files: {caminho: texto}}] no escopo global.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const [menuPath, ksxDir, ...srcDirs] = process.argv.slice(2);
const menu = JSON.parse(fs.readFileSync(menuPath, 'utf8'));

function findSource(name) {
  for (const d of srcDirs) {
    for (const p of [path.join(d, name + '.ksasm'), path.join(d, 'v1_ported', name + '.ksasm')]) {
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

/* Arquivos do projeto: o principal na raiz e os incluídos relativos a ele. */
function collect(mainPath) {
  const root = path.dirname(mainPath);
  const files = {};
  const visit = (abs) => {
    const rel = path.relative(root, abs).split(path.sep).join('/');
    if (rel in files || rel.startsWith('..')) return;
    const text = fs.readFileSync(abs, 'utf8');
    files[rel] = text;
    for (const m of text.matchAll(/^\s*\.include\s+"([^"]+)"/gm)) {
      const inc = path.resolve(path.dirname(abs), m[1]);
      if (fs.existsSync(inc)) visit(inc);
    }
  };
  visit(mainPath);
  return files;
}

/* Primeiro parágrafo de comentários ";" do topo, sem o "nome.ksasm —". */
function description(src) {
  const lines = [];
  for (const l of src.split('\n')) {
    if (!l.startsWith(';')) break;
    const t = l.replace(/^;\s?/, '');
    if (t.trim() === '') break;
    lines.push(t.trim());
  }
  return lines.join(' ').replace(/^\S+\.ksasm\s+—\s+/, '');
}

const out = menu.map((m) => {
  const file = path.join(ksxDir, m.name + '.ksx');
  const bytes = fs.readFileSync(file);
  const src = findSource(m.name);
  const e = { name: m.name, title: m.title, stdin: !!m.stdin, desc: src ? description(fs.readFileSync(src, 'utf8')) : '', b64: bytes.toString('base64') };
  if (src) { e.main = path.basename(src); e.files = collect(src); }
  return e;
});

process.stdout.write('/* gerado por tools/mkexamples.js — não editar */\n' +
  '(typeof self !== "undefined" ? self : globalThis).KSWEB_EXAMPLES = ' +
  JSON.stringify(out, null, 1) + ';\n');
