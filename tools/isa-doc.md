# Fichas da ISA KSVM v2 (ajuda ao cursor e referência da IDE)

> **Fonte normativa: o doc 04 da ksvm2** (`KSVM2/docs/04-isa.md`: instruções, flags,
> formatos, condições, extensão F em §5.7, pseudo-instruções em §7), com o doc 07
> (assembler e diretivas) e o doc 06 (syscalls). Este arquivo só reescreve aquilo em forma
> de fichas para a IDE; onde o doc 04 não diz, o texto segue o código da ksvm2
> (`src/core/exec.c`, `alu.c`, `syscall.c`, `src/tools/ksas/`). **Divergência entre uma
> ficha e o doc 04: corrija primeiro o doc 04 (ou o código da ksvm2) e depois esta ficha.**

`tools/mkisa.js` lê este arquivo e o junta ao que vem do `isa.def` (opcode, formato, flags,
operandos) para gerar `build/web/isa.json`. Formato:

- `# Seção` abre uma categoria (Instruções, Condições, Pseudo-instruções, Formas
  abreviadas, Diretivas, Registradores, Registradores especiais, Flags, Formatos, Faults,
  Syscalls, Erros de syscall, Mapa de opcodes); o texto antes da primeira seção é ignorado.
- `## chave` abre uma ficha: o mnemônico em minúsculas, a diretiva com o ponto, o nome da
  condição, do registrador, do fault ou da syscall.
- Logo abaixo, linhas `campo: valor` (sem linha em branco no meio); `sintaxe:` pode se
  repetir (a primeira é a principal). Depois de uma linha em branco, cada linha não vazia
  é uma linha do detalhe da ficha.
- Crases marcam código (viram `<code>` na IDE). `exemplo:` é uma linha de assembly que
  monta dentro de um `.text` mínimo com os rótulos `_start` e `fim` (test/test_isa.js
  confere, e confere que a primeira instrução gerada tem o opcode da ficha).
- O build falha se faltar ficha para algum opcode, condição, diretiva, pseudo-instrução,
  registrador especial, fault ou syscall, ou se sobrar ficha que não existe.

# Instruções

## nop
grupo: movimentação
resumo: Não faz nada; só avança o `pc` para a instrução seguinte.
sintaxe: nop
exemplo: nop                     ; ocupa 4 bytes sem efeito

Não altera registradores, memória nem flags.
A palavra `0x00000000` decodifica como NOP: memória zerada executada vira uma sequência de NOPs, não um fault.

## mov
grupo: movimentação
resumo: Copia `rb` para `rd`; não altera flags.
sintaxe: mov rd, rb
sintaxe: mov rd, imm
exemplo: mov r1, r2              ; r1 = r2

`rd = rb`; Z, N, C e V ficam como estavam.
Com imediato (`mov r1, 5`) o assembler emite MOVI, ou MOVIL se o valor não couber em 14 bits ou ainda não for conhecido.
`clr rd` é `mov rd, zr`; `mov zr, rX` não tem efeito (escritas em `zr` são descartadas).

## movi
grupo: movimentação
resumo: Carrega em `rd` um imediato de 14 bits com sinal (−8192…8191).
sintaxe: movi rd, imm
exemplo: movi r1, -5             ; r1 = 0xFFFFFFFB

`rd = sext(imm14)`: o bit 13 do campo é replicado nos bits altos. Flags preservadas.
Valor já conhecido que não cabe: o assembler emite MOVIL (8 bytes). Prefira `li`, que escolhe sozinho e assume a forma longa para rótulos ainda não definidos.

## movil
grupo: movimentação
resumo: Carrega em `rd` uma constante de 32 bits (instrução de 8 bytes).
sintaxe: movil rd, imm32
exemplo: movil r1, 0xDEADBEEF    ; constante de 32 bits

Formato L: a palavra seguinte à instrução é o `imm32`; `rd = imm32`. Flags preservadas.
Aceita rótulos e expressões (`movil r2, msg + 4`): é o que `la` gera sem `.pic`, e `fli` gera MOVIL com os bits do float.

## adr
grupo: movimentação
resumo: Põe em `rd` o endereço `PC_next + imm14` (endereço relativo ao pc, curto).
sintaxe: adr rd, rótulo
exemplo: adr r1, fim             ; r1 = endereço de fim

`rd = PC_next + sext(imm14)`, com `PC_next` = endereço desta instrução + 4. Flags preservadas.
O assembler calcula `rótulo − PC_next`; o alcance é −8192…+8191 bytes, senão erro de montagem (use ADRL ou `la` com `.pic`).
Serve para código independente de posição: o resultado não depende de onde a imagem foi carregada.

## adrl
grupo: movimentação
resumo: Põe em `rd` o endereço `PC_next + imm32` (relativo ao pc, longo; 8 bytes).
sintaxe: adrl rd, rótulo
exemplo: adrl r1, _start         ; endereço relativo ao pc

`rd = PC_next + imm32`, com `PC_next` = endereço desta instrução + 8. Flags preservadas.
Alcança qualquer endereço; é o que `la rd, rótulo` gera quando o arquivo tem `.pic`.

## mfsr
grupo: sistema
resumo: Lê o registrador especial `sr` (PC, FLAGS, ISA_VERSION ou INSN_COUNT) para `rd`.
sintaxe: mfsr rd, sr
exemplo: mfsr r1, FLAGS          ; r1 = flags (Z=bit 0 … V=bit 3)

`sr` pelo nome ou pelo número 0–3 (imediato de 14 bits sem sinal). Flags preservadas.
`mfsr rd, PC` devolve o endereço da própria instrução MFSR, não `PC_next`; `ISA_VERSION` vale `0x0200`.
Número de SR inexistente (≥ 4) → fault BAD_OPCODE, com `fault_addr` = a palavra da instrução.

## mtsr
grupo: sistema
resumo: Grava `rb` no registrador especial `sr`; só FLAGS é gravável.
sintaxe: mtsr sr, rb
exemplo: mtsr FLAGS, r2          ; restaura Z N C V a partir de r2

`FLAGS = rb & 0xF`: Z, N, C e V passam a ser os bits 0–3 de `rb`; os bits 4–31 são descartados.
Qualquer outro SR (PC, ISA_VERSION, INSN_COUNT ou inexistente) → fault BAD_OPCODE; para mudar o pc use JMPR.
Com `mfsr rd, FLAGS` salva e restaura as flags em volta de um trecho que as destrói.

## ldb
grupo: load/store
resumo: Lê um byte em `[rb + imm]` e grava em `rd` estendido com zeros (0…255).
sintaxe: ldb rd, [rb + imm]
sintaxe: ldb rd, [rb]
sintaxe: ldb rd, [rótulo]
exemplo: ldb r3, [r2 + 1]        ; r3 = byte em r2+1 (0..255)

`EA = rb + sext(imm14)` (deslocamento −8192…8191); `rd = zext8(mem[EA])`. Loads não alteram flags.
`[rb]` = `[rb + 0]`; `[rb - 4]` é aceito; `[rb + rc]` vira LDBX; `[rótulo]` = `[zr + rótulo]` se o endereço for menor que 8192.
EA fora de toda região → fault MEM_RANGE; região sem leitura → MEM_PERM. Em fault nada muda e o pc fica na instrução.

## ldbs
grupo: load/store
resumo: Lê um byte em `[rb + imm]` e grava em `rd` com o sinal estendido (−128…127).
sintaxe: ldbs rd, [rb + imm]
sintaxe: ldbs rd, [rb]
exemplo: ldbs r3, [r2]           ; 0xFF vira -1 (0xFFFFFFFF)

`rd = sext8(mem[rb + sext(imm14)])`: o bit 7 do byte é replicado nos bits 8–31. Flags preservadas.
É o load de `signed char` (o `char` do kscc é com sinal); `[rb + rc]` vira LDBSX.
Endereço inválido → fault MEM_RANGE (ou MEM_PERM sem permissão de leitura).

## ldh
grupo: load/store
resumo: Lê 16 bits (little-endian) em `[rb + imm]` e grava em `rd` estendido com zeros.
sintaxe: ldh rd, [rb + imm]
sintaxe: ldh rd, [rb]
exemplo: ldh r1, [r2 + 2]        ; r1 = halfword em r2+2 (0..65535)

`rd = zext16(mem[EA])`, `EA = rb + sext(imm14)`; byte baixo no endereço menor. Flags preservadas.
Não exige alinhamento: endereço ímpar funciona (o barramento lê byte a byte), desde que os 2 bytes estejam numa só região.
Endereço inválido → fault MEM_RANGE ou MEM_PERM; `[rb + rc]` vira LDHX.

## ldhs
grupo: load/store
resumo: Lê 16 bits em `[rb + imm]` e grava em `rd` com o sinal estendido (−32768…32767).
sintaxe: ldhs rd, [rb + imm]
sintaxe: ldhs rd, [rb]
exemplo: ldhs r1, [r2]           ; 0x8000 vira 0xFFFF8000

`rd = sext16(mem[EA])`: o bit 15 é replicado nos bits 16–31. Flags preservadas.
É o load de `short`; sem exigência de alinhamento; `[rb + rc]` vira LDHSX.
Endereço inválido → fault MEM_RANGE ou MEM_PERM.

## ldw
grupo: load/store
resumo: Lê uma palavra de 32 bits (little-endian) em `[rb + imm]` para `rd`.
sintaxe: ldw rd, [rb + imm]
sintaxe: ldw rd, [rb]
sintaxe: ldw rd, [rótulo]
exemplo: ldw r1, [sp + 4]        ; r1 = palavra em sp+4

`rd = mem32[rb + sext(imm14)]`, byte menos significativo no endereço menor. Flags preservadas.
Sem exigência de alinhamento, mas os 4 bytes precisam estar numa única região; `[rb + rc]` vira LDWX.
Endereço inválido → fault MEM_RANGE ou MEM_PERM. Para um endereço de dados grande, `la rN, rótulo` e depois `[rN]`.

## stb
grupo: load/store
resumo: Grava o byte baixo de `ra` em `[rb + imm]`.
sintaxe: stb [rb + imm], ra
sintaxe: stb ra, [rb + imm]
exemplo: stb [r2], r1            ; byte em r2 = r1 & 0xFF

`mem[rb + sext(imm14)] = ra & 0xFF`. Nos stores `ra` é a fonte (o mesmo campo de bits do `rd` dos loads). Flags preservadas.
As duas ordens de operandos são aceitas; `[rb + rc]` vira STBX.
Escrita na região de código (ROM) → fault MEM_PERM; fora de toda região → MEM_RANGE; em fault a memória não muda.

