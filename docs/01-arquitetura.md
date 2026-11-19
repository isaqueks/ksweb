# 01 — Arquitetura

```
 thread principal (página)                          Web Worker da VM
┌─────────────────────────────────────┐ mensagens ┌──────────────────────────────┐
│ ksweb.js    controlador da IDE      │ ────────► │ worker.js  laço de fatias    │
│ editor.js   CodeMirror 6 + ksasm    │ ◄──────── │ vmcore.js  KsCore/KsSession  │
│ ksasm-lang.js tokenizer, completar  │           │ ┌──────────────────────────┐ │
│ layout.js   splitters e painéis     │           │ │ ksvm.wasm                │ │
│ project.js  projeto, IndexedDB, zip │           │ │  ksweb.c   API exportada │ │
│ asmtools.js listing, mapa de linhas │           │ │  hal_web.c HAL           │ │
│ debugger.js painel do depurador     │           │ │  ksvm2/src/core/*.c      │ │
│ terminal.js + vt.js + input.js      │           │ └──────────────────────────┘ │
│ format.js   formatadores            │           └──────────────────────────────┘
│ vendor/codemirror.bundle.js         │              Web Worker do assembler
│ isa.js, examples.js (gerados)       │ mensagens ┌──────────────────────────────┐
└─────────────────────────────────────┘ ────────► │ asm-worker.js                │
                                        ◄──────── │ asmtools.js  ksasm-lang.js   │
                                                  │ wasi.js (shim WASI, FS em    │
                                                  │ memória)                     │
                                                  │ ┌───────────┐ ┌────────────┐ │
                                                  │ │ ksas.wasm │ │ ksdis.wasm │ │
                                                  │ └───────────┘ └────────────┘ │
                                                  └──────────────────────────────┘
```

Dois tipos de módulo: o **ksvm.wasm** é o núcleo da ksvm2 freestanding
(sem libc, API própria, §1–§5); o **ksas.wasm** e o **ksdis.wasm** são as
ferramentas de linha de comando da ksvm2 compiladas como comandos WASI com
a wasi-libc e rodadas por um shim próprio (§7). Cada um vive no seu worker:
o lint e a montagem não disputam o thread com a VM nem com a digitação.

## 1. O módulo wasm da VM

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
  runner nativo. O anel de trace (65536 × 16 B), os retratos de
  registradores dos BRKs (32769 × 144 B, um por BRK que cabe no anel) e o
  anel de entrada (64 KiB) são estáticos (`.bss`, não ocupam o arquivo).
- **Depurador**: tabela de breakpoints, paradas por opcode (BRK/SYSCALL) e a
  **parada por profundidade de chamadas** (passo por cima/sair da função,
  `ksweb_frame_stop`, 02-api.md): com qualquer uma ativa, `ksweb_run` executa
  instrução a instrução; sem elas é o `ksvm_run` direto.
