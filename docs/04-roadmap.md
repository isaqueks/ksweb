# 04 — Roadmap

## Feito (v1)

- Núcleo da ksvm2 em wasm freestanding, API exportada, HAL web com
  suspensão por entrada e SLEEP_MS por `setTimeout`.
- Página com worker, terminal VT100/xterm, modo linha/raw, exemplos
  embutidos, arquivo único para `file://`.
- Depurador: registradores, disassembly com breakpoints, pilha, memória,
  trace exportável, paradas em BRK/SYSCALL.
- Testes em Node contra o `ksvm` nativo e fumaça opcional em Chrome.

## Pendências

### `ksas` em wasm
Montar `.ksasm` na própria página (editor + "Montar e executar"). O
assembler é C99 com o mesmo estilo do núcleo, mas usa `stdio`/`malloc`
para ler fontes e `.include`: precisa de uma camada de E/S em memória
(arquivos virtuais) e de um `malloc` simples sobre a arena. A tabela da ISA
já está no módulo atual.

### `kscc` em wasm
Compilar C para `.ksx` no navegador (o kscc deriva do chibicc). Exige libc
maior que a do núcleo (`stdio`, `string`, `stdlib`, `ctype`), arquivos
virtuais para os headers da libks e o `ksas` acima para o passo de
montagem. Provavelmente um segundo módulo wasm, carregado sob demanda.

### Sistema de arquivos virtual (grupo 3)
`OPEN/CLOSE/READ/WRITE/SEEK` sobre um FS em memória (arquivos enviados pela
página, baixáveis no fim), com fd 0/1/2 pré-abertos. Daria também um canal
de stderr separado (`WRITE` no fd 2), que hoje não existe: stdout e stderr
saem pelo mesmo console. Persistência opcional em IndexedDB.

### Depurador
- Breakpoints condicionais (`r1 == 5`), contagem de passagens, watchpoints
  de memória (o barramento já centraliza os acessos; exigiria um hook no
  núcleo ou uma região espelho).
- Step over/step out (CALL/RET), pilha de chamadas a partir do `fp`.
- Edição de registradores e memória (hoje o hexdump é só leitura).
- Disassembly com nomes de símbolos nos alvos (como o `ksdis`) e listagem
  com o fonte quando o `.ksx` tiver informação de linha.
- Exportar/importar breakpoints; histórico do trace além de 65536 registros.

### Terminal e página
- IME/composição e teclado virtual de celular (a entrada hoje é por
  `keydown` num `<div>`; um `<textarea>` oculto resolveria).
- Reflow do texto ao redimensionar; seleção em modo retangular; busca no
  histórico.
- Relatar o tamanho do terminal ao guest (não há syscall para isso).
- Modo "poll inteligente": suspender só quando o guest gira em GETC sem
  fazer mais nada, para programas que leem teclado sem bloquear.

### Infra
- Rodar `browser_smoke.js` também com Firefox (WebDriver BiDi) e WebKit.
- Publicar `dist/` no GitHub Pages por CI.