## sth
grupo: load/store
resumo: Grava os 16 bits baixos de `ra` em `[rb + imm]` (little-endian).
sintaxe: sth [rb + imm], ra
sintaxe: sth ra, [rb + imm]
exemplo: sth [r2 + 2], r1        ; halfword em r2+2 = r1 & 0xFFFF

`mem16[rb + sext(imm14)] = ra & 0xFFFF`; sem exigência de alinhamento. Flags preservadas.
Escrita em ROM → fault MEM_PERM; fora de região → MEM_RANGE; `[rb + rc]` vira STHX.

## stw
grupo: load/store
resumo: Grava a palavra de 32 bits `ra` em `[rb + imm]` (little-endian).
sintaxe: stw [rb + imm], ra
sintaxe: stw ra, [rb + imm]
exemplo: stw [sp + 8], r1        ; palavra em sp+8 = r1

`mem32[rb + sext(imm14)] = ra`, byte baixo no endereço menor; sem exigência de alinhamento. Flags preservadas.
Escrita em ROM → fault MEM_PERM; fora de região → MEM_RANGE (nenhum byte é escrito); `[rb + rc]` vira STWX.

## ldbx
grupo: load/store
resumo: Lê um byte em `[rb + rc]` e grava em `rd` estendido com zeros.
sintaxe: ldbx rd, [rb + rc]
exemplo: ldbx r1, [r2 + r3]      ; r1 = byte em r2 + r3

Como LDB, mas o endereço é `rb + rc` (índice em registrador, formato R). Flags preservadas.
`ldb rd, [rb + rc]` já escolhe esta forma; `ldbx` exige o endereço `[rb + rc]`.
Endereço inválido → fault MEM_RANGE ou MEM_PERM.

## ldbsx
grupo: load/store
resumo: Lê um byte em `[rb + rc]` e grava em `rd` com o sinal estendido.
sintaxe: ldbsx rd, [rb + rc]
exemplo: ldbsx r1, [r2 + r3]     ; r1 = sext8(byte em r2 + r3)

Como LDBS, com endereço `rb + rc`. Flags preservadas.
`ldbs rd, [rb + rc]` já escolhe esta forma. Endereço inválido → fault MEM_RANGE ou MEM_PERM.

## ldhx
grupo: load/store
resumo: Lê 16 bits em `[rb + rc]` e grava em `rd` estendido com zeros.
sintaxe: ldhx rd, [rb + rc]
exemplo: ldhx r1, [r2 + r3]      ; r1 = zext16(mem[r2 + r3])

Como LDH, com endereço `rb + rc`; sem exigência de alinhamento. Flags preservadas.
`ldh rd, [rb + rc]` já escolhe esta forma. Endereço inválido → fault MEM_RANGE ou MEM_PERM.

## ldhsx
grupo: load/store
resumo: Lê 16 bits em `[rb + rc]` e grava em `rd` com o sinal estendido.
sintaxe: ldhsx rd, [rb + rc]
exemplo: ldhsx r1, [r2 + r3]     ; r1 = sext16(mem[r2 + r3])

Como LDHS, com endereço `rb + rc`. Flags preservadas.
`ldhs rd, [rb + rc]` já escolhe esta forma. Endereço inválido → fault MEM_RANGE ou MEM_PERM.

## ldwx
grupo: load/store
resumo: Lê uma palavra de 32 bits em `[rb + rc]` para `rd`.
sintaxe: ldwx rd, [rb + rc]
exemplo: ldwx r1, [r2 + r3]      ; r1 = mem32[r2 + r3]

Como LDW, com endereço `rb + rc`: acesso a vetor com o deslocamento já calculado em registrador (`shli r3, r4, 2` para índice × 4). Flags preservadas.
`ldw rd, [rb + rc]` já escolhe esta forma. Endereço inválido → fault MEM_RANGE ou MEM_PERM.

## stbx
grupo: load/store
resumo: Grava o byte baixo de `ra` em `[rb + rc]`.
sintaxe: stbx [rb + rc], ra
sintaxe: stbx ra, [rb + rc]
exemplo: stbx [r2 + r3], r1      ; byte em r2 + r3 = r1 & 0xFF

Como STB, com endereço `rb + rc`; `ra` é a fonte. Flags preservadas.
`stb [rb + rc], ra` já escolhe esta forma. Escrita em ROM → fault MEM_PERM; fora de região → MEM_RANGE.

## sthx
grupo: load/store
resumo: Grava os 16 bits baixos de `ra` em `[rb + rc]`.
sintaxe: sthx [rb + rc], ra
sintaxe: sthx ra, [rb + rc]
exemplo: sthx [r2 + r3], r1      ; halfword em r2 + r3 = r1 & 0xFFFF

Como STH, com endereço `rb + rc`. Flags preservadas.
`sth [rb + rc], ra` já escolhe esta forma. Escrita em ROM → fault MEM_PERM; fora de região → MEM_RANGE.

## stwx
grupo: load/store
resumo: Grava a palavra de 32 bits `ra` em `[rb + rc]`.
sintaxe: stwx [rb + rc], ra
sintaxe: stwx ra, [rb + rc]
exemplo: stwx [r2 + r3], r1      ; mem32[r2 + r3] = r1

Como STW, com endereço `rb + rc`. Flags preservadas.
`stw [rb + rc], ra` já escolhe esta forma. Escrita em ROM → fault MEM_PERM; fora de região → MEM_RANGE.

## push
grupo: pilha
resumo: Decrementa `sp` em 4 e grava `ra` em `[sp]`.
sintaxe: push ra
sintaxe: push ra, rb, …
exemplo: push r1                 ; sp -= 4; [sp] = r1

`sp −= 4; [sp] = ra`. `push sp` empilha o valor antigo de `sp`. Flags preservadas.
`push r1, r2, r3` gera um PUSH por registrador, na ordem escrita (desempilhe com `pop r3, r2, r1`).
`sp − 4` abaixo do limite da pilha → fault STACK; escrita fora de toda região → MEM_RANGE (numa região só de leitura, MEM_PERM). Em fault `sp` não muda.

## pop
grupo: pilha
resumo: Lê `[sp]` para `rd` e incrementa `sp` em 4.
sintaxe: pop rd
sintaxe: pop rd, …
exemplo: pop r1                  ; r1 = [sp]; sp += 4

`rd = [sp]; sp += 4`. `pop sp` termina com `sp` = valor lido (o `+= 4` não se aplica); `pop zr` só descarta. Flags preservadas.
`pop r3, r2, r1` gera um POP por registrador, na ordem escrita.
Leitura fora da memória → fault MEM_RANGE, sem mudar `sp`.

## pushm
grupo: pilha
resumo: Reservada: empilharia r16…r29/fp conforme uma máscara; a VM 2.0 responde fault BAD_OPCODE.
sintaxe: pushm máscara
exemplo: pushm 0x3               ; reservado: BAD_OPCODE na VM 2.0

Instrução opcional da fase 5 (prólogo compacto), máscara de 14 bits sem sinal.
O assembler e o disassembler a aceitam, mas a VM atual não a implementa: executar dá fault BAD_OPCODE.
Use PUSH com lista de registradores: `push r16, r17, fp`.

## popm
grupo: pilha
resumo: Reservada: inverso de PUSHM; a VM 2.0 responde fault BAD_OPCODE.
sintaxe: popm máscara
exemplo: popm 0x3                ; reservado: BAD_OPCODE na VM 2.0

Opcional da fase 5, máscara de 14 bits sem sinal; montada e desmontada, mas não executada pela VM 2.0.
Use POP com lista de registradores: `pop fp, r17, r16`.

## add
grupo: aritmética
resumo: Soma `ra` e `rb` e grava em `rd`; atualiza Z, N, C e V.
sintaxe: add rd, ra, rb
sintaxe: add rd, ra, imm
exemplo: add r1, r2, r3          ; r1 = r2 + r3

`rd = ra + rb` (módulo 2³²).
Z = resultado zero; N = bit 31; C = carry sem sinal (a soma passou de `0xFFFFFFFF`); V = overflow com sinal.
Com imediato o assembler usa ADDI, ou ADDL se o valor não couber em 14 bits ou ainda não for conhecido.
`rd = zr` descarta o resultado e fica só com as flags.

## addi
grupo: aritmética
resumo: Soma `ra` e um imediato de 14 bits com sinal e grava em `rd`; atualiza Z, N, C e V.
sintaxe: addi rd, ra, imm
exemplo: addi sp, sp, -16        ; reserva 16 bytes na pilha

`rd = ra + sext(imm14)`, imediato em −8192…8191; flags como ADD.
Valor já conhecido fora da faixa: o assembler emite ADDL (8 bytes).
`inc rd` = `addi rd, rd, 1`.

## addl
grupo: aritmética
resumo: Soma `ra` e um imediato de 32 bits e grava em `rd` (8 bytes); atualiza Z, N, C e V.
sintaxe: addl rd, ra, imm32
exemplo: addl r1, r1, 0x10000    ; r1 += 65536

`rd = ra + imm32`; flags como ADD.
Também é a forma longa de SUBI: não existe SUBL, e o assembler emite `addl rd, ra, -imm`.

## sub
grupo: aritmética
resumo: Subtrai `rb` de `ra` e grava em `rd`; atualiza Z, N, C e V.
sintaxe: sub rd, ra, rb
sintaxe: sub rd, ra, imm
exemplo: sub r1, r2, r3          ; r1 = r2 - r3

`rd = ra − rb` (módulo 2³²), calculado como `ra + ~rb + 1`.
C segue o ARM: C = 1 quando não há empréstimo (`ra ≥ rb` sem sinal); V = overflow com sinal.
`sub zr, ra, rb` equivale a `cmp ra, rb`. Com imediato vira SUBI (ou ADDL com o imediato negado).

## subi
grupo: aritmética
resumo: Subtrai de `ra` um imediato de 14 bits com sinal e grava em `rd`; atualiza Z, N, C e V.
sintaxe: subi rd, ra, imm
exemplo: subi r1, r1, 1          ; r1 = r1 - 1

`rd = ra − sext(imm14)`; flags como SUB (C = não-borrow).
Não existe SUBL: com imediato já conhecido fora de −8192…8191 o assembler emite `addl rd, ra, -imm` (V difere só com imm = −2³¹).
`dec rd` = `subi rd, rd, 1`.

