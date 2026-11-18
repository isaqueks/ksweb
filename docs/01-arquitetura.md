# 01 — Arquitetura

```
 thread principal (página)                      Web Worker
┌──────────────────────────────┐   mensagens   ┌──────────────────────────────┐
│ ksweb.js   controles, carga  │ ────────────► │ worker.js  laço de fatias    │
│ terminal.js  VtScreen → DOM  │ ◄──────────── │ vmcore.js  KsCore/KsSession  │
│ vt.js      parser + grade    │               │   │ exports/imports           │
│ input.js   teclado → bytes   │               │ ┌─▼──────────────────────────┐ │
│ debugger.js painel           │               │ │ ksvm.wasm                  │ │
│ format.js  formatadores      │               │ │  ksweb.c   API exportada   │ │
└──────────────────────────────┘               │ │  hal_web.c HAL do browser  │ │
                                               │ │  ksvm2/src/core/*.c        │ │
                                               │ └────────────────────────────┘ │
                                               └──────────────────────────────┘
```

## 1. O módulo wasm

- **Fontes**: `ksvm2/src/core/*.c` compilados direto da árvore da ksvm2
  (`KSVM2_HOME`), mais `src/ksweb.c`, `src/hal_web.c` e `src/libc_min.c`.
  `clang --target=wasm32 -O2 -ffreestanding -nostdlib`, `wasm-ld --no-entry`.
  Sem Emscripten, sem libc, sem WASI: o módulo importa só três funções do
  JS e exporta a memória e a API.
- **Configuração** (`src/ksvm_config_user.h`, via `KSVM_HAVE_USER_CONFIG`):
  `KSVM_ENABLE_TRACE=1`, `MULDIV=1`, `BITOPS=1`, `FLOAT=1`, `SYSCALL_FS=0`,
  `DISASM=1`. Núcleo e `ksweb.c` veem a mesma config (o trace muda o layout
  de `struct ksvm`). `CAPS(0x4000)` responde `0x7`.
- **libc**: o núcleo só precisa de `memcpy/memset`; o `string.h` de
  `src/include/` os declara (mais `memmove/memcmp`, que o clang pode gerar).
  `-ffreestanding` implica `-fno-builtin`, então os laços de `libc_min.c` não
  viram chamadas recursivas a `memcpy`.
- **Memória**: uma instância estática de `ksvm`. A RAM do guest e o buffer da
  imagem saem de uma arena (bump allocator) acima de `__heap_base`, crescida
  com `memory.grow`; `ksweb_init` esvazia a arena, então reiniciar não vaza.
  RAM de 1 byte a 64 MiB (`KSWEB_MAX_RAM`); a página oferece 64 KiB a 64 MiB.
  A região CODE aponta para dentro do buffer da imagem (sem cópia), como no
  runner nativo. O anel de trace (65536 × 16 B) e o anel de entrada (64 KiB)
  são estáticos (`.bss`, não ocupam o arquivo).
- **Tamanho**: `ksvm.wasm` tem ~47 KB (o núcleo inteiro, soft-float e
  disassembler inclusos).

## 2. HAL web (`src/hal_web.c`)

| Membro | Implementação |
|--------|---------------|
| `putc` | import `js_putc(c)`; `vmcore.js` acumula os bytes e o worker os envia à página uma vez por rodada |
| `getc` | lê do anel alimentado por `ksweb_feed`/`ksweb_feed_input`; sem dado, ver §3 |
| `millis` | import `js_millis()` = `performance.now()` desde o boot da VM (`KsCore.init`, a cada carga), como o `hal_posix` |
| `sleep_ms` | não dorme: guarda o prazo e põe a VM em `KSVM_YIELD`; o worker retoma depois de `setTimeout(prazo)` |
| `syscall` | `MICROS` (0x22) por `js_micros()`; grupo 3 (arquivos), GPIO e números de usuário: `KSVM_SYS_UNKNOWN` (`r2 = ENOSYS`) |
| `on_halt` | registra o código de saída |

## 3. Suspensão por falta de entrada

O núcleo não tem `getc` bloqueante e o wasm não pode esperar dentro de uma
chamada (isso exigiria `SharedArrayBuffer` + `Atomics.wait`, que dependem
dos cabeçalhos COOP/COEP — indisponíveis em `file://` e no GitHub Pages). Em
vez de deixar o guest girar num laço de `GETC`, a HAL trata cada syscall de
entrada como uma transação:

1. no primeiro `getc` de uma syscall, guarda `pc`, `insn_count`, `r1` e `r2`
   (durante a execução de `SYSCALL` o núcleo ainda não avançou `pc` nem
   `insn_count`, o que identifica a syscall);
2. se o anel esvazia antes de a syscall terminar, marca `want_input` e põe
   a VM em `KSVM_YIELD` (o `ksvm_run` sai depois desta instrução);
3. `ksweb_run` chama `ksweb_hal_rewind`, que restaura `pc`, `insn_count`,
   `r1` e `r2`, tira a instrução do trace e devolve `KSWEB_WAIT_INPUT`.

Quando a página entrega entrada (ou EOF), o worker retoma e a mesma
`SYSCALL` executa do zero. Para o guest isso é exatamente um `read(2)`
bloqueante — o comportamento do `ksvm` nativo com stdin redirecionado —,
inclusive para `GETS` com uma linha que chega aos pedaços. Enquanto espera,
nenhuma instrução executa.

