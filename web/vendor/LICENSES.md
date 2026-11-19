# Código de terceiros em `web/vendor/`

## `codemirror.bundle.js` — CodeMirror 6

Editor de código usado pela IDE. Empacotado uma vez com o esbuild
(`sh tools/build_editor.sh`; versões fixas em `tools/editor/package.json`,
pontos de entrada em `tools/editor/entry.js`) num IIFE que define o global
`CM`, e commitado: `make` não precisa de npm nem de rede, e a página funciona
offline e no arquivo único. O CodeMirror 6 não tem arquivo CSS: os estilos
base são injetados pelo próprio bundle (style-mod); o tema do ksweb fica em
`web/style.css` e em `web/editor.js`.

| Pacote | Versão | Licença |
|--------|--------|---------|
| @codemirror/state | 6.7.6 | MIT |
| @codemirror/view | 6.43.15 | MIT |
| @codemirror/language | 6.13.1 | MIT |
| @codemirror/commands | 6.11.1 | MIT |
| @codemirror/search | 6.7.2 | MIT |
| @codemirror/autocomplete | 6.20.4 | MIT |
| @codemirror/lint | 6.9.8 | MIT |
| @codemirror/streamparser | 6.0.0 | MIT (dependência de @codemirror/language) |
| @lezer/highlight | 1.2.5 | MIT |
| @lezer/common | 1.5.5 | MIT |
| @lezer/lr | 1.4.12 | MIT |
| style-mod | 4.1.5 | MIT |
| w3c-keyname | 2.2.8 | MIT |
| crelt | 1.0.7 | MIT |
| @marijn/find-cluster-break | 1.0.4 | MIT |
| esbuild (só para empacotar, não vai no bundle) | 0.28.2 | MIT |

Projeto: <https://codemirror.net> · autor: Marijn Haverbeke e colaboradores.

### Licença (MIT, igual em todos os pacotes acima, com os anos de cada um)

```
MIT License

Copyright (C) 2018-2021 by Marijn Haverbeke <marijn@haverbeke.berlin> and others

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```