## adc
grupo: aritmética
resumo: Soma `ra`, `rb` e o carry (C) e grava em `rd`; atualiza Z, N, C e V.
sintaxe: adc rd, ra, rb
exemplo: adc r2, r4, r6          ; parte alta de uma soma de 64 bits

`rd = ra + rb + C`; C de saída = carry da soma de 33 bits; V = overflow com sinal.
Soma de 64 bits: `add` nas partes baixas e depois `adc` nas altas.
Só forma registrador (não há ADCI).

## sbc
grupo: aritmética
resumo: Subtrai `rb` e o empréstimo (1 − C) de `ra` e grava em `rd`; atualiza Z, N, C e V.
sintaxe: sbc rd, ra, rb
exemplo: sbc r2, r4, r6          ; parte alta de uma subtração de 64 bits

`rd = ra − rb − (1 − C)`, isto é, `ra + ~rb + C`.
C de saída = não-borrow (convenção ARM); V = overflow com sinal.
Subtração de 64 bits: `sub` nas partes baixas e depois `sbc` nas altas.

## neg
grupo: aritmética
resumo: Grava em `rd` o negativo de `rb` (0 − rb); atualiza Z, N, C e V.
sintaxe: neg rd, rb
sintaxe: neg rd
exemplo: neg r1, r2              ; r1 = -r2

`rd = 0 − rb` (módulo 2³²), com as flags de `sub` 0, rb: C = 1 só se `rb = 0`; V = 1 só se `rb = 0x80000000`, que continua `0x80000000`.
`neg rd` = `neg rd, rd`.

## cmp
grupo: comparação
resumo: Compara `ra` com `rb`: calcula `ra − rb` só para as flags, sem gravar registrador.
sintaxe: cmp ra, rb
sintaxe: cmp ra, imm
exemplo: cmp r1, r2              ; flags de r1 - r2

Atualiza Z, N, C e V como SUB e descarta o resultado; em seguida use um desvio condicional.
Sem sinal: `bhs`/`blo`/`bhi`/`bls`; com sinal: `bge`/`blt`/`bgt`/`ble`; igualdade: `beq`/`bne`.
`cmp ra, imm` vira CMPI ou CMPL conforme o valor.

## cmpi
grupo: comparação
resumo: Compara `ra` com um imediato de 14 bits com sinal (flags de `ra − imm`).
sintaxe: cmpi ra, imm
exemplo: cmpi r6, 0              ; fim da string?

Flags Z, N, C, V de `ra − sext(imm14)`; nenhum registrador muda.
Valor já conhecido fora de −8192…8191: o assembler emite CMPL.

## cmpl
grupo: comparação
resumo: Compara `ra` com um imediato de 32 bits (flags de `ra − imm32`); 8 bytes.
sintaxe: cmpl ra, imm32
exemplo: cmpl r1, 100000         ; compara com 100000

Flags Z, N, C, V de `ra − imm32`; nenhum registrador muda.
Para constantes grandes ou endereços (`cmpl r1, fim`).

## mul
grupo: aritmética
resumo: Multiplica `ra` por `rb` e grava os 32 bits baixos em `rd`; atualiza Z e N.
sintaxe: mul rd, ra, rb
sintaxe: mul rd, ra, imm
exemplo: mul r1, r2, r3          ; r1 = r2 * r3

`rd = (ra × rb) mod 2³²` (o mesmo resultado com e sem sinal). Z e N do resultado; C e V preservados.
Parte alta do produto: MULH (com sinal) e MULHU (sem sinal).
Extensão M (`CAPS(0x4000)` bit 0): com `KSVM_ENABLE_MULDIV=0` dá fault BAD_OPCODE.
`mul rd, ra, imm` vira MULI, que não tem forma longa: o imediato precisa caber em 14 bits.

## muli
grupo: aritmética
resumo: Multiplica `ra` por um imediato de 14 bits com sinal; grava os 32 bits baixos em `rd`; atualiza Z e N.
sintaxe: muli rd, ra, imm
exemplo: muli r1, r1, 10         ; r1 *= 10

`rd = (ra × sext(imm14)) mod 2³²`; Z e N do resultado; C e V preservados.
Não há MULL: imediato fora de −8192…8191 é erro de montagem (use `li` + `mul`). Extensão M.

## mulh
grupo: aritmética
resumo: Grava em `rd` os 32 bits altos do produto com sinal de `ra` e `rb`; atualiza Z e N.
sintaxe: mulh rd, ra, rb
exemplo: mulh r2, r3, r4         ; parte alta do produto (com sinal)

`rd = bits 63..32 de (int64)ra × (int64)rb`; com `mul` dá o produto completo de 64 bits.
Z e N de `rd`; C e V preservados. Extensão M.

## mulhu
grupo: aritmética
resumo: Grava em `rd` os 32 bits altos do produto sem sinal de `ra` e `rb`; atualiza Z e N.
sintaxe: mulhu rd, ra, rb
exemplo: mulhu r2, r3, r4        ; parte alta do produto (sem sinal)

`rd = bits 63..32 de (uint64)ra × (uint64)rb`.
Base da aritmética de 64 bits em software. Z e N de `rd`; C e V preservados. Extensão M.

## div
grupo: aritmética
resumo: Divide `ra` por `rb` com sinal, truncando para zero, e grava em `rd`; atualiza Z e N.
sintaxe: div rd, ra, rb
exemplo: div r1, r2, r3          ; r1 = r2 / r3 (com sinal)

`rd = ra ÷ rb` com sinal, arredondando para zero (−7 ÷ 2 = −3).
`rb = 0` → fault DIV_ZERO (nada muda; `fault_addr` = pc).
`0x80000000 ÷ −1` = `0x80000000`, sem fault. Z e N do resultado; C e V preservados. Extensão M.

## divu
grupo: aritmética
resumo: Divide `ra` por `rb` sem sinal e grava o quociente em `rd`; atualiza Z e N.
sintaxe: divu rd, ra, rb
exemplo: divu r1, r2, r3         ; r1 = r2 / r3 (sem sinal)

`rd = ra ÷ rb` com os dois operandos sem sinal (0…2³²−1).
`rb = 0` → fault DIV_ZERO. Z e N do resultado; C e V preservados. Extensão M.

## rem
grupo: aritmética
resumo: Grava em `rd` o resto de `ra ÷ rb` com sinal (o resto tem o sinal do dividendo); atualiza Z e N.
sintaxe: rem rd, ra, rb
exemplo: rem r1, r2, r3          ; r1 = r2 % r3 (com sinal)

Como o `%` do C: −7 rem 2 = −1; 7 rem −2 = 1; `0x80000000 rem −1` = 0.
`rb = 0` → fault DIV_ZERO. Z e N do resultado; C e V preservados. Extensão M.

## remu
grupo: aritmética
resumo: Grava em `rd` o resto de `ra ÷ rb` sem sinal; atualiza Z e N.
sintaxe: remu rd, ra, rb
exemplo: remu r1, r2, r3         ; r1 = r2 % r3 (sem sinal)

`rd = ra mod rb` com os dois operandos sem sinal.
`rb = 0` → fault DIV_ZERO. Z e N do resultado; C e V preservados. Extensão M.

## and
grupo: lógica
resumo: Faz o E bit a bit de `ra` e `rb` e grava em `rd`; atualiza Z e N.
sintaxe: and rd, ra, rb
sintaxe: and rd, ra, imm
exemplo: and r1, r2, r3          ; r1 = r2 & r3

`rd = ra & rb`; Z e N do resultado, C e V preservados.
Com imediato o assembler usa ANDI (ou ANDL se não couber em 14 bits ou ainda não for conhecido).

## andi
grupo: lógica
resumo: E bit a bit de `ra` com um imediato de 14 bits (com o sinal estendido); grava em `rd`; atualiza Z e N.
sintaxe: andi rd, ra, imm
exemplo: andi r1, r1, 0xFF       ; isola o byte baixo

`rd = ra & sext(imm14)`: negativos estendem o sinal (−8 = `0xFFFFFFF8` limpa os 3 bits baixos).
Valor conhecido fora de −8192…8191 (como `0xFFFF`): o assembler emite ANDL. C e V preservados.

## andl
grupo: lógica
resumo: E bit a bit de `ra` com um imediato de 32 bits; grava em `rd` (8 bytes); atualiza Z e N.
sintaxe: andl rd, ra, imm32
exemplo: andl r1, r1, 0xFFFF     ; zera os 16 bits altos

`rd = ra & imm32`; Z e N do resultado, C e V preservados.
É a forma longa de ANDI, escolhida pelo assembler quando o imediato não cabe em 14 bits.

## or
grupo: lógica
resumo: Faz o OU bit a bit de `ra` e `rb` e grava em `rd`; atualiza Z e N.
sintaxe: or rd, ra, rb
sintaxe: or rd, ra, imm
exemplo: or r1, r2, r3           ; r1 = r2 | r3

`rd = ra | rb`; Z e N do resultado, C e V preservados.
Com imediato o assembler usa ORI (ou ORL).

## ori
grupo: lógica
resumo: OU bit a bit de `ra` com um imediato de 14 bits (com o sinal estendido); grava em `rd`; atualiza Z e N.
sintaxe: ori rd, ra, imm
exemplo: ori r1, r1, 0x20        ; liga o bit 5 (minúscula ASCII)

`rd = ra | sext(imm14)`; um imediato negativo liga também todos os bits altos.
Valor conhecido fora de −8192…8191: o assembler emite ORL. C e V preservados.

## orl
grupo: lógica
resumo: OU bit a bit de `ra` com um imediato de 32 bits; grava em `rd` (8 bytes); atualiza Z e N.
sintaxe: orl rd, ra, imm32
exemplo: orl r1, r1, 0x80000000  ; liga o bit 31

`rd = ra | imm32`; Z e N do resultado, C e V preservados.
É a forma longa de ORI.

## xor
grupo: lógica
resumo: Faz o OU exclusivo bit a bit de `ra` e `rb` e grava em `rd`; atualiza Z e N.
sintaxe: xor rd, ra, rb
sintaxe: xor rd, ra, imm
exemplo: xor r1, r2, r3          ; r1 = r2 ^ r3

`rd = ra ^ rb`; Z e N do resultado, C e V preservados.
`xor rd, rd, rd` zera e liga Z; `clr rd` zera sem mexer nas flags. Com imediato vira XORI (ou XORL).