Os bytes que a `GETS` desfeita já tinha copiado para o buffer do guest
(`r1 + 0..n-1`) saem do anel: a repetição da syscall (mesmos `pc`,
`insn_count` e `r1`) os relê do próprio buffer, um a um, antes de regravá-los
no mesmo lugar — nenhuma instrução do guest executa entre o desfazer e a
repetição. Assim uma linha sem `\n` maior que o anel de 64 KiB não o entope.
Quando a syscall esvazia o anel e ainda há entrada na fila do `KsSession`,
`tick` entrega mais e continua, sem esperar outra mensagem da página.

Com **stdin não bloqueante (poll)** a HAL devolve `KSVM_HAL_NODATA` ao guest
(`r1 = -1`, `r2 = AGAIN`), como `ksvm --stdin-poll`; o programa decide se
cede (`YIELD`) ou gira. Depois de EOF e com o anel vazio, `getc` devolve
`KSVM_HAL_EOF` (como o runner com stdin de arquivo); Reiniciar zera isso.
Diferença conhecida: entrada que chega depois do EOF ainda é entregue (como
num tty), enquanto o `hal_posix` nativo trata o EOF como definitivo.

## 4. Worker e protocolo de mensagens

O worker tem a única instância do wasm. Uma rodada do laço executa fatias de
`slice` instruções (`ksweb_run(200000)` por padrão, ajustável em Opções)
até ~12 ms e depois cede o thread com um `MessageChannel` (sem o atraso
mínimo de 4 ms do `setTimeout` aninhado), o que deixa as mensagens da página
(Parar, entrada, depurador) serem atendidas entre rodadas.

| Resultado da fatia | O que o worker faz |
|--------------------|--------------------|
| `RUNNING` | próxima rodada imediatamente |
| `YIELD` / `SLEEP_MS` | `setTimeout(max(1, prazo))` — o YIELD puro espera 1 ms, como o runner nativo |
| `WAIT_INPUT` | para; retoma ao receber `input`/`eof` |
| `BREAK` | para e envia `snapshot` |
| `HALT` / `FAULT` / limite | `status: done` com o código e a mensagem do runner, e `snapshot` |

Página → worker:

| Mensagem | Campos | Efeito |
|----------|--------|--------|
| `init` | `wasm` (ArrayBuffer) | instancia o módulo → `ready` |
| `load` | `image`, `opts {ramSize, stackSize, maxInsns, slice, stdinBlock}` | `ksweb_init` + `ksweb_load` → `loaded` |
| `run` | `slice?` | começa/continua |
| `pause` | — | para e envia `snapshot` |
| `step` | `n` | 1 instrução (`ksweb_step`, → `stepped`) ou `ksweb_run(n)` |
| `input` | `bytes` | entrega ao anel (o excesso fica numa fila no worker) |
| `eof` | — | EOF depois do que estiver na fila |
| `config` | `slice?`, `stdinBlock?`, `budgetMs?` | ajustes durante a execução |
| `debug` | `debug {on, bps, stopBrk, stopSyscall, traceN}` | depurador (05-depurador.md) |
| `snapshot` | — | pede o retrato do estado |
| `mem` | `addr`, `len`, `id` | lê memória do guest → `mem` |
| `trace-export` | — | → `trace-text` |

Worker → página: `ready {version}`, `loaded {ok, header, regions | info}`,
`output {bytes}`, `status {state, insns, pc, reason?, info?, cpu?}` (estados
`ready running sleeping waiting paused break done`), `progress {insns,
ips}` (no máximo a cada 250 ms), `snapshot {cpu, window, stack, fault,
trace, traceTotal, insns, bps}`, `stepped {pc, text, len, cpu}`,
`mem {id, addr, bytes, mask}`, `trace-text {text, total, count}`.

Os contadores de instruções no JS somam as diferenças de `insn_count` a cada
fatia, então não dão a volta em 2³² como o contador de 32 bits do núcleo.

## 5. Limite de instruções e términos

`KsSession` (`vmcore.js`) reproduz o laço de `ksvm_main.c`: antes de cada
fatia, se o limite (`maxInsns`) foi atingido, termina com 124 e
`limite de N instruções atingido (pc=0x...)`; a fatia é cortada para não
passar do limite. Códigos: `exit & 0xFF` no HALT/EXIT, `70 + fault` com
`fault: NOME at pc=0x%08X addr=0x%08X`, 124 no limite, 65 para imagem
inválida (`imagem inválida: IMAGE_CHECKSUM`...), 69 sem memória, 64 para
tamanho de RAM inválido.

## 6. Página

- `ksweb.js` liga controles, arquivo/arrastar, exemplos, opções, terminal e
  depurador; obtém o wasm por `fetch('ksvm.wasm')` ou de
  `KSWEB_WASM_B64` (arquivo único) e o envia ao worker.
- `terminal.js` desenha a `VtScreen` (06-terminal.md): uma `<div>` por linha
  da tela, redesenhada só quando suja (no próximo `requestAnimationFrame`),
  e as linhas que rolam para fora viram `<div>` estáticas do histórico
  (5000 linhas). Mensagens do runner entram na mesma grade com um atributo
  próprio (`[ksweb]`, cor e itálico), sem herdar as cores do guest.
- Tema claro/escuro por `prefers-color-scheme` (variáveis CSS, inclusive a
  paleta ANSI de 16 cores). Sem dependências externas.

## 7. Distribuição

`make dist` copia `web/`, `ksvm.wasm`, `examples.js` e os `.ksx` para
`dist/` (site estático; GitHub Pages serve como está) e gera
`dist/ksweb-single.html` com `tools/mksingle.js`: CSS e scripts inline, o
wasm em base64 (`window.KSWEB_WASM_B64`) e o código do worker
(`vmcore.js + format.js + worker.js`) num
`<script type="text/js-worker">` que vira `Blob` + `new Worker(URL)`. Assim
abre por `file://` com clique duplo, sem `fetch`.
