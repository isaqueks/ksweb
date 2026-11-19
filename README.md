# ksweb — IDE da KSVM v2 no navegador

Uma IDE para a máquina virtual [KSVM v2](../ksvm2/README.md) que roda
inteira no navegador, offline: editor de assembly com realce, autocomplete
e erros enquanto se digita; montagem com o próprio `ksas` da ksvm2
compilado para WebAssembly; execução num terminal VT100/xterm de verdade; e
depuração com breakpoints no código-fonte, passo por cima/para dentro/sair
da função, registradores, watch, pilha, memória e trace. Sem dependências
de rede nem CDN, em Chrome, Firefox e Safari atuais — inclusive num único
arquivo HTML.

- **VM**: o núcleo `ksvm2/src/core/*.c`, compilado direto da árvore da
  ksvm2 com `clang --target=wasm32`, sem Emscripten e sem libc
  (`build/ksvm.wasm`, ~48 KB), num Web Worker em fatias: a página nunca
  congela; sem entrada disponível, `GETC`/`GETS` suspendem a VM.
- **Assembler**: `ksas` e `ksdis` da ksvm2, sem alteração, como comandos
  WASI (wasi-libc; `ksas.wasm` ~100 KB, `ksdis.wasm` ~70 KB), rodados por um
  shim WASI próprio com sistema de arquivos em memória (`web/wasi.js`) num
  segundo worker. A saída é **byte a byte idêntica** à das ferramentas
  nativas (os testes comparam todos os exemplos, listings e erros).
- **Editor**: CodeMirror 6 (MIT) vendorizado em `web/vendor/` (~400 KB),
  com a linguagem `ksasm` e o vocabulário gerado do `isa.def`
  (`isa.json`).
- **Depuração no fonte**: o listing da montagem dá o mapa linha ↔
  endereço; breakpoints do editor viram endereços (linha sem código vai
  para a próxima) e cada parada volta ao arquivo e à linha. Passo por cima
  e sair da função são uma parada por profundidade de chamadas no laço C.
- **VM fiel**: stdout, código de saída, mensagem de fault e o trace
  instrução a instrução são comparados com o `ksvm` nativo.

## Usar