## xori
grupo: lógica
resumo: OU exclusivo de `ra` com um imediato de 14 bits (com o sinal estendido); grava em `rd`; atualiza Z e N.
sintaxe: xori rd, ra, imm
exemplo: xori r1, r1, -1         ; r1 = ~r1

`rd = ra ^ sext(imm14)`; com −1 inverte todos os bits.
Valor conhecido fora de −8192…8191: o assembler emite XORL. C e V preservados.

## xorl
grupo: lógica
resumo: OU exclusivo de `ra` com um imediato de 32 bits; grava em `rd` (8 bytes); atualiza Z e N.
sintaxe: xorl rd, ra, imm32
exemplo: xorl r1, r1, 0x80000000 ; inverte o bit de sinal

`rd = ra ^ imm32`; Z e N do resultado, C e V preservados.
É a forma longa de XORI.

## not
grupo: lógica
resumo: Grava em `rd` o complemento bit a bit de `rb`; atualiza Z e N.
sintaxe: not rd, rb
sintaxe: not rd
exemplo: not r1, r2              ; r1 = ~r2

`rd = ~rb`; Z e N do resultado, C e V preservados.
`not rd` = `not rd, rd` (doc 04 §7).

## shl
grupo: deslocamentos
resumo: Desloca `ra` para a esquerda por `rb & 31` bits e grava em `rd`; atualiza Z, N e C.
sintaxe: shl rd, ra, rb
sintaxe: shl rd, ra, n
exemplo: shl r1, r2, r3          ; r1 = r2 << (r3 & 31)

Contagem = `rb & 31` (deslocar por 32 é deslocar por 0); entram zeros à direita.
C = último bit que saiu (o bit `32 − n` de `ra`); com contagem efetiva 0 o valor não muda e C = 0. V preservado.
Com imediato vira SHLI.

## shli
grupo: deslocamentos
resumo: Desloca `ra` para a esquerda por `n` (0…31) bits e grava em `rd`; atualiza Z, N e C.
sintaxe: shli rd, ra, n
exemplo: shli r1, r1, 2          ; r1 *= 4

`rd = ra << n`; o assembler só aceita `n` em 0…31.
C = último bit que saiu; `n = 0` dá C = 0. V preservado.

## shr
grupo: deslocamentos
resumo: Desloca `ra` para a direita (lógico, entram zeros) por `rb & 31` bits; grava em `rd`; atualiza Z, N e C.
sintaxe: shr rd, ra, rb
sintaxe: shr rd, ra, n
exemplo: shr r1, r2, r3          ; r1 = r2 >> (r3 & 31), sem sinal

Divisão sem sinal por 2ⁿ; contagem = `rb & 31`.
C = último bit que saiu (o bit `n − 1` de `ra`); contagem 0 dá C = 0. V preservado. Com imediato vira SHRI.

## shri
grupo: deslocamentos
resumo: Desloca `ra` para a direita (lógico) por `n` (0…31) bits; grava em `rd`; atualiza Z, N e C.
sintaxe: shri rd, ra, n
exemplo: shri r1, r1, 24         ; byte alto para o byte baixo

`rd = ra >> n` com zeros entrando à esquerda; `n` em 0…31.
C = último bit que saiu; `n = 0` dá C = 0. V preservado.

## sar
grupo: deslocamentos
resumo: Desloca `ra` para a direita (aritmético, replica o bit 31) por `rb & 31` bits; grava em `rd`; atualiza Z, N e C.
sintaxe: sar rd, ra, rb
sintaxe: sar rd, ra, n
exemplo: sar r1, r2, r3          ; r1 = r2 >> (r3 & 31), com sinal

Divisão com sinal por 2ⁿ arredondando para −∞ (−7 sar 1 = −4, enquanto `div` dá −3).
C = último bit que saiu; contagem 0 dá C = 0. V preservado. Com imediato vira SARI.

## sari
grupo: deslocamentos
resumo: Desloca `ra` para a direita (aritmético) por `n` (0…31) bits; grava em `rd`; atualiza Z, N e C.
sintaxe: sari rd, ra, n
exemplo: sari r1, r1, 31         ; 0 se r1 >= 0, -1 se negativo

`rd = ra >> n` replicando o bit 31; `n` em 0…31.
C = último bit que saiu; `n = 0` dá C = 0. V preservado.

## rol
grupo: deslocamentos
resumo: Rotaciona `ra` para a esquerda por `rb & 31` bits e grava em `rd`; atualiza Z, N e C.
sintaxe: rol rd, ra, rb
exemplo: rol r1, r2, r3          ; bits que saem pelo topo voltam no bit 0

Contagem = `rb & 31`; C = o último bit que saiu pelo topo (que reentra no bit 0); contagem 0 dá C = 0. V preservado.
Não há forma com imediato: ponha a contagem num registrador (rotacionar à direita por n = à esquerda por 32 − n).

## ror
grupo: deslocamentos
resumo: Rotaciona `ra` para a direita por `rb & 31` bits e grava em `rd`; atualiza Z, N e C.
sintaxe: ror rd, ra, rb
exemplo: ror r1, r2, r3          ; bits que saem embaixo voltam no bit 31

Contagem = `rb & 31`; C = o último bit que saiu por baixo (que reentra no bit 31); contagem 0 dá C = 0. V preservado.
Não há forma com imediato.

## tst
grupo: comparação
resumo: Testa bits: calcula `ra & rb` só para as flags Z e N, sem gravar registrador.
sintaxe: tst ra, rb
sintaxe: tst ra, imm
exemplo: tst r1, r2              ; Z=1 se não há bit em comum

Z = 1 se `ra & rb` = 0; N = bit 31 de `ra & rb`; C e V preservados.
Depois: `beq` (nenhum bit) ou `bne` (algum bit). `tst ra, imm` vira TSTI.

## tsti
grupo: comparação
resumo: Testa `ra & imm` (imediato de 14 bits com sinal) só para as flags Z e N.
sintaxe: tsti ra, imm
exemplo: tsti r1, 1              ; Z=0 se r1 é ímpar

Flags Z e N de `ra & sext(imm14)`; C e V preservados; nenhum registrador muda.
Não há forma longa: o imediato precisa caber em −8192…8191 (senão, `li` + `tst`).

## sxb
grupo: bits
resumo: Estende o sinal do byte baixo de `rb` para 32 bits e grava em `rd`; atualiza Z e N.
sintaxe: sxb rd, rb
sintaxe: sxb rd
exemplo: sxb r1, r2              ; 0x80 vira 0xFFFFFF80

`rd = sext8(rb)`: o bit 7 é replicado nos bits 8–31. Z e N do resultado; C e V preservados.
`sxb rd` = `sxb rd, rd`.

## sxh
grupo: bits
resumo: Estende o sinal dos 16 bits baixos de `rb` para 32 bits e grava em `rd`; atualiza Z e N.
sintaxe: sxh rd, rb
sintaxe: sxh rd
exemplo: sxh r1, r2              ; 0x8000 vira 0xFFFF8000

`rd = sext16(rb)`: o bit 15 é replicado nos bits 16–31. Z e N do resultado; C e V preservados.
`sxh rd` = `sxh rd, rd`.

## zxb
grupo: bits
resumo: Zera os 24 bits altos de `rb` e grava em `rd` (`rb & 0xFF`); atualiza Z e N.
sintaxe: zxb rd, rb
sintaxe: zxb rd
exemplo: zxb r1, r2              ; r1 = r2 & 0xFF

`rd = rb & 0xFF` (conversão para `unsigned char`). Z e N do resultado (N sempre 0); C e V preservados.
`zxb rd` = `zxb rd, rd`.

## zxh
grupo: bits
resumo: Zera os 16 bits altos de `rb` e grava em `rd` (`rb & 0xFFFF`); atualiza Z e N.
sintaxe: zxh rd, rb
sintaxe: zxh rd
exemplo: zxh r1, r2              ; r1 = r2 & 0xFFFF

`rd = rb & 0xFFFF` (conversão para `unsigned short`). Z e N do resultado (N sempre 0); C e V preservados.
`zxh rd` = `zxh rd, rd`.

## clz
grupo: bits
resumo: Conta os zeros à esquerda de `rb` (32 se `rb = 0`) e grava em `rd`; atualiza Z e N.
sintaxe: clz rd, rb
sintaxe: clz rd
exemplo: clz r1, r2              ; r2 = 1 dá 31

Resultado em 0…32; `31 − clz(x)` é o índice do bit mais alto (log₂ inteiro).
Extensão B (`CAPS(0x4000)` bit 1, `KSVM_ENABLE_BITOPS`): desligada → fault BAD_OPCODE. C e V preservados.

## ctz
grupo: bits
resumo: Conta os zeros à direita de `rb` (32 se `rb = 0`) e grava em `rd`; atualiza Z e N.
sintaxe: ctz rd, rb
sintaxe: ctz rd
exemplo: ctz r1, r2              ; r2 = 8 dá 3

Resultado em 0…32: índice do bit 1 mais baixo.
Extensão B: desligada → fault BAD_OPCODE. C e V preservados.

## popcnt
grupo: bits
resumo: Conta os bits 1 de `rb` e grava em `rd`; atualiza Z e N.
sintaxe: popcnt rd, rb
sintaxe: popcnt rd
exemplo: popcnt r1, r2           ; 0xFF dá 8

Resultado em 0…32 (Z = 1 se `rb` = 0).
Extensão B: desligada → fault BAD_OPCODE. C e V preservados.

## jmp
grupo: controle
resumo: Salta para `rótulo` (relativo ao pc, alcance ±32 MiB).
sintaxe: jmp rótulo
exemplo: jmp fim                 ; desvio incondicional longo

`pc = PC_next + off24 × 4`: o deslocamento é em palavras, relativo à instrução seguinte.
O assembler exige alvo alinhado a 4 e dentro do código; `j rótulo` é sinônimo.
Não altera flags nem a pilha.

## jmpr
grupo: controle
resumo: Salta para o endereço que está em `rb`.
sintaxe: jmpr rb
exemplo: jmpr r5                 ; pc = r5 (tabela de saltos)

`pc = rb`. Alvo não múltiplo de 4 → fault PC_ALIGN; fora de região executável → PC_RANGE (os dois no fetch seguinte).
Para `switch` com tabela, ponteiros de função e retorno manual. Flags preservadas.

## bcond
grupo: controle
resumo: Desvia para `rótulo` se a condição vale nas flags (beq, bne, blt…); alcance ±2 MiB.
sintaxe: b<cond> rótulo
sintaxe: b.<cond> rótulo
sintaxe: b rótulo
exemplo: beq fim                 ; desvia se Z=1