- **Tamanho**: `ksvm.wasm` tem ~48 KB (o núcleo inteiro, soft-float e
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

## 4. Worker da VM e protocolo de mensagens

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
| `BREAK` | para e envia `snapshot`; se não foi o fim de um passo, desarma a parada por profundidade |
| `HALT` / `FAULT` / limite | `status: done` com o código e a mensagem do runner, e `snapshot` |

Página → worker:

| Mensagem | Campos | Efeito |
|----------|--------|--------|
| `init` | `wasm` (ArrayBuffer) | instancia o módulo → `ready` (ou `fatal`); mensagens que chegam antes do `ready` ficam numa fila e são atendidas depois dele |
| `load` | `image`, `opts {ramSize, stackSize, maxInsns, slice, stdinBlock}` | `ksweb_init` + `ksweb_load` → `loaded` |
| `run` | `slice?` | começa/continua; ignorado se a VM já está andando (inclusive esperando entrada ou o prazo de um `SLEEP_MS`) |
| `pause` | — | para (desarma o passo em curso) e envia `snapshot` |
| `step` | `n`, `mode?` | sem `mode` ou `into`: 1 instrução (`ksweb_step`, → `stepped`) ou `ksweb_run(n)`; `over` num CALL/CALLR e `out`: `ksweb_frame_stop(0 ou -1)` e a VM anda em fatias até `break` com `reason: 'step'`; `over` numa instrução comum = 1 passo |
| `input` | `bytes` | entrega ao anel (o excesso fica numa fila no worker) |
| `eof` | — | EOF depois do que estiver na fila |
| `config` | `slice?`, `stdinBlock?`, `budgetMs?` | ajustes durante a execução |
| `debug` | `debug {on, bps, stopBrk, stopSyscall, traceN}` | depurador (05-depurador.md) |
| `snapshot` | — | pede o retrato do estado |
| `mem` | `addr`, `len`, `id` | lê memória do guest → `mem` |
| `trace-export` | — | → `trace-text` |

Worker → página: `ready {version}`, `fatal {message}`, `loaded {ok, header, regions | info}`,
`output {bytes}`, `status {state, insns, pc, reason?, info?, cpu?, stepping?}`
(estados `ready running sleeping waiting paused break done`; `reason` em
`breakpoint BRK syscall step`), `progress {insns, ips}` (no máximo a cada
250 ms), `snapshot {cpu, window, stack, fault, trace, traceTotal, insns,
bps}`, `stepped {pc, text, len, cpu}`, `mem {id, addr, bytes, mask}`,
`trace-text {text, total, count}`. O handler de mensagens é síncrono: uma
exceção chega à página como o evento `error` do `Worker`.

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

## 6. Página (IDE)

- `ksweb.js` é o controlador: carrega os três `.wasm` (`fetch` ou os base64
  do arquivo único), cria os dois workers, liga barra, explorador, abas,
  painéis, terminal e depurador, e coordena montagem, lint, execução e
  depuração (07-ide.md). `window.ksweb` expõe o estado e algumas ações (o
  teste de navegador usa; `ksweb.state.events` guarda os últimos eventos
  para depurar a própria IDE).
- `editor.js` (`KsEditor`): uma `EditorView` do CodeMirror 6 e um
  `EditorState` por arquivo (desfazer, breakpoints e marcas por arquivo).
  Três `StateField`s próprios — breakpoints, linha atual da depuração e
  linhas com código — mapeados pelas edições (a marca acompanha a linha) e
  desenhados num gutter próprio; erros pelo `setDiagnostics` do
  `@codemirror/lint`; realce por um `StreamLanguage` com o tokenizer de
  `ksasm-lang.js`; autocomplete e ajuda pelas funções puras dele.
- `ksasm-lang.js` (sem DOM, testado em Node): tokenizer no formato do
  `StreamParser` (regras léxicas do `lexer.c` do ksas), rótulos do arquivo,
  contexto e opções de autocomplete, palavra sob o cursor e texto de ajuda,
  a partir do `isa.json`.
- `asmtools.js` (sem DOM): monta pelo shim, interpreta erros, listing e
  desassembly, e constrói o **mapa linha ↔ endereço** (§7).
- `project.js` (sem DOM): modelo do projeto, `ProjectStore` (IndexedDB →
  localStorage → memória) e `.zip` sem dependências.
- `layout.js`: splitters (mouse, toque, setas), painéis recolhíveis e abas
  do painel inferior, com estado no localStorage.
- `debugger.js`: coluna direita (registradores, watch, breakpoints, pilha,
  memória, trace). O disassembly em volta do pc saiu daqui: o painel
  inferior mostra o `ksdis` inteiro da imagem, com o pc destacado.
- `terminal.js` desenha a `VtScreen` (06-terminal.md) no painel Terminal.
- Tema claro/escuro por `prefers-color-scheme` (variáveis CSS, inclusive o
  realce do editor e a paleta ANSI). Nenhuma dependência externa além do
  CodeMirror vendorizado.

### Depuração em nível de fonte

O `ksas` não grava informação de linha no `.ksx`: o mapa vem do listing da
mesma montagem (`-l`), guardado junto com a imagem. Breakpoints do editor
são `(arquivo, linha)`; antes de ir para o worker viram endereços pelo mapa
(`AsmTools.resolveBreakpoint`: a linha, ou a próxima linha com instrução
do mesmo arquivo — e a marca no editor muda para lá). A cada parada o
worker manda o `snapshot`; o `pc` volta a `(arquivo, linha)` pelo mesmo
mapa e a IDE abre a aba e destaca a linha. Passo por cima e sair da função
são paradas por profundidade de chamadas no laço C (02-api.md,
`ksweb_frame_stop`). Editar o fonte depois da montagem marca a imagem como
desatualizada (um contador de versão do projeto); Executar remonta.

## 7. Assembler no navegador

- **Build**: `ksvm2/src/tools/ksas/*.c` e `ksvm2/src/tools/ksdis/*.c` +
  `toolio.c`, com o núcleo, compilados por `clang --target=wasm32-wasi` com
  os headers e a `libc.a` da wasi-libc e ligados com `crt1-command.o`
  (BUILD.md). Nenhum fonte da ksvm2 é alterado nem precisa de `#define`: o
  `ksas` já separa a E/S (`main.c`) do montador e usa só `stdio`/`malloc`;
  `strtof` (literais float) vem da wasi-libc (musl), envolvido por
  `src/wasi_strtof.c` (`--wrap=strtof`) porque o da musl ignora o sinal de
  `-nan`. Como no Makefile da
  ksvm2, o `ksas` usa a config padrão do núcleo e o `ksdis` a das
  ferramentas (trace e grupo 3 ligados). ~100 KB e ~70 KB.
- **Shim WASI** (`wasi.js`, sem dependências): `runWasi(módulo, {args,
  files, env, stdin})` instancia o comando, roda `_start` de forma síncrona
  e devolve `{exitCode, stdout, stderr, files}`. FS em memória (`Map`
  caminho → bytes) com dois diretórios pré-abertos (`/` e `.`, a mesma
  raiz), `path_open` com criar/truncar/exclusivo, leitura/escrita/seek,
  `path_unlink_file` (o `ksas` apaga o listing quando falha), diretórios
  implícitos pelos caminhos; `proc_exit` vira exceção; um import sem
  implementação devolve `ENOSYS`. O módulo compilado é reaproveitado
  (`compileWasi`); cada montagem é uma instância nova (~1–5 ms).
- **Montagem** (`AsmTools.assemble`): `ksas MAIN -o .ksweb.ksx -l
  .ksweb.lst -g` com os arquivos do projeto no FS; o resultado traz a
  imagem, os diagnósticos (`arquivo:linha:coluna: erro: ...`; a coluna, em
  bytes UTF-8, é convertida para caracteres), o listing e o mapa.
- **Mapa linha ↔ endereço**: o listing tem uma linha por linha de fonte
  (`ENDERECO BYTES LINHA FONTE`) e `; arquivo X` a cada troca de arquivo
  (`.include`); uma linha "gera código" quando tem bytes e o comando é
  instrução (não diretiva de dados). Daí `code` (arquivo → linhas com
  instrução), `addrLine` (endereço → arquivo/linha) e os símbolos (o listing
  lista todos, com seção; a linha de definição sai das linhas de rótulo).
- **Worker** (`asm-worker.js`): `init {ksas, ksdis, isa}` → `ready`;
  `assemble {id, files, main, debug, defines?}` → `assembled {id, result}`
  (os `Map`s passam pelo structured clone; a imagem é transferida);
  `disassemble {id, image}` → `disassembled {id, ok, text, rows}`.
  Mensagens antes do `ready` esperam numa fila.

## 8. `isa.json`

Gerado no build: `tools/isadump` (C nativo, ligado aos fontes do `ksas`)
despeja cada `KSVM_OP` do `isa.def` (X-macro: nome, opcode, formato,
flags, descrição) com a forma dos operandos, o tipo de imediato e as
variantes que o próprio assembler usa (`ksas_op_shape`, `ksas_op_imm_kind`,
`ksas_op_suffixed`, `ksas_op_long_form`) e os nomes de condição;
`tools/mkisa.js` junta as pseudo-instruções, diretivas, condições, apelidos
e descrições de `tools/ksasm-extra.json` (doc 07 da KSVM) e os números de
syscall do `syscall.h`, e grava `build/web/isa.json` e `isa.js` (o mesmo
objeto num script, para `file://`). Campos por instrução: `mnemonic opcode
format len flags shape imm operands signature desc flagsText snippet` e
`long`/`immForm`/`indexed` quando existem; listas `branches pseudos
directives registers syscalls specialRegs conds`. `test_isa.js` confere a
cobertura contra as fontes.

## 9. Distribuição

`make dist` copia `web/` (com `vendor/`), os três `.wasm`, `examples.js`,
`isa.json`/`isa.js` e os `.ksx` para `dist/` (site estático; o GitHub Pages
serve como está) e gera `dist/ksweb-single.html` com `tools/mksingle.js`:
CSS e scripts inline (inclusive o CodeMirror), os wasm em base64
(`KSWEB_WASM_B64`, `KSWEB_KSAS_B64`, `KSWEB_KSDIS_B64`) e o código dos dois
workers em `<script type="text/js-worker">` (`ksweb-worker-src`: vmcore +
format + worker; `ksweb-asm-worker-src`: wasi + ksasm-lang + asmtools +
asm-worker) que viram `Blob` + `new Worker(URL)`. Abre por `file://` com
clique duplo, sem `fetch`. O `examples.js` leva, para cada exemplo, a imagem
`.ksx` e o fonte com os arquivos que ele inclui.
