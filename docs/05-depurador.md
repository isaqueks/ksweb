# 05 — Depurador

Na IDE o depurador tem três partes: o **editor** (breakpoints no gutter,
linha atual destacada, valores ao passar o mouse — 07-ide.md), o painel
**Desassembly** embaixo (o `ksdis` inteiro da imagem, com o pc destacado e
breakpoints por clique) e a coluna **Depurador** à direita, recolhível
(Ctrl+F9). Os controles ficam na barra superior: **Continuar** (F5/F8),
**Parar** (Shift+F5, Ctrl+Alt+C), **Passo** (F10, por cima de call),
**Passo-dentro** (F11, uma instrução), **Sair** (Shift+F11),
**Reiniciar** (Ctrl+Shift+F5) e **Depurar** (carregar e parar na entrada).

## Como funciona

- **No C** (`src/ksweb.c`): tabela de até 64 breakpoints, as opções "parar
  em BRK" e "parar em syscall" e a parada por profundidade de chamadas
  (`ksweb_frame_stop`). Com qualquer uma ativa, `ksweb_run` executa
  instrução a instrução e, antes de cada uma, compara o `pc` com a tabela e
  (se pedido) olha o opcode em `pc`; ao bater, devolve `KSWEB_BREAK` sem
  executar a instrução. A instrução em que parou é executada sem checagem na
  retomada (como um depurador que "passa por cima" do breakpoint em que está).
  Sem nenhuma, é o `ksvm_run` direto (caminho rápido).
- **Passo por cima / sair da função**: o laço conta `CALL`/`CALLR` (+1) e
  `RET` (-1) executados e para logo depois do `RET` que leva a contagem a 0
  (passo por cima de um call: a chamada inteira, recursão incluída) ou a -1
  (sair da função atual). O worker decide: Passo (F10) num `call`/`callr`
  arma a parada 0; noutra instrução, é um passo comum. Um breakpoint no
  caminho, Parar ou o fim do programa desarmam.
- **Breakpoints de fonte**: a IDE converte `(arquivo, linha)` em endereço
  pelo mapa linha ↔ endereço da montagem (01-arquitetura §6); linha sem
  código vai para a próxima com instrução. A tabela do C recebe a união
  desses endereços com os breakpoints por endereço.
- **Trace**: o hook de trace do núcleo (`KSVM_ENABLE_TRACE`) grava cada
  instrução executada num anel de até 65536 registros `{pc, palavra,
  imm32, flags}`; o BRK grava também um retrato dos registradores. O texto
  é formatado em C exatamente como no `ksvm --trace` (`ksweb_trace_line`).
- **No worker**: a cada parada (breakpoint, passo, Parar, fim, espera de
  entrada) envia um `snapshot` com os registradores, uma janela de
  disassembly, 32 palavras a partir do `sp`, o fault (se houver) e as
  últimas linhas do trace (até 1000). A memória do hexdump e do watch é
  pedida à parte (`mem`). A página usa o `pc` do snapshot para destacar a
  linha do fonte e a do desassembly.

## Coluna Depurador

### Topo
Motivo da parada (breakpoint, passo, BRK, syscall, fault), instruções e
instruções/s; **Passo N** (N instruções, respeitando breakpoints) e as
opções parar em `BRK` (ligada por padrão) e em `SYSCALL`.

### Registradores
r0..r31 com os apelidos `zr`, `fp`, `sp`, em hex e decimal com sinal, em
duas colunas; o título de cada célula mostra o valor sem sinal e como float
binary32; a caixa "float" acrescenta a coluna. `pc` e `flags` (Z N C V
acesas/apagadas). Células que mudaram desde a parada anterior ficam
destacadas. No editor, passar o mouse num registrador mostra o mesmo valor.

### Watch
Expressões (rótulo, `0x1000`, decimal, registrador, somas como `sp+8`); a
cada parada mostram o endereço e o conteúdo como word (hex e decimal),
float, byte (com o caractere) e string C (UTF-8, até 40 caracteres);
valores alterados destacados. Ficam salvas por projeto.

### Breakpoints
Lista com o endereço, `arquivo:linha` (clique leva ao fonte), o rótulo no
endereço e "(movido da N)" quando a linha marcada não gerava código. O campo
aceita `0x1C`, decimal, rótulos (`loop`), registradores e somas (`pc+8`,
`sp-4`); endereços têm de ser múltiplos de 4 (e um endereço que é de uma
linha do fonte vira o breakpoint dessa linha). × remove, **Limpar** remove
todos.

### Pilha
32 palavras a partir do `sp`: endereço, valor, marcas `sp` e `fp` e `ret?`
para valores que caem dentro de CODE e alinhados (prováveis endereços de
retorno, com o símbolo mais próximo). Com a pilha vazia (`sp` no topo da
RAM) as leituras saem `??`.

### Memória
Hexdump só de leitura, 16 bytes por linha (256 por página), com endereço,
hex e ASCII. Campo "ir para" (mesma sintaxe dos breakpoints), ◀ ▶ e atalhos
para `pc`, `sp`, `fp`, CODE, `.data`, `.bss`, heap (do cabeçalho `.ksx`).
Cores por região: CODE (texto e rodata ficam juntos na região CODE do
`.ksx`), `.data`, `.bss`, heap, pilha (`stack_limit..sp inicial`); bytes
ilegíveis como `??`; bytes diferentes do que se viu na parada anterior
destacados; o byte em `pc` e em `sp` contornados.

### Trace
As últimas linhas, no formato do runner:

    00000000: 03 01 00 00 1C 00 00 00  movil r1, 0x1C               ----

Liga/desliga e quantos registros guardar (padrão 1000, até 65536).
**Exportar .txt** baixa o anel inteiro (`trace.txt`) — o mesmo texto que o
`ksvm --trace` escreve no stderr para o mesmo programa (os testes comparam
byte a byte).

## Painel Desassembly

A listagem do `ksdis` da imagem montada (ou do `.ksx` aberto no modo
simples): cabeçalho, símbolos, `.text` com endereço, bytes, instrução e
alvo dos desvios, dados. A instrução no `pc` fica destacada e rolada à
vista quando a VM para; um clique numa instrução liga/desliga o breakpoint
(● na margem). Quando o `pc` não corresponde a uma linha do fonte (imagem
sem projeto, código fora do mapa), a IDE mostra este painel.

## Faults

Por padrão (Opções → "mostrar o depurador em fault") a coluna abre quando
a VM termina em fault, com a linha culpada destacada no editor (ou no
desassembly); o terminal mostra `fault: NOME at pc=0x... addr=0x...`.

## API usada

`ksweb_bp_*`, `ksweb_set_stop_flags`, `ksweb_frame_stop`,
`ksweb_stop_reason`, `ksweb_trace_*`, `ksweb_mem_read`, `ksweb_regions`,
`ksweb_header`, `ksweb_cpu_ptr`, `ksweb_disasm_at` (02-api.md). Os
formatadores (hexdump, registradores, float, flags, pilha, janela de
disassembly, endereços) estão em `web/format.js`, sem DOM, testados em
`test/test_format.js`.