Se `cond(flags)`: `pc = PC_next + off20 × 4`; senão segue para a próxima instrução. Não altera flags.
Não se escreve `bcond`: use o sufixo (`beq`, `b.ne`, `bhs`/`bcs`, `blo`/`bcc`…); `b`/`bal` é incondicional e `bnv` nunca desvia.
As 16 condições (campo de 4 bits) estão na tabela de condições da referência, com o significado depois de CMP e de FCMP.

## call
grupo: controle
resumo: Chama a sub-rotina `rótulo`: empilha o endereço de retorno e salta (±32 MiB).
sintaxe: call rótulo
exemplo: call fim                ; empilha PC_next e salta

`sp −= 4; [sp] = PC_next; pc = PC_next + off24 × 4`; volte com `ret`.
Pilha abaixo do limite → fault STACK (nada muda). Flags preservadas.
Convenção do kscc: argumentos em r1–r4, retorno em r1; r1–r15 podem ser destruídos pela função chamada, r16–r29 e fp não.

## callr
grupo: controle
resumo: Chama a sub-rotina cujo endereço está em `rb` (empilha o endereço de retorno).
sintaxe: callr rb
exemplo: callr r5                ; chamada indireta

`sp −= 4; [sp] = PC_next; pc = rb`, com `rb` lido antes do ajuste de `sp`.
Ponteiros de função e vtables (o kscc usa r5). Alvo desalinhado ou fora do código → fault no fetch seguinte; pilha cheia → STACK.

## ret
grupo: controle
resumo: Retorna de uma sub-rotina: desempilha o endereço de retorno para o `pc`.
sintaxe: ret
exemplo: ret                     ; pc = [sp]; sp += 4

`pc = [sp]; sp += 4`: `sp` precisa apontar para o endereço empilhado por `call`, então desempilhe antes o que a função empilhou.
Flags preservadas; `sp` inválido → fault MEM_RANGE; endereço desalinhado ou fora do código → fault no fetch seguinte.

## halt
grupo: sistema
resumo: Para a VM com código de saída `r1`.
sintaxe: halt
exemplo: halt                    ; termina com exit_code = r1

Status HALTED, `exit_code = r1`; o `ksvm` e a IDE terminam com o código `r1 & 0xFF`.
Equivale a `syscall EXIT`.

## trap
grupo: sistema
resumo: Gera o fault TRAP de propósito, com `fault_addr = imm` (assert/abort do programa).
sintaxe: trap imm
exemplo: trap 42                 ; fault TRAP com addr = 42

Imediato de 14 bits com sinal (−8192…8191), estendido em `fault_addr`.
A VM para com status FAULT e o pc fica na TRAP; `ksvm` e IDE saem com o código 78 (70 + 8).

## syscall
grupo: sistema
resumo: Chama o serviço do host número `imm` (0…16383): argumentos em r1–r6, retorno em r1 e erro em r2.
sintaxe: syscall NOME
sintaxe: syscall número
exemplo: syscall PUTC            ; escreve o byte de r1

Aceita o nome (`PUTC`, `GETS`, `EXIT`…) ou o número (14 bits sem sinal).
Retorno em r1 (−1 em erro) e código de erro em r2 (0 = ok); os demais registradores são preservados, exceto em MEM_INFO, que devolve r1–r4.
Syscall desconhecida não é fault: r1 = −1, r2 = NOSYS (1). A lista está na seção Syscalls da referência.

## brk
grupo: sistema
resumo: Ponto de parada no código: chama o hook de trace (o depurador da IDE para nela); sem trace é NOP.
sintaxe: brk
exemplo: brk                     ; para aqui no depurador

Com trace habilitado chama o hook e continua; com `--trace`, `--step` ou `--regs` o `ksvm` imprime `brk at pc=…` e os registradores.
Na IDE, com "parar em BRK" ligado (padrão) o depurador para antes dela. Não altera nada.

## wfi
grupo: sistema
resumo: Espera interrupção: devolve o controle ao host (status YIELD) e continua na fatia seguinte.
sintaxe: wfi
exemplo: wfi                     ; cede a vez ao host

Sem interrupções na v2.0: equivale a `syscall YIELD`; o pc já aponta para a instrução seguinte.
Base para interrupções (fase 5). Não altera registradores nem flags.

## fadd
grupo: float
resumo: Soma os floats binary32 de `ra` e `rb` e grava em `rd` (arredondamento RNE); não altera flags.
sintaxe: fadd rd, ra, rb
exemplo: fadd r1, r2, r3         ; r1 = r2 + r3 (float)

Floats IEEE 754 binary32 guardados como bits nos registradores inteiros; arredonda para o mais próximo, empate par.
NaN em algum operando ou `inf − inf` → NaN canônico `0x7FC00000`; overflow → ±inf; subnormais preservados.
Nunca gera fault nem altera flags; sem forma com imediato (carregue constantes com `fli`). Extensão F desligada → BAD_OPCODE.

## fsub
grupo: float
resumo: Subtrai os floats `ra − rb` e grava em `rd` (RNE); não altera flags.
sintaxe: fsub rd, ra, rb
exemplo: fsub r1, r2, r3         ; r1 = r2 - r3 (float)

`x − x = +0`; `inf − inf` e qualquer NaN → NaN canônico `0x7FC00000`.
Sem fault e sem flags; extensão F.

## fmul
grupo: float
resumo: Multiplica os floats `ra × rb` e grava em `rd` (RNE); não altera flags.
sintaxe: fmul rd, ra, rb
exemplo: fmul r1, r2, r3         ; r1 = r2 * r3 (float)

O sinal do resultado é o XOR dos sinais (inclusive em zeros); `0 × inf` → NaN canônico.
Overflow → ±inf; underflow → subnormal ou zero arredondado. Sem fault e sem flags.

## fdiv
grupo: float
resumo: Divide os floats `ra ÷ rb` e grava em `rd` (RNE); divisão por zero dá ±inf, sem fault.
sintaxe: fdiv rd, ra, rb
exemplo: fdiv r1, r2, r3         ; r1 = r2 / r3 (float)

`x ÷ ±0` = ±inf para x ≠ 0 (sinal = XOR dos sinais); `0 ÷ 0` e `inf ÷ inf` → NaN canônico.
Diferente de DIV, nunca gera fault. Não altera flags.

## fmin
grupo: float
resumo: Grava em `rd` o menor dos floats `ra` e `rb`; com um só NaN, devolve o outro operando.
sintaxe: fmin rd, ra, rb
exemplo: fmin r1, r2, r3         ; r1 = menor(r2, r3)

`FMIN(−0, +0)` = −0; os dois NaN → NaN canônico `0x7FC00000`; o operando não NaN volta com os bits intactos.
Como o `fminf` do C, mas com o sinal de zero garantido e um NaN sinalizador também ignorado. Sem fault e sem flags.

## fmax
grupo: float
resumo: Grava em `rd` o maior dos floats `ra` e `rb`; com um só NaN, devolve o outro operando.
sintaxe: fmax rd, ra, rb
exemplo: fmax r1, r2, r3         ; r1 = maior(r2, r3)

`FMAX(−0, +0)` = +0; os dois NaN → NaN canônico; o operando não NaN volta com os bits intactos.
Como o `fmaxf` do C, mas com o sinal de zero garantido e um NaN sinalizador também ignorado. Sem fault e sem flags.

## fsqrt
grupo: float
resumo: Grava em `rd` a raiz quadrada do float `rb` (RNE).
sintaxe: fsqrt rd, rb
sintaxe: fsqrt rd
exemplo: fsqrt r1, r2            ; r1 = sqrt(r2)

`√(−0)` = −0; negativo (inclusive −inf) → NaN canônico; `√(+inf)` = +inf.
`fsqrt rd` = `fsqrt rd, rd`. Sem fault e sem flags.

## fneg
grupo: float
resumo: Inverte o bit de sinal do float `rb` e grava em `rd`.
sintaxe: fneg rd, rb
sintaxe: fneg rd
exemplo: fneg r1, r2             ; r1 = -r2 (float)

`rd = rb ^ 0x80000000`: mexe só no sinal, inclusive em NaN (que não vira o canônico).
`fneg rd` = `fneg rd, rd`. Sem flags.

## fabs
grupo: float
resumo: Zera o bit de sinal do float `rb` e grava em `rd` (valor absoluto).
sintaxe: fabs rd, rb
sintaxe: fabs rd
exemplo: fabs r1, r2             ; r1 = |r2| (float)

`rd = rb & 0x7FFFFFFF`: mexe só no sinal, inclusive em NaN.
`fabs rd` = `fabs rd, rd`. Sem flags.

## frint
grupo: float
resumo: Arredonda o float `rb` para o inteiro mais próximo (empate para o par); resultado float em `rd`.
sintaxe: frint rd, rb
sintaxe: frint rd
exemplo: frint r1, r2            ; 2.5 vira 2.0, 3.5 vira 4.0

Preserva o sinal de zero (`FRINT(−0.5)` = −0); ±inf volta como está; NaN → canônico; |x| ≥ 2²³ já é inteiro.
O resultado continua float: para obter o inteiro, `ftoi` depois. Sem flags.

## ffloor
grupo: float
resumo: Arredonda o float `rb` para baixo (em direção a −inf); resultado float em `rd`.
sintaxe: ffloor rd, rb
sintaxe: ffloor rd
exemplo: ffloor r1, r2           ; -1.5 vira -2.0

Como o `floorf` do C: preserva o sinal de zero, ±inf como está, NaN → canônico.
Resultado float; sem flags.

## fceil
grupo: float
resumo: Arredonda o float `rb` para cima (em direção a +inf); resultado float em `rd`.
sintaxe: fceil rd, rb
sintaxe: fceil rd
exemplo: fceil r1, r2            ; 1.2 vira 2.0

Como o `ceilf` do C: `FCEIL(−0.5)` = −0; ±inf como está; NaN → canônico.
Resultado float; sem flags.

## ftrunc
grupo: float
resumo: Arredonda o float `rb` em direção a zero (descarta a fração); resultado float em `rd`.
sintaxe: ftrunc rd, rb
sintaxe: ftrunc rd
exemplo: ftrunc r1, r2           ; -1.7 vira -1.0

Como o `truncf` do C: `FTRUNC(−0.7)` = −0; ±inf como está; NaN → canônico.
Resultado float; sem flags.

