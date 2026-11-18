# 02 — API do `ksvm.wasm`

Declarações em `src/ksweb.h`, implementação em `src/ksweb.c`. Todos os
valores são `i32` do wasm (interpretados como `uint32_t` salvo indicação);
ponteiros são endereços na memória linear exportada (`memory`). Uma única
VM por instância do módulo. O invólucro JS (`web/vmcore.js`, §4) cuida de
copiar dados e ler strings.

## 1. Imports (módulo `env`)

| Import | Assinatura | Uso |
|--------|------------|-----|
| `js_putc` | `(c: u32) → void` | um byte de saída do guest (PUTC/PUTS/stderr da libks) |
| `js_millis` | `() → u32` | ms desde o último `KsCore.init` (o "boot" da VM; `performance.now()`), syscall `MILLIS` |
| `js_micros` | `() → u32` | µs, syscall `MICROS` (0x22) |

## 2. Estados e códigos

`ksweb_run`/`ksweb_step` devolvem:

| Valor | Nome | Significado |
|------:|------|-------------|
| 0 | `RUNNING` | a fatia de `max_insns` acabou; chame de novo |
| 1 | `HALT` | HALT/EXIT: `ksweb_exit_code()` |
| 2 | `FAULT` | `ksweb_fault_info()` |
| 3 | `YIELD` | YIELD, WFI ou SLEEP_MS: retome após `ksweb_sleep_ms()` ms (0 = só ceder) |
| 4 | `WAIT_INPUT` | GETC/GETS sem dado (modo bloqueante): a syscall foi desfeita; retome depois de `ksweb_feed`/`ksweb_input_eof` |
| 5 | `BREAK` | parada do depurador antes de executar a instrução em `pc`: `ksweb_stop_reason()` |
| 6 | `NOT_LOADED` | nenhuma imagem carregada |

Motivos de `BREAK` (`ksweb_stop_reason`): 1 breakpoint, 2 instrução `BRK`
(com `KSWEB_STOPF_BRK`), 3 instrução `SYSCALL` (com `KSWEB_STOPF_SYSCALL`).

Erros (`int` com sinal): os `KSVM_E_*` de `ksvm2/include/ksvm/types.h`
(`-5` IMAGE_MAGIC, `-6` IMAGE_VERSION, `-7` IMAGE_CHECKSUM, `-8`
IMAGE_RANGE, `-9` IMAGE_ENTRY, `-10` NO_RAM, ...) e `KSWEB_E_NOMEM = -100`
(`memory.grow` recusou).

## 3. Exports

### Ciclo de vida

| Função | Descrição |
|--------|-----------|
| `ksweb_init(ram_size, stack_size) → int` | VM nova com `ram_size` bytes de RAM zerada (1..64 MiB). `stack_size != 0` substitui o `stack_size` da imagem, como `ksvm --stack`. Esvazia a arena: ponteiros anteriores de `ksweb_alloc` deixam de valer. Mantém breakpoints, opções de parada e a capacidade do trace. `0`, `KSVM_E_ARG` ou `KSWEB_E_NOMEM`. |
| `ksweb_alloc(n) → ptr` | `n` bytes na arena (alinhados a 16), para o JS copiar a imagem; 0 se não couber. |
| `ksweb_load(ptr, len) → int` | valida e carrega a imagem `.ksx` em `[ptr, ptr+len)` (doc 05 da KSVM). Devolve 0 ou o erro do loader. O buffer precisa viver enquanto a VM rodar (CODE aponta para ele). |
| `ksweb_version() → u32` | `major<<16 | minor<<8 | patch` (como a syscall VERSION). |

### Execução

