# 05 — Depurador

Painel lateral aberto pelo botão **Depurador** (Ctrl+F9), escondido por
padrão. Fechado, o worker desliga o trace, os breakpoints e as paradas por
opcode, e `ksweb_run` volta a ser um `ksvm_run` direto: o modo normal não
paga nada pelo depurador.

## Como funciona

- **No C** (`src/ksweb.c`): tabela de até 64 breakpoints e as opções "parar
  em BRK" e "parar em syscall". Com qualquer uma ativa, `ksweb_run` executa
  instrução a instrução e, antes de cada uma, compara o `pc` com a tabela e
  (se pedido) olha o opcode em `pc`; ao bater, devolve `KSWEB_BREAK` sem
  executar a instrução. A instrução em que parou é executada sem checagem na
  retomada (como um depurador que "passa por cima" do breakpoint em que está).
- **Trace**: o hook de trace do núcleo (`KSVM_ENABLE_TRACE`) grava cada
  instrução executada num anel de até 65536 registros `{pc, palavra,
  imm32, flags}`; o BRK grava também um retrato dos registradores. O texto
  é formatado em C exatamente como no `ksvm --trace` (`ksweb_trace_line`).
- **No worker**: a cada parada (breakpoint, Parar, Passo, fim, espera de
  entrada) envia um `snapshot` com os registradores, a janela de
  disassembly, 32 palavras a partir do `sp`, o fault (se houver) e as últimas
  linhas do trace (até 1000). A memória do hexdump é pedida à parte
  (`mem`).

## Seções

### Controles
**Continuar** (F8), **Parar** (Ctrl+Alt+C), **Passo** (F10, uma instrução,
ignora breakpoints), **Passo N** (N instruções, respeitando breakpoints),
**Reiniciar**. Opções: parar em `BRK` (ligado por padrão), parar em
`SYSCALL`, trace ligado e quantos registros guardar (padrão 1000, até
65536). Contador total de instruções e instruções por segundo.

### Registradores
r0..r31 com os apelidos `zr`, `fp`, `sp`, em hex e decimal com sinal, em
duas colunas; o título de cada célula mostra o valor sem sinal e como float
binary32; a caixa "float" acrescenta a coluna. `pc` e `flags` (Z N C V
acesas/apagadas). Células que mudaram desde a parada anterior ficam
destacadas.

### Disassembly
~32 instruções antes e depois do `pc` (como o formato L tem 8 bytes, a
janela começa antes e anda para a frente até cair no `pc`), rótulos da
tabela de símbolos da imagem, linha atual destacada, a instrução culpada em
vermelho depois de um fault. Clicar numa linha liga/desliga o breakpoint.

### Breakpoints
Lista editável: o campo aceita `0x1C`, decimal, rótulos (`loop`), registradores
e somas (`pc+8`, `sp-4`); endereços têm de ser múltiplos de 4. × remove,
**Limpar** remove todos.

### Pilha
32 palavras a partir do `sp`: endereço, valor, marcas `sp` e `fp` e `ret?`
para valores que caem dentro de CODE e alinhados (prováveis endereços de
retorno, com o símbolo mais próximo). Com a pilha vazia (`sp` no topo da
RAM) as leituras saem `??`.

### Memória
Hexdump só de leitura, 16 bytes por linha (256 por página), com endereço,
hex e ASCII. Campo "ir para" (mesma sintaxe dos breakpoints), ◀ ▶ e atalhos
para `pc`, `sp`, `fp`, CODE, RAM, `.data`, `.bss`, heap (do cabeçalho
`.ksx`). Cores por região: CODE (texto e rodata ficam juntos na região CODE
do `.ksx`), `.data`, `.bss`, heap, pilha (`stack_limit..sp inicial`); bytes
ilegíveis como `??`; bytes diferentes do que se viu na parada anterior
destacados; o byte em `pc` e em `sp` contornados.

### Trace
As últimas linhas, no formato do runner:

    00000000: 03 01 00 00 1C 00 00 00  movil r1, 0x1C               ----

**Exportar .txt** baixa o anel inteiro (`trace.txt`) — o mesmo texto que o
`ksvm --trace` escreve no stderr para o mesmo programa (os testes comparam
byte a byte).

### Faults
Por padrão (Opções → "abrir depurador em fault") o painel abre quando a VM
termina em fault, com a instrução culpada destacada; o terminal mostra
`fault: NOME at pc=0x... addr=0x...`.

## API usada

`ksweb_bp_*`, `ksweb_set_stop_flags`, `ksweb_stop_reason`,
`ksweb_trace_*`, `ksweb_mem_read`, `ksweb_regions`, `ksweb_header`,
`ksweb_cpu_ptr`, `ksweb_disasm_at` (02-api.md). Os formatadores (hexdump,
registradores, float, flags, pilha, janela de disassembly, endereços) estão
em `web/format.js`, sem DOM, testados em `test/test_format.js`.