## ftoi
grupo: float
resumo: Converte o float `rb` para inteiro com sinal (trunca para zero, satura) e grava em `rd`.
sintaxe: ftoi rd, rb
sintaxe: ftoi rd
exemplo: ftoi r1, r2             ; 3.9 vira 3, -3.9 vira -3

Valores ≥ 2³¹ (inclusive +inf) saturam em `0x7FFFFFFF`; ≤ −2³¹ (inclusive −inf) em `0x80000000`; NaN → 0.
Para arredondar ao mais próximo: `frint` antes. Sem fault e sem flags.

## ftou
grupo: float
resumo: Converte o float `rb` para inteiro sem sinal (trunca para zero, satura) e grava em `rd`.
sintaxe: ftou rd, rb
sintaxe: ftou rd
exemplo: ftou r1, r2             ; 3e9 vira 3000000000

Todo negativo dá 0 (−0.5 trunca para 0, −1 satura em 0); a partir de 2³² satura em `0xFFFFFFFF`; NaN → 0.
Sem fault e sem flags.

## itof
grupo: float
resumo: Converte o inteiro com sinal `rb` para float (RNE) e grava em `rd`.
sintaxe: itof rd, rb
sintaxe: itof rd
exemplo: itof r1, r2             ; -3 vira -3.0 (0xC0400000)

Exato até ±2²⁴; acima arredonda para o mais próximo, empate par: `ITOF(16777217)` = 16777216.0.
Sem flags.

## utof
grupo: float
resumo: Converte o inteiro sem sinal `rb` para float (RNE) e grava em `rd`.
sintaxe: utof rd, rb
sintaxe: utof rd
exemplo: utof r1, r2             ; 0xFFFFFFFF vira 4294967296.0

`UTOF(0xFFFFFFFF)` = 4294967296.0 (`0x4F800000`), pelo arredondamento RNE.
Sem flags.

## fcmp
grupo: float
resumo: Compara os floats `ra` e `rb` e ajusta Z, N, C e V (menor: N; igual: Z C; maior: C; NaN: C V).
sintaxe: fcmp ra, rb
exemplo: fcmp r1, r2             ; depois bmi/bls/bgt/bge/beq/bvs

a < b: N=1 (FLAGS `0x2`); a == b, inclusive +0 == −0: Z=1 C=1 (`0x5`); a > b: C=1 (`0x4`); algum NaN (unordered): C=1 V=1 (`0xC`).
Desvios como no C: `==` beq, `!=` bne, `<` bmi (ou blo), `<=` bls, `>` bgt, `>=` bge, unordered bvs.
Única instrução F que altera flags (sempre as quatro); exige dois registradores, sem imediato.

# Condições

## al
testa: sempre
inteiro: incondicional
float: sempre
resumo: sempre (incondicional)

`bal rótulo` é o mesmo que a pseudo-instrução `b rótulo`.

## eq
testa: Z=1
inteiro: a == b
float: igual (inclusive +0 == −0)
resumo: igual (Z=1)

## ne
testa: Z=0
inteiro: a != b
float: diferente: menor, maior ou unordered
resumo: diferente (Z=0)

## hs
apelidos: cs
testa: C=1
inteiro: a >= b sem sinal
float: maior, igual ou unordered
resumo: maior ou igual sem sinal (C=1)

Também escrito `bcs` (carry setado).

## lo
apelidos: cc
testa: C=0
inteiro: a < b sem sinal
float: menor
resumo: menor sem sinal (C=0)

Também escrito `bcc` (carry limpo).

## mi
testa: N=1
inteiro: resultado negativo
float: menor
resumo: negativo (N=1)

## pl
testa: N=0
inteiro: resultado não negativo
float: maior, igual ou unordered (não menor)
resumo: positivo ou zero (N=0)

## vs
testa: V=1
inteiro: overflow com sinal
float: unordered (algum NaN)
resumo: overflow (V=1)

## vc
testa: V=0
inteiro: sem overflow
float: ordenado (nenhum NaN)
resumo: sem overflow (V=0)

## hi
testa: C=1 e Z=0
inteiro: a > b sem sinal
float: maior ou unordered
resumo: maior sem sinal (C=1 e Z=0)

## ls
testa: C=0 ou Z=1
inteiro: a <= b sem sinal
float: menor ou igual
resumo: menor ou igual sem sinal (C=0 ou Z=1)

## ge
testa: N=V
inteiro: a >= b com sinal
float: maior ou igual
resumo: maior ou igual com sinal (N=V)

## lt
testa: N≠V
inteiro: a < b com sinal
float: menor ou unordered
resumo: menor com sinal (N≠V)

## gt
testa: Z=0 e N=V
inteiro: a > b com sinal
float: maior
resumo: maior com sinal (Z=0 e N=V)

## le
testa: Z=1 ou N≠V
inteiro: a <= b com sinal
float: menor, igual ou unordered
resumo: menor ou igual com sinal (Z=1 ou N≠V)

## nv
testa: nunca
inteiro: nunca desvia
float: nunca
resumo: nunca (reservado; comporta-se como NOP)

# Pseudo-instruções

## li
resumo: Carrega uma constante em `rd`: MOVI se cabe em 14 bits com sinal, senão MOVIL.
sintaxe: li rd, valor
expande: movi rd, valor (4 bytes) ou movil rd, valor (8 bytes)
exemplo: li r1, 100000           ; vira movil (não cabe em 14 bits)

`valor` pode ser expressão com rótulos; se depende de um rótulo ainda não definido no primeiro passo, o assembler assume a forma longa.
Não altera flags.

## la
resumo: Carrega em `rd` o endereço de `rótulo`.
sintaxe: la rd, rótulo
expande: movil rd, rótulo (com .pic: adrl rd, rótulo)
exemplo: la r2, _start           ; r2 = endereço de _start

Sempre 8 bytes. Sem `.pic` o endereço é absoluto; com `.pic` vira ADRL, relativo ao pc.
Não altera flags.

## fli
resumo: Carrega em `rd` os bits binary32 de um literal float.
sintaxe: fli rd, float
expande: movil rd, bits
exemplo: fli r1, 1.5             ; r1 = 0x3FC00000

Sempre a forma longa: `fli r1, 1` carrega 1.0 (`0x3F800000`), não o inteiro 1.
Literais: `1.5`, `-2e3`, `.5`, `0x1.8p1`, `inf`, `nan`, `-nan` (`0xFFC00000`); não aceita expressões nem símbolos; `1e39` é erro (fora do alcance de float).

## clr
resumo: Zera `rd` sem mexer nas flags.
sintaxe: clr rd
expande: mov rd, zr
exemplo: clr r5                  ; r5 = 0

Diferente de `xor rd, rd, rd`, que também zera mas altera Z e N.

## inc
resumo: Soma 1 a `rd`; atualiza Z, N, C e V.
sintaxe: inc rd
expande: addi rd, rd, 1
exemplo: inc r5                  ; r5 = r5 + 1

Flags de ADD (C = 1 ao passar de `0xFFFFFFFF` para 0).

## dec
resumo: Subtrai 1 de `rd`; atualiza Z, N, C e V.
sintaxe: dec rd
expande: subi rd, rd, 1
exemplo: dec r5                  ; r5 = r5 - 1 (Z=1 ao chegar a 0)

Flags de SUB: laço de contagem regressiva com `dec` + `bne`.

## b
resumo: Desvio incondicional para `rótulo` (alcance ±2 MiB).
sintaxe: b rótulo
expande: bal rótulo
exemplo: b fim                   ; sempre desvia

BCOND com a condição AL; para alvos mais distantes use `j`/`jmp` (±32 MiB).

## j
resumo: Salto incondicional para `rótulo` (alcance ±32 MiB).
sintaxe: j rótulo
expande: jmp rótulo
exemplo: j fim                   ; mesmo que jmp fim

Não altera flags.

# Formas abreviadas

## um-registrador
forma: not rd
expande: not rd, rd
resumo: Operações de dois operandos aceitam um só registrador, que é fonte e destino.
exemplo: not r1                  ; r1 = ~r1

Vale para `neg not sxb sxh zxb zxh clz ctz popcnt` e as F de um operando (`fsqrt fneg fabs frint ffloor fceil ftrunc ftoi ftou itof utof`); `mov`, `cmp`, `tst` e `fcmp` exigem os dois.

## imediato-em-r
forma: add rd, ra, imm
expande: addi rd, ra, imm (ou addl)
resumo: Mnemônicos de registrador aceitam imediato e viram a forma I (ou a L, se o valor não couber ou ainda não for conhecido).
exemplo: add r1, r1, 100000      ; vira addl

Pares: `add/addi`, `sub/subi`, `mul/muli`, `and/andi`, `or/ori`, `xor/xori`, `shl/shli`, `shr/shri`, `sar/sari`, `cmp/cmpi`, `tst/tsti`, `mov/movi`.
Formas longas: ADDL, ANDL, ORL, XORL, CMPL, MOVIL (SUBI usa ADDL com o imediato negado); MULI, TSTI e os shifts não têm.

## cmp-imediato
forma: cmp ra, imm
expande: cmpi ra, imm ou cmpl ra, imm
resumo: Comparação com constante: CMPI se cabe em 14 bits com sinal, senão CMPL.
exemplo: cmp r1, 10              ; vira cmpi

## subi-grande
forma: subi rd, ra, imm
expande: addl rd, ra, -imm
resumo: Não existe SUBL: imediato fora de −8192…8191 vira ADDL com o valor negado.
exemplo: subi r1, r1, 10000      ; vira addl r1, r1, -10000

Mesmo resultado e mesmo C (não-borrow); só V difere, com imm = −2³¹ (`0x80000000` negado é ele mesmo).
Com `subi` explícito o valor precisa ser conhecido no primeiro passo; `sub rd, ra, imm` assume ADDL para rótulo ainda não definido.

## push-lista
forma: push r1, r2, r3
expande: push r1 / push r2 / push r3
resumo: PUSH e POP aceitam uma lista e geram uma instrução por registrador, na ordem escrita.
exemplo: push r1, r2, fp         ; três PUSH

Desempilhe na ordem inversa: `pop fp, r2, r1`.

## indice-registrador
forma: ldw rd, [rb + rc]
expande: ldwx rd, [rb + rc]
resumo: Load/store com índice em registrador escolhe sozinho a variante X (formato R).
exemplo: ldw r1, [r2 + r3]       ; vira ldwx

## endereco-absoluto
forma: ldw rd, [rótulo]
expande: ldw rd, [zr + rótulo]
resumo: `[rótulo]` usa `zr` como base: só para endereços menores que 8192 (senão `la` e `[rN]`).
exemplo: ldw r1, [16]            ; palavra no endereço 16

