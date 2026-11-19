# ksweb — documentação

O ksweb é uma IDE da KSVM v2 no navegador: editor de assembly, montagem com
o `ksas` em WebAssembly, a VM em WebAssembly com terminal VT100 e depuração
no código-fonte. Visão geral, uso e build: [`../README.md`](../README.md) e
[`../BUILD.md`](../BUILD.md).

| Documento | Conteúdo |
|-----------|----------|
| [01-arquitetura.md](01-arquitetura.md) | os módulos wasm (VM freestanding e ksas/ksdis em WASI), shim WASI, os dois workers e seus protocolos, HAL web, suspensão por stdin, mapa linha ↔ endereço, `isa.json`, distribuição |
| [02-api.md](02-api.md) | exports e imports do `ksvm.wasm`; `vmcore.js` (KsCore/KsSession); `wasi.js`, `asmtools.js`, `ksasm-lang.js`, `project.js` |
| [03-testes.md](03-testes.md) | o que cada teste cobre e como rodar |
| [04-roadmap.md](04-roadmap.md) | feito e pendências: kscc no navegador, FS virtual, depurador avançado |
| [05-depurador.md](05-depurador.md) | depurador: breakpoints, passos, registradores, watch, pilha, memória, trace, desassembly |
| [06-terminal.md](06-terminal.md) | emulador VT100/xterm: sequências suportadas, teclado, UTF-8 |
| [07-ide.md](07-ide.md) | a IDE: uso, atalhos, autocomplete, projetos e persistência, limites |

## Uso rápido

- **Abrir**: `dist/ksweb-single.html` com clique duplo, ou `make serve` e
  <http://localhost:8000/>. `dist/index.html` aberto por `file://` não
  funciona em todos os navegadores (o Chrome bloqueia `fetch` do wasm e os
  Workers em `file://`); a página avisa e indica o arquivo único.
- **Escrever e montar**: o editor abre com um `main.ksasm`; os erros
  aparecem enquanto se digita; Ctrl+B monta (listing e desassembly nos
  painéis de baixo).
- **Executar / depurar**: F5 executa (remonta se preciso); F9 ou clique no
  gutter marca breakpoint; F10/F11/Shift+F11 avançam; o depurador fica à
  direita. F1 lista os atalhos.
- **Entrada**: digitar no terminal (modo linha com eco local ou raw),
  colar, **EOF**, **Arquivo → stdin**.
- **Modo simples**: arrastar um `.ksx` para a página executa direto.
- **Fim**: `[ksweb] fim: código de saída N · M instruções`; em fault a
  mensagem igual à do runner (`fault: MEM_RANGE at pc=0x00000008
  addr=0x80000000`) e a linha culpada destacada.

## Exemplos embutidos

O seletor **Exemplos** abre o fonte de cada um como projeto (com o
`lib/io.ksasm` que ele inclui) e o executa: `hello`, `vtdemo` (caixa DEC,
cores, cursor, barra animada com `SLEEP_MS`), `float` (extensão F),
`maiusculas` (lê stdin até EOF), `ask_name` (GETS), `fib`, `sieve`,
`recursion`, `bitops`, `jumptable`, `strlen`. A lista e os títulos ficam em
`examples/menu.json`; todos os `.ksx` montados também vão para
`dist/examples/`.