| Função | Descrição |
|--------|-----------|
| `ksweb_run(max_insns) → estado` | executa até `max_insns` instruções (0 = sem limite) ou até parar. Sem breakpoints nem paradas por opcode é só `ksvm_run` (caminho rápido do núcleo); com eles, um laço de `ksvm_step` que consulta a tabela de breakpoints e o opcode em `pc` antes de cada instrução. A instrução em que a VM parou (BREAK, Passo, WAIT_INPUT) é executada sem checagem na retomada, para não parar de novo no mesmo lugar. |
| `ksweb_step() → estado` | exatamente uma instrução, ignorando breakpoints (é o Passo). |
| `ksweb_status() → int` | `ksvm_status` atual (0..3) ou 6. |
| `ksweb_exit_code() → u32` | código do HALT/EXIT (o runner usa `& 0xFF`). |
| `ksweb_sleep_ms() → u32` | prazo do último SLEEP_MS desta chamada (0 para YIELD/WFI). |
| `ksweb_stop_reason() → u32` | motivo do último `BREAK`. |
| `ksweb_insn_count() → u32` | instruções concluídas (dá a volta em 2³²). |
| `ksweb_fault_info() → ptr` | 3 palavras: código do fault (0 se não há), `pc`, `addr`. |
| `ksweb_fault_name(code) → ptr` | nome ("MEM_RANGE"...) como C string em `ksweb_text_buf()`. |
| `ksweb_err_name(err) → ptr` | nome de um `KSVM_E_*` ("IMAGE_CHECKSUM"...), como o runner nativo. |

### Entrada

| Função | Descrição |
|--------|-----------|
| `ksweb_input_buf() → ptr` | área de 4096 bytes onde o JS escreve antes de `ksweb_feed`. |
| `ksweb_feed(len) → u32` | copia `len` bytes da área para o anel (64 KiB); devolve quantos couberam. |
| `ksweb_feed_input(byte) → u32` | um byte; 1 se coube. |
| `ksweb_input_eof()` | fim da entrada (depois de esvaziar o anel, GETC/GETS veem EOF). |
| `ksweb_input_space() → u32` / `ksweb_input_pending() → u32` | espaço livre / bytes à espera no anel. |
| `ksweb_wants_input() → u32` | 1 entre o desfazer de uma syscall e o retorno de `ksweb_run` (uso interno; o estado `WAIT_INPUT` já diz isso). |
| `ksweb_set_stdin_block(on)` | 1 = suspende sem dado (padrão); 0 = poll (GETC devolve -1/AGAIN). |

### Registradores e disassembly

| Função | Descrição |
|--------|-----------|
| `ksweb_reg(i) → u32` | `r[i]` (0..31; `r0` = zr, `r30` = fp, `r31` = sp). |
| `ksweb_pc() → u32` / `ksweb_flags() → u32` | pc e flags (Z=1 N=2 C=4 V=8). |
| `ksweb_cpu_ptr() → ptr` | `ksvm_cpu`: 32 registradores, pc, flags (34 palavras), para leitura em bloco. |
| `ksweb_text_buf() → ptr` | buffer de 4096 bytes usado por disasm, trace e nomes. |
| `ksweb_disasm_at(pc, buf, n) → u32` | desmonta a instrução em `pc` (texto do `ksvm_disasm_one` da ksvm2, sem símbolos — o mesmo do trace do runner) em `buf`; devolve 4 ou 8 (formato L), ou 0 se `pc` não é executável. |

### Memória

| Função | Descrição |
|--------|-----------|
| `ksweb_mem_read(addr, len, dst, mask) → u32` | copia `[addr, addr+len)` do espaço do guest (pelo barramento, com as mesmas regras de leitura) para `dst`; bytes fora de região legível saem 0 e, se `mask != 0`, `mask[i] = 1` nos legíveis. Devolve quantos eram legíveis. Não altera a VM; o endereço dá a volta em 2³². |
| `ksweb_regions(dst) → u32` | 5 palavras por região (base, size, perm R=1 W=2 X=4, kind RAM=0 ROM=1 MMIO=2, ponteiro do backing na memória wasm); devolve a quantidade (2 depois de `ksweb_load`: RAM e CODE). |
| `ksweb_header() → ptr` | 22 palavras: 0 ver_major, 1 ver_minor, 2 flags, 3 entry, 4 code_off, 5 code_size, 6 data_off, 7 data_size, 8 bss_size, 9 ram_base do arquivo, 10 ram_min, 11 stack_size efetivo, 12 sym_off, 13 sym_size, 14 checksum, 15 ram_base efetivo, 16 ram_size, 17 sp inicial, 18 stack_limit, 19 heap_start, 20 tamanho da imagem, 21 carregada (0/1). |

### Depurador