## store-invertido
forma: stw ra, [rb + imm]
expande: stw [rb + imm], ra
resumo: Stores aceitam o registrador fonte antes ou depois do endereço.
exemplo: stw r1, [sp + 4]        ; o mesmo que stw [sp + 4], r1

# Diretivas

## .text
resumo: Seleciona a seção de código (região CODE, só leitura e execução).
sintaxe: .text
exemplo: .text                   ; instruções a partir daqui

É a seção inicial. Instruções só podem aparecer em `.text`; escrever nela em tempo de execução dá fault MEM_PERM.

## .rodata
resumo: Seleciona a seção de dados só de leitura (vai junto com `.text` na região CODE).
sintaxe: .rodata
exemplo: .rodata                 ; constantes a seguir

Para tabelas e strings constantes; o programa pode ler mas não escrever (MEM_PERM).

## .data
resumo: Seleciona a seção de dados inicializados na RAM.
sintaxe: .data
exemplo: .data                   ; variáveis inicializadas

A RAM começa alinhada a 16 bytes depois do código; dados aqui podem ser lidos e escritos.

## .bss
resumo: Seleciona a seção de dados zerados na RAM (só reserva espaço, não ocupa a imagem).
sintaxe: .bss
exemplo: .bss                    ; buffers zerados a seguir

Aceita `.space` (sem valor de preenchimento), `.align` e `.org`; dados inicializados (`.byte`, `.word`, `.float`, `.ascii`…) aqui são erro.

## .global
resumo: Marca símbolos como globais na tabela de símbolos do `.ksx` (debug).
sintaxe: .global símbolo [, símbolo…]
exemplo: .global _start          ; exporta _start na tabela

Um símbolo global que não é definido é erro de montagem. Com `-g` (padrão na IDE) todos os rótulos vão para a tabela.

## .globl
resumo: Sinônimo de `.global`.
sintaxe: .globl símbolo [, símbolo…]
exemplo: .globl _start           ; o mesmo que .global

## .equ
resumo: Define uma constante simbólica (também `nome = expr`).
sintaxe: .equ nome, expr
sintaxe: nome = expr
exemplo: .equ TAM, 64            ; TAM vale 64

Não ocupa memória; a expressão é avaliada em 32 bits e pode usar outros símbolos.

## .byte
resumo: Emite bytes (8 bits) com os valores da lista.
sintaxe: .byte v [, v…]
exemplo: .byte 'A', 0x41, 65     ; três bytes iguais

Cada valor precisa caber em −128…255; aceita caracteres `'c'` e expressões.
Também aceita strings na lista, sem terminador: `.byte "ab", 0` = `.asciz "ab"`.

## .half
resumo: Emite halfwords de 16 bits (little-endian).
sintaxe: .half v [, v…]
exemplo: .half 7, 0xFFFF         ; dois halfwords

Cada valor em −32768…65535; sem alinhamento automático (use `.align 2`).

## .word
resumo: Emite palavras de 32 bits (little-endian); aceita rótulos.
sintaxe: .word v [, v…]
exemplo: .word 1, 2, 0xFFFF_FFFF ; três palavras

Sem alinhamento automático (use `.align 4` antes, se precisar). Tabelas de endereços: `.word caso0, caso1`.

## .float
resumo: Emite floats IEEE 754 binary32 (little-endian).
sintaxe: .float v [, v…]
exemplo: .float 1.5, -2e3, inf   ; três floats

Literais como os de `fli` (`0x1.8p1`, `nan`); proibido em `.bss`; sem alinhamento automático.

## .ascii
resumo: Emite os bytes de uma string, sem terminador.
sintaxe: .ascii "texto" [, "texto"…]
exemplo: .ascii "abc"            ; 3 bytes

Escapes `\n \t \r \0 \\ \" \' \xHH`; o texto é gravado em UTF-8.
Várias strings na mesma linha são gravadas em sequência, sem nada entre elas.

## .asciz
resumo: Emite os bytes de uma string terminada em `\0`.
sintaxe: .asciz "texto" [, "texto"…]
exemplo: .asciz "Olá\n"          ; string C terminada em 0

Escapes `\n \t \r \0 \\ \" \' \xHH`; acentos ocupam mais de um byte (UTF-8).
Com várias strings, cada uma recebe o seu `\0`.

## .space
resumo: Reserva `n` bytes (preenchidos com `fill`, padrão 0).
sintaxe: .space n [, fill]
exemplo: .space 16, 0xFF         ; 16 bytes 0xFF

Em `.bss` só reserva (sem `fill`). `n` precisa ser conhecido no primeiro passo; `fill` cabe num byte (−128…255).

## .align
resumo: Avança até o próximo múltiplo de `n` bytes (potência de 2).
sintaxe: .align n
exemplo: .align 4                ; alinha a 4 bytes

`n` de 1 a 65536; a seção inteira herda o maior alinhamento pedido. Instrução em endereço desalinhado é erro: use `.align 4` depois de dados em `.text`.

## .org
resumo: Avança até um deslocamento absoluto dentro da seção (só para frente).
sintaxe: .org endereço
exemplo: .org 0x40               ; continua no deslocamento 0x40

Os bytes pulados são zerados; voltar para trás é erro.

## .entry
resumo: Define o ponto de entrada do cabeçalho do `.ksx`.
sintaxe: .entry símbolo
exemplo: .entry _start           ; a execução começa em _start

Padrão: `_start`, se existir; senão o endereço 0. Só uma vez por programa; fora de `.text` ou desalinhado é erro.

## .stack
resumo: Define o tamanho da pilha (`stack_size`) do cabeçalho do `.ksx`.
sintaxe: .stack n
exemplo: .stack 1024             ; 1 KiB de pilha

Padrão 256 bytes; abaixo do limite PUSH/CALL dão fault STACK. Só uma vez por programa (a IDE pode sobrescrever em Opções).

## .include
resumo: Inclui o texto de outro arquivo, relativo ao arquivo que inclui.
sintaxe: .include "arquivo"
exemplo: .include "lib.ksasm"    ; insere lib.ksasm aqui

Inclusão textual: rótulos e constantes do arquivo incluído ficam visíveis; na IDE os nomes são os caminhos do explorador.

## .pic
resumo: Torna o código independente de posição: `la` vira ADRL e a imagem é marcada PIC.
sintaxe: .pic
exemplo: .pic                    ; la passa a gerar adrl

Vale para o arquivo todo (inclusive `la` antes da diretiva); endereços em `.word` continuam absolutos.

# Registradores

## zr
resumo: R0, sempre zero; escritas são descartadas (imposto pela VM).
abi: constante 0
preserva: —

Ler `zr` dá 0; usado como destino descarta o resultado (`sub zr, r1, r2` é uma comparação).
Base de `[rótulo]` para endereços pequenos; `clr rd` é `mov rd, zr`.

## r1
resumo: Registrador geral; pela convenção do kscc (não da ISA), argumento 1 e valor de retorno.
abi: acumulador; argumento 1; valor de retorno (as syscalls também devolvem em r1)
preserva: chamador

Apelido `a0`. HALT e `syscall EXIT` usam r1 como código de saída.

## r2
resumo: Registrador geral; pela convenção do kscc, argumento 2 (e código de erro depois de uma syscall).
abi: segundo operando; argumento 2; código de erro das syscalls
preserva: chamador

Apelido `a1`. Depois de uma syscall: 0 = ok, senão o código KSVM_ERR_*.
O doc 04 sugere r2 como segundo valor de retorno; o kscc devolve só em r1.

## r3-r4
resumo: Registradores gerais; pela convenção do kscc, argumentos 3 e 4.
abi: temporários; argumentos 3 e 4
preserva: chamador

Apelidos `a2` e `a3`. No kscc os argumentos do 5º em diante vão na pilha (nas funções variádicas, todos).

## r5-r15
resumo: Registradores gerais; pela convenção, temporários (caller-saved).
abi: temporários; r5 guarda o endereço em chamadas indiretas (`callr r5`)
preserva: chamador

Apelidos `t0`…`t10`. Uma função pode destruí-los: salve-os antes de `call` se precisar deles depois.

## r16-r29
resumo: Registradores gerais; pela convenção, preservados entre chamadas (callee-saved).
abi: reservados para alocação de registradores (o kscc v1 não os usa)
preserva: chamado

Apelidos `s0`…`s13`. Uma função que os usa salva e restaura (`push`/`pop`).

## fp
resumo: R30, frame pointer por convenção (para a VM é um registrador geral).
abi: frame pointer: base do quadro da função
preserva: chamado

Prólogo típico: `push fp` / `mov fp, sp`; epílogo: `mov sp, fp` / `pop fp`.

## sp
resumo: R31, stack pointer: usado por PUSH, POP, CALL, CALLR e RET; a pilha cresce para baixo.
abi: stack pointer, restaurado no epílogo
preserva: chamado

Descer abaixo do limite (`.stack`) com PUSH, CALL ou CALLR dá fault STACK.
Múltiplo de 4 por convenção (doc 04 §1): a VM não exige; os acessos à pilha não precisam de alinhamento.

# Registradores especiais

## PC
acesso: leitura (MFSR); escrita só por desvios
resumo: Contador de programa: endereço da instrução em execução.

`mfsr rd, PC` devolve o endereço da própria MFSR; JMP, JMPR, BCOND, CALL, CALLR e RET mudam o pc.
Só se executa em endereço múltiplo de 4: um desvio para endereço desalinhado dá fault PC_ALIGN no fetch seguinte.

## FLAGS
acesso: leitura e escrita (MFSR/MTSR)
resumo: Flags Z (bit 0), N (bit 1), C (bit 2) e V (bit 3); os bits 4–31 são lidos como 0.

Único SR gravável: `mtsr FLAGS, rb` grava `rb & 0xF`.

## ISA_VERSION
acesso: leitura
resumo: Versão da ISA: `0x0200` (2.0).

As extensões opcionais (M, B, F) não mudam a versão: são detectadas por `syscall CAPS` com `r1 = 0x4000`.

## INSN_COUNT
acesso: leitura
resumo: Número de instruções executadas desde a carga (32 bits, dá a volta).

Útil para medir trechos: leia antes e depois.

# Flags

## Z
bit: 0
resumo: Zero: o resultado é 0.

Comparações: Z = 1 quando os operandos são iguais (`beq`/`bne`).

## N
bit: 1
resumo: Negativo: bit 31 do resultado (negativo em complemento de dois).