Abra `dist/ksweb-single.html` com clique duplo (tudo num arquivo, ~1,4 MB:
os três wasm, o editor e os exemplos), ou sirva `dist/` como site estático
(`make serve` e <http://localhost:8000/>; serve também no GitHub Pages).

1. **Escreva** no editor (o projeto começa com um `main.ksasm`) ou abra um
   **Exemplo**. Os erros do `ksas` aparecem enquanto você digita e no
   painel **Problemas**; Ctrl+Espaço sugere instruções, registradores e
   rótulos; passar o mouse (ou Ctrl+K Ctrl+I no cursor) mostra a ficha da
   instrução, e a aba **Ajuda** da coluna direita acompanha o cursor com a
   ficha completa (semântica, flags, codificação, exemplo).
   **Referência da ISA** (Ctrl+Shift+H ou o botão ISA): todas as
   instruções com busca e filtros, mapa de opcodes, condições, pseudos,
   diretivas, registradores, flags, formatos, faults e syscalls.
2. **Montar** (Ctrl+B) gera a imagem, o listing (**Saída da montagem**) e o
   desassembly. **Executar** (F5) remonta se preciso e roda no
   **Terminal**.
3. **Depurar**: clique no gutter (ou F9) para breakpoints, F5 para rodar
   até eles, F10 passo por cima, F11 passo para dentro, Shift+F11 sai da
   função. A linha atual fica destacada; registradores, watch, pilha e
   memória à direita. F1 mostra todos os atalhos.
4. **Projetos**: vários arquivos com `.include`, explorador à esquerda
   (novo, renomear, excluir, duplicar, principal ★), salvos sozinhos no
   IndexedDB do navegador; **Exportar**/**Importar** `.zip`.
5. **Modo simples**: arraste um `.ksx` para a página e ele roda direto, com
   o desassembly no lugar do editor.

No terminal: modo linha (padrão; a linha é editada localmente e enviada no
Enter, Ctrl+D numa linha vazia é EOF) ou raw (Opções); Ctrl+Alt+C
interrompe. O código de saída segue o runner nativo: `exit & 0xFF`,
`70 + fault`, `124` no limite de instruções, `65` para imagem inválida.

A ISA tem um único console: stdout e stderr do guest saem pelo mesmo canal
(o grupo 3 de syscalls, arquivos, não existe no navegador: `ENOSYS`).

Detalhes: [docs/07-ide.md](docs/07-ide.md) (IDE),
[docs/05-depurador.md](docs/05-depurador.md),
[docs/06-terminal.md](docs/06-terminal.md).

## Construir

Requer clang com alvos wasm32 e wasm32-wasi, wasm-ld, a wasi-libc, GNU
make, gcc (oráculo nativo) e Node 18+. No ambiente deste repositório tudo
fica no WSL (`BUILD.md`):

    wsl.exe -e bash -lc 'cd /mnt/c/Users/isaque.kanitz/KSVM2/ksweb && make clean && make && make test && make dist'

| Alvo | O que faz |
|------|-----------|
| `make` | `build/ksvm.wasm`, `build/ksas.wasm`, `build/ksdis.wasm`, `build/web/isa.json`, ferramentas nativas da ksvm2 em `build/native/` e exemplos `.ksx` |
| `make test` | 342 casos em Node: wasm × `ksvm` nativo, `ksas`/`ksdis.wasm` × nativos, isa.json e fichas da ISA (exemplos montados), referência e ajuda ao cursor, mapa de linhas e linguagem do editor, projetos/IndexedDB/zip, terminal VT, editor de linha, formatadores, `dist/` e os dois workers |
| `make dist` | `dist/` (site estático) e `dist/ksweb-single.html` |
| `make serve` | `python3 -m http.server` em `dist/` (`PORT=8000`) |
| `make test-browser` | a IDE num Chrome/Edge headless (opcional; Node 22+) |
| `make clean` | apaga `build/` e `dist/` |

`KSVM2_HOME` (padrão `../ksvm2`) aponta a árvore da ksvm2; nada é copiado
nem escrito nela. O bundle do editor é commitado; `make` não usa npm
(`sh tools/build_editor.sh` o regenera, BUILD.md).

## Estrutura

```
src/            ksweb.c (API exportada), hal_web.c/.h (HAL do navegador),
                libc_min.c + include/string.h, ksvm_config_user.h
web/            index.html, style.css
                ksweb.js (controlador da IDE), editor.js (CodeMirror + ksasm),
                layout.js (splitters/painéis), debugger.js (coluna do depurador),
                terminal.js (VT no DOM)
                isaref.js (fichas, referência da ISA; parte pura testada em Node)
                sem DOM: ksasm-lang.js (tokenizer, autocomplete), asmtools.js
                (montagem, listing, mapa de linhas), project.js (projetos,
                IndexedDB, zip), wasi.js (shim WASI), vmcore.js, vt.js,
                input.js, format.js
                workers: worker.js (VM), asm-worker.js (ksas/ksdis)
web/vendor/     codemirror.bundle.js (CodeMirror 6 empacotado), LICENSES.md
examples/       vtdemo.ksasm, maiusculas.ksasm e menu.json (exemplos do menu)
tools/          mkexamples.js (examples.js com imagens e fontes), mksingle.js
                (arquivo único), isadump.c + mkisa.js + ksasm-extra.json +
                isa-doc.md (isa.json; isa-doc.md = fichas escritas do doc 04), build_editor.sh + editor/ (bundle do CodeMirror)
test/           run_node.js, test_wasm_tools.js, test_isa.js, test_isaref.js, test_asmtools.js,
                test_project.js, test_vt.js, test_format.js, test_lineedit.js,
                test_terminal.js, check_dist.js, browser_smoke.js;
                progs/*.ksasm (programas de regressão)
docs/           README e 01..07 (arquitetura, API, testes, roadmap,
                depurador, terminal, IDE)
```

## Licença

A ksvm2 não declara licença (não há arquivo `LICENSE` na árvore nem
cabeçalho de licença nos fontes). Por coerência o ksweb também não declara
uma: os direitos ficam com o autor do projeto até que KSVM2 escolha uma
licença, e o ksweb deve adotar a mesma. O CodeMirror vendorizado é MIT
(`web/vendor/LICENSES.md`).
