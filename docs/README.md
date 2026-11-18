# ksweb — documentação

O ksweb é a KSVM v2 em WebAssembly com uma página de terminal e depurador.
Visão geral, uso e build: [`../README.md`](../README.md) e
[`../BUILD.md`](../BUILD.md).

| Documento | Conteúdo |
|-----------|----------|
| [01-arquitetura.md](01-arquitetura.md) | wasm freestanding, HAL web, worker, protocolo de mensagens, suspensão por stdin, fatias, distribuição |
| [02-api.md](02-api.md) | exports e imports do `ksvm.wasm`; `vmcore.js` (KsCore/KsSession) |
| [03-testes.md](03-testes.md) | o que cada teste cobre e como rodar |
| [04-roadmap.md](04-roadmap.md) | pendências: ksas/kscc em wasm, FS virtual, depurador avançado |
| [05-depurador.md](05-depurador.md) | painel do depurador: registradores, disassembly, breakpoints, memória, pilha, trace |
| [06-terminal.md](06-terminal.md) | emulador VT100/xterm: sequências suportadas, teclado, UTF-8 |

## Uso rápido

- **Abrir**: `dist/ksweb-single.html` com clique duplo, ou `make serve` e
  <http://localhost:8000/>. `dist/index.html` aberto por `file://` não
  funciona em todos os navegadores (o Chrome bloqueia `fetch` do wasm e o
  Worker em `file://`); a página avisa e indica o arquivo único.
- **Carregar**: botão, arrastar e soltar, ou menu de exemplos. Ao carregar,
  o terminal mostra o cabeçalho da imagem (entry, tamanhos, pilha, flags,
  layout da RAM, checksum).
- **Executar / Parar / Reiniciar / Passo**: F8 / Ctrl+Alt+C / botão / F10.
- **Entrada**: digitar no terminal (modo linha com eco local ou raw),
  colar, **EOF**, **Arquivo → stdin**.
- **Fim**: `[ksweb] fim: código de saída N · M instruções`; em fault a
  mensagem igual à do runner (`fault: MEM_RANGE at pc=0x00000008
  addr=0x80000000`) e, por padrão, o depurador abre na instrução culpada.

## Exemplos embutidos

Montados no `make` pelo `ksas` nativo e embutidos em `examples.js`
(base64): `hello`, `vtdemo` (caixa DEC, cores, cursor, barra animada com
`SLEEP_MS`), `float` (extensão F), `maiusculas` (lê stdin até EOF),
`ask_name` (GETS), `fib`, `sieve`, `recursion`, `bitops`, `jumptable`,
`strlen`. A lista e os títulos ficam em `examples/menu.json`; todos os
`.ksx` montados também vão para `dist/examples/`.