`bmi`/`bpl`; depois de FCMP, N = 1 significa menor.

## C
bit: 2
resumo: Carry: vai-um da soma; na subtração e no CMP é o não-borrow (C = 1 se a ≥ b sem sinal); nos shifts, o último bit que saiu.

Convenção do ARM (não a do x86): `bhs`/`blo`/`bhi`/`bls` saem direto de C e Z. Shift com contagem 0 zera C.

## V
bit: 3
resumo: Overflow com sinal: o resultado não cabe em 32 bits com sinal.

Calculado só por ADD, SUB, ADC, SBC, NEG e CMP (inclusive ADDI, ADDL, SUBI, CMPI, CMPL) e por FCMP (V = 1 só em unordered); MTSR o grava.
As condições com sinal (`bge` `blt` `bgt` `ble`) comparam N com V; MUL, lógica e shifts preservam V.

# Formatos

## R
resumo: Três registradores: ra, rb e rc; func9 (bits 23–31) reservado e emitido zerado.
alcance: —

4 bytes. Operações de três operandos `rd, ra, rb` usam os campos ra, rb, rc; de dois (`rd, rb`), ra e rb.
A VM 2.0 ignora o conteúdo de func9 (não dá fault); assembladores o emitem zerado.

## I
resumo: Dois registradores e um imediato de 14 bits com sinal.
alcance: −8192…+8191

4 bytes. `rd, ra, imm` usa os campos ra, rb, imm14 (com sinal estendido para 32 bits).
O assembler aceita 0…16383 em SYSCALL, MFSR, MTSR, PUSHM e POPM (SYSCALL lê o campo sem sinal) e 0…31 nos shifts SHLI, SHRI e SARI.

## L
resumo: Dois registradores e um imediato de 32 bits na palavra seguinte (8 bytes).
alcance: 32 bits completos

Os bits 18–31 da primeira palavra são reservados: emitidos zerados e ignorados pela VM 2.0. O comprimento depende só do opcode.

## B
resumo: Desvio condicional: condição de 4 bits e deslocamento de 20 bits com sinal, em palavras.
alcance: ±512 K palavras = ±2 MiB, relativo a PC+4

Só BCOND (0x72) usa este formato.

## J
resumo: Salto: deslocamento de 24 bits com sinal, em palavras.
alcance: ±8 M palavras = ±32 MiB, relativo a PC+4

JMP (0x70) e CALL (0x73).

# Faults

## BAD_OPCODE
endereço: a palavra da instrução
resumo: Opcode inválido, reservado ou de extensão desligada; MFSR/MTSR com SR inválido; PUSHM/POPM.

Também 0xFF (flash apagada) e os opcodes F com `KSVM_ENABLE_FLOAT=0`.

## PC_ALIGN
endereço: o pc
resumo: O pc não é múltiplo de 4 (JMPR, CALLR ou RET para endereço desalinhado).

O fault acontece no fetch seguinte ao desvio.

## PC_RANGE
endereço: o endereço buscado
resumo: Fetch fora de uma região executável, ou instrução L com a segunda palavra fora da região.

Ex.: cair do fim do código sem HALT, ou saltar para a RAM.

## MEM_RANGE
endereço: o endereço efetivo
resumo: Load/store (ou PUSH, POP, CALL, CALLR, RET) fora de toda região mapeada.

O acesso inteiro precisa caber numa região: uma palavra que cruza a borda também falha.

## MEM_PERM
endereço: o endereço efetivo
resumo: Acesso sem permissão, como escrever na região de código (ROM).

## DIV_ZERO
endereço: o pc
resumo: DIV, DIVU, REM ou REMU com divisor 0.

FDIV não gera fault (dá ±inf ou NaN).

## STACK
endereço: o novo sp
resumo: PUSH, CALL ou CALLR levariam `sp` abaixo do limite da pilha (`stack_size`).

Recursão sem fim é o caso típico; aumente `.stack` se for legítimo.
Só com `KSVM_CHECK_STACK=1` (padrão na ksvm2 e na IDE); POP e RET não verificam o limite.

## TRAP
endereço: o código do TRAP/ABORT
resumo: Instrução TRAP ou syscall ABORT: término de propósito pelo programa.

# Syscalls

## EXIT
args: r1 = código
retorno: não retorna (status HALTED)
resumo: Termina o programa com o código de saída `r1`.

Como HALT; o processo sai com `r1 & 0xFF`.

## CAPS
args: r1 = número de syscall, ou 0x4000
retorno: r1 = 1 se existe, 0 se não; com 0x4000, a máscara de extensões; r2 = 0
resumo: Pergunta se uma syscall existe ou, com `r1 = 0x4000`, quais extensões da ISA a VM tem.

Máscara: bit 0 = M (MUL/DIV), bit 1 = B (CLZ/CTZ/POPCNT), bit 2 = F (float); a IDE responde 0x7.
Só conhece as syscalls do núcleo (grupos 0, 1, 2 e 5): as encaminhadas ao host (MICROS, grupos 3 e 4, ≥ 0x100) respondem 0 mesmo quando o host as implementa.
Outro valor acima de 0x3FFF responde 0.

## VERSION
args: —
retorno: r1 = major<<16 | minor<<8 | patch
resumo: Devolve a versão da VM.

## YIELD
args: —
retorno: —
resumo: Cede a vez ao host (status YIELD); a execução continua na instrução seguinte.

## ABORT
args: r1 = código
retorno: não retorna (fault TRAP)
resumo: Termina com erro: fault TRAP com `fault_addr = r1`.

## PUTC
args: r1 = byte
retorno: r1 = 0
resumo: Escreve o byte baixo de `r1` no console.

## GETC
args: —
retorno: r1 = byte, ou −1 (r2 = AGAIN sem dado, EOF no fim)
resumo: Lê um byte do console.

Na IDE, sem entrada a VM espera o teclado (com "stdin não bloqueante" devolve −1 e AGAIN).

## PUTS
args: r1 = ponteiro, r2 = tamanho
retorno: r1 = bytes escritos
resumo: Escreve `r2` bytes a partir do endereço `r1`.

Não procura terminador: passe o comprimento. Faixa inválida → r1 = −1, r2 = FAULT.

## GETS
args: r1 = ponteiro, r2 = máximo
retorno: r1 = bytes lidos (até o \n, incluso), 0 se nada, −1 no EOF
resumo: Lê uma linha para o buffer `r1`, no máximo `r2` bytes.

Não acrescenta terminador `\0`.

## MILLIS
args: —
retorno: r1 = milissegundos desde o boot (dá a volta em 2³²)
resumo: Relógio em milissegundos.

## SLEEP_MS
args: r1 = milissegundos
retorno: r1 = 0
resumo: Dorme `r1` milissegundos: o host espera, ou a VM cede a vez (YIELD) se o host não sabe dormir.

Na IDE a VM cede a vez e o worker retoma depois do prazo; a página não trava.

## MICROS
args: —
retorno: r1 = microssegundos
resumo: Relógio em microssegundos (opcional; a IDE implementa).

Vem do host (`hal->syscall`): sem ele, r1 = −1 e r2 = NOSYS; `CAPS` responde 0 mesmo na IDE.

## OPEN
args: r1 = caminho, r2 = tamanho, r3 = flags (RD=1, WR=2, CREAT=4, APPEND=8)
retorno: r1 = fd
resumo: Abre um arquivo (grupo 3; no navegador não existe: NOSYS).

## CLOSE
args: r1 = fd
retorno: r1 = 0
resumo: Fecha um arquivo (grupo 3; NOSYS no navegador).

## READ
args: r1 = fd, r2 = ponteiro, r3 = tamanho
retorno: r1 = bytes lidos
resumo: Lê de um arquivo (grupo 3; NOSYS no navegador).

## WRITE
args: r1 = fd, r2 = ponteiro, r3 = tamanho
retorno: r1 = bytes escritos
resumo: Escreve num arquivo (grupo 3; NOSYS no navegador).

## SEEK
args: r1 = fd, r2 = deslocamento, r3 = origem
retorno: r1 = nova posição
resumo: Posiciona um arquivo (grupo 3; NOSYS no navegador).

## PIN_MODE
args: r1 = pino, r2 = modo (0 entrada, 1 saída, 2 entrada com pull-up)
retorno: r1 = 0
resumo: Configura um pino de GPIO (grupo 4, microcontroladores; NOSYS no navegador).

## PIN_WRITE
args: r1 = pino, r2 = valor
retorno: r1 = 0
resumo: Escreve num pino de GPIO (grupo 4; NOSYS no navegador).

## PIN_READ
args: r1 = pino
retorno: r1 = valor
resumo: Lê um pino de GPIO (grupo 4; NOSYS no navegador).

## ANALOG_READ
args: r1 = canal
retorno: r1 = 0…1023
resumo: Lê o conversor analógico (grupo 4; NOSYS no navegador).

## PWM_WRITE
args: r1 = pino, r2 = 0…255
retorno: r1 = 0
resumo: Ajusta o PWM de um pino (grupo 4; NOSYS no navegador).

## MEM_INFO
args: —
retorno: r1 = início da RAM, r2 = tamanho, r3 = início do heap (fim do .bss), r4 = limite da pilha
resumo: Informações do mapa de memória.

## RANDOM
args: —
retorno: r1 = 32 bits pseudoaleatórios
resumo: Número pseudoaleatório (xorshift32 determinístico).

# Erros de syscall

## OK
resumo: Sucesso.

## NOSYS
resumo: Syscall desconhecida ou serviço ausente no host.

## FAULT
resumo: Ponteiro ou faixa do guest inválida.

## INVAL
resumo: Argumento inválido.

## IO
resumo: Falha de E/S no host.

## AGAIN
resumo: Nada disponível agora (GETC sem dado).

## EOF
resumo: Fim da entrada.

# Mapa de opcodes

## 0x04
estado: removido
resumo: Era MOVHI (redundante com MOVIL); agora gera BAD_OPCODE.

## 0x80-0x9F
estado: reservado
resumo: Reservados para extensões futuras do núcleo.

## 0xB2-0xBF
estado: reservado
resumo: Reservados para a extensão F (ex.: FMADD, conversões de/para 64 bits).

## 0xC0-0xEF
estado: plataforma
resumo: Extensões específicas de plataforma (ex.: AVR_IO), nunca no núcleo.

## 0xF0-0xFF
estado: inválido
resumo: Inválidos para sempre; 0xFF (flash apagada) garante BAD_OPCODE.
