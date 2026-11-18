# ksweb — a KSVM v2 no navegador

A máquina virtual [KSVM v2](../ksvm2/README.md) compilada para WebAssembly,
com uma página que executa imagens `.ksx`: terminal VT100/xterm de verdade
(cores, cursor, caixas DEC, tela alternativa), entrada pelo teclado com eco
local ou modo raw, e um depurador (registradores, disassembly com
breakpoints, pilha, memória em hex, trace). Funciona offline, sem
dependências nem CDN, em Chrome, Firefox e Safari atuais.

- O núcleo é o mesmo `ksvm2/src/core/*.c`, compilado direto da árvore da
  ksvm2 com `clang --target=wasm32`, sem Emscripten e sem libc
  (`build/ksvm.wasm`, ~47 KB).
- A VM roda num Web Worker em fatias de instruções; a página nunca congela.
- Sem entrada disponível, `GETC`/`GETS` suspendem a VM até chegar uma tecla
  (nada gira na CPU); `SLEEP_MS` vira um `setTimeout`.
- O resultado é idêntico ao `ksvm` nativo: os testes comparam stdout,
  código de saída, mensagem de fault e o trace instrução a instrução.

## Usar

Abra `dist/ksweb-single.html` com clique duplo (tudo num arquivo, inclusive
o wasm e os exemplos), ou sirva `dist/` como site estático (`make serve` e
<http://localhost:8000/>; serve também no GitHub Pages).

1. Carregue um `.ksx`: botão **Abrir .ksx**, arrastar e soltar na página,
   ou o menu **Exemplos** (hello, demo VT100, ponto flutuante, leitura de
   stdin, fib, crivo...).
2. **Executar** (F8) roda; **Parar** (Ctrl+Alt+C) pausa; **Reiniciar**
   recarrega; **Passo** (F10) executa uma instrução e mostra pc, instrução e
   registradores.
3. Digite no terminal: no modo linha (padrão) a linha é editada localmente
   e enviada no Enter com `\n`; Ctrl+D numa linha vazia é EOF; Ctrl+C envia
   0x03 ao programa. Em **Opções**: modo raw (cada tecla vai direto, Enter =
   `\r`), Backspace DEL/BS, stdin não bloqueante (poll), RAM, pilha, limite
   de instruções, instruções por fatia, tamanho do terminal. **Arquivo →
   stdin** entrega um arquivo como entrada.
4. **Depurador** abre o painel lateral (docs/05-depurador.md).

Mensagens do ksweb (carga, cabeçalho, fim, fault) aparecem no terminal com o
prefixo `[ksweb]` e cor própria, separadas da saída do programa. O código de
saída segue o runner nativo: `exit & 0xFF`, `70 + fault`
(`fault: NOME at pc=0x... addr=0x...`), `124` no limite de instruções, `65`
para imagem inválida.

A ISA tem um único console: stdout e stderr do guest (inclusive o `stderr`
da libks do kscc, que usa `PUTC`) saem pelo mesmo canal. Só a syscall
`WRITE` com fd 2 distinguiria stderr, e ela é do grupo 3 (arquivos), que não
existe no navegador (`ENOSYS`).

## Construir

Requer clang com alvo wasm32, wasm-ld, GNU make, gcc (oráculo nativo) e Node
18+. No ambiente deste repositório tudo fica no WSL (`BUILD.md`):

    wsl.exe -e bash -lc 'cd /mnt/c/Users/isaque.kanitz/KSVM2/ksweb && make && make test && make dist'

| Alvo | O que faz |
|------|-----------|
| `make` | `build/ksvm.wasm`, ferramentas nativas da ksvm2 em `build/native/` e exemplos `.ksx` |
| `make test` | testes em Node: wasm × `ksvm` nativo, terminal VT, editor de linha, formatadores, `dist/` e worker |
| `make dist` | `dist/` (site estático) e `dist/ksweb-single.html` |
| `make serve` | `python3 -m http.server` em `dist/` (`PORT=8000`) |
| `make test-browser` | fumaça num Chrome/Edge headless (opcional; Node 22+) |
| `make clean` | apaga `build/` e `dist/` |

`KSVM2_HOME` (padrão `../ksvm2`) aponta a árvore da ksvm2; nada é copiado
nem escrito nela.

## Estrutura

```
src/            ksweb.c (API exportada), hal_web.c/.h (HAL do navegador),
                libc_min.c + include/string.h (memcpy/memset), ksvm_config_user.h
web/            index.html, style.css, ksweb.js (controlador), worker.js,
                vmcore.js (invólucro do wasm, sem DOM), vt.js (emulador VT puro),
                terminal.js (VT no DOM), input.js (teclado/editor de linha),
                format.js (formatadores puros), debugger.js (painel)
examples/       vtdemo.ksasm, maiusculas.ksasm e menu.json (exemplos do menu)
tools/          mkexamples.js (examples.js com base64), mksingle.js (arquivo único)
test/           run_node.js, test_vt.js, test_format.js, test_lineedit.js,
                check_dist.js, browser_smoke.js
docs/           README e 01..06 (arquitetura, API, testes, roadmap, depurador, terminal)
```

## Licença

A ksvm2 não declara licença (não há arquivo `LICENSE` na árvore nem
cabeçalho de licença nos fontes). Por coerência o ksweb também não declara
uma: os direitos ficam com o autor do projeto até que KSVM2 escolha uma
licença, e o ksweb deve adotar a mesma.