| Função | Descrição |
|--------|-----------|
| `ksweb_bp_set(addr) → int` | 0 (inclusive se já existia) ou -1 (64 breakpoints no máximo). |
| `ksweb_bp_clear(addr) → int` | 0 ou -1 se não existia. |
| `ksweb_bp_clear_all()`, `ksweb_bp_count() → u32`, `ksweb_bp_get(i) → u32` | tabela de breakpoints. |
| `ksweb_set_stop_flags(f)` | `1` parar antes de `BRK`, `2` parar antes de `SYSCALL`. |
| `ksweb_trace_enable(n) → u32` | liga o trace guardando os últimos `n` registros (até 65536) ou desliga (`0`); limpa o histórico; devolve a capacidade. Ligado, instala o hook de trace do núcleo (custo por instrução só quando ligado). |
| `ksweb_trace_clear()`, `ksweb_trace_total() → u32`, `ksweb_trace_count() → u32` | limpa; registros desde a limpeza; registros guardados. |
| `ksweb_trace_line(i, buf, n) → u32` | registro `i` (0 = o mais antigo guardado) formatado exatamente como uma linha do `ksvm --trace` (`pc: bytes  instrução  flags\n`); um BRK sai como `brk at pc=...` seguido do dump de registradores, como no runner. Devolve o comprimento. |
| `ksweb_trace_pc(i) → u32` | pc do registro `i`. |

## 4. `web/vmcore.js`

Script clássico (funciona em `importScripts`, num Blob e em `require`).

### `KsCore`

`KsCore.create(bytes, opts)` (assíncrono) ou `KsCore.createSync(bytes,
opts)`; `opts.onPutc(byte)` (sem ele a saída acumula e sai por
`takeOutput()`), `opts.clock()` (ms; padrão `performance.now`). Métodos
correspondentes aos exports, já convertendo dados:

`init(ram, stack)`, `load(Uint8Array) → err`, `run(n)`, `step()`,
`status()`, `exitCode()`, `sleepMs()`, `stopReason()`, `insnCount()`,
`faultInfo() → {code, name, pc, addr}`, `errName(err)`, `faultName(code)`,
`version() → "2.0.0"`, `feed(Uint8Array) → aceitos`, `feedByte(b)`,
`inputEof()`, `inputSpace()`, `inputPending()`, `setStdinBlock(on)`,
`reg(i)`, `pc()`, `flags()`, `cpu() → {r[32], pc, flags, insns}`,
`disasmAt(pc) → {len, text}`, `memRead(addr, len) → {bytes, mask,
readable}` (em pedaços de 2 KiB pelo buffer de texto, sem consumir a arena),
`regions() → [{base, size, perm, permStr, kind, kindName, host}]` (por
base), `header() → {...}` (nomes do §3 em camelCase, mais `flagNames`),
`bpSet/bpClear/bpClearAll/bpList`, `setStopFlags(brk, syscall)`,
`traceEnable(n)`, `traceClear()`, `traceCount()`, `traceTotal()`,
`traceText(from?, max?)` (texto no formato do `--trace`), `traceTail(n) →
[{pc, line}]`, `finishInfo(state, limit) → {code, kind, message}`,
`takeOutput() → Uint8Array`.

As vistas da memória são recriadas quando `memory.grow` troca o
`ArrayBuffer` (getter `u8`).

### `KsSession`

Uma execução com a convenção do runner nativo: `new KsSession(core,
{ramSize, stackSize, maxInsns, slice, stdinBlock})`, `load(image) → null |
{code, kind: 'load', message}`, `pushInput(bytes)` (fila; entrega ao anel
conforme houver espaço), `eof()` (depois da fila), `tick(step?) → {action,
...}` com `action` em `continue | sleep (ms) | wait | break (reason) | done
(info)`, e `runSync(input)` para testes (entrada inteira + EOF, YIELD sem
espera real).

Outros: `parseSymbols(image, symOff, symSize) → [{addr, kind, name}]`,
`STATE`, `STATE_NAME`, `EXIT` (64/65/66/69/70/124/130), `REG_NAMES`.

## 5. Exemplo mínimo (Node)

```js
const { KsCore, KsSession } = require('./web/vmcore.js');
const fs = require('fs');
const core = KsCore.createSync(fs.readFileSync('build/ksvm.wasm'));
const s = new KsSession(core, { ramSize: 1 << 20 });
if (!s.load(fs.readFileSync('build/examples/hello.ksx'))) {
  const r = s.runSync('');
  process.stdout.write(Buffer.from(r.stdout));   // Hello, KSVM!
  process.exitCode = r.info.code;                 // 0
}
```
