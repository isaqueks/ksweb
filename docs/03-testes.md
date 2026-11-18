# 03 — Testes

`make test` roda tudo em Node, sem navegador (e antes faz `make all dist`).
O oráculo é o próprio `ksvm` nativo da ksvm2, construído em `build/native/`
pelo Makefile da ksvm2.

| Script | Casos | O que cobre |
|--------|------:|-------------|
| `test/run_node.js` | 97 | wasm × `ksvm` nativo e a API do ksweb |
| `test/test_vt.js` | 59 | emulador VT puro (`web/vt.js`) |
| `test/test_format.js` | 10 | formatadores do depurador (`web/format.js`) |
| `test/test_lineedit.js` | 8 | teclado → bytes e editor de linha (`web/input.js`) com eco pelo VT |
| `test/test_terminal.js` | 5 | `TerminalView` (`web/terminal.js`) num DOM falso: teclado, mensagens do runner, HTML escapado |
| `test/check_dist.js` | 16 | `dist/`, `ksweb-single.html` e `worker.js` pelo protocolo de mensagens |
| `test/browser_smoke.js` | opcional | página num Chrome/Edge headless (`make test-browser`) |

## `run_node.js`

Instancia `build/ksvm.wasm` com `vmcore.js` (imports reais, relógio falso) e
compara com `build/native/tools/ksvm` rodando o mesmo arquivo com a mesma
entrada e opções:

- **stdout** byte a byte, **código de saída** e **linha final** (`fault:
  NOME at pc=... addr=...`, limite com o pc, ou o nome do erro de imagem).
- **Exemplos**: todos os `.ksx` de `build/examples/` (os de
  `ksvm2/examples/`, `ksvm2/examples/v1_ported/` e `ksweb/examples/`), com
  entrada para os que leem stdin, cada um também com **trace**: o texto do
  anel de trace (`ksweb_trace_line`) tem de ser idêntico ao stderr do
  `ksvm --trace` (para programas com mais de 65536 instruções compara a
  cauda que o anel guarda).
- **Casos do `ksvm2/tests/tools/test_runner.sh`** que valem no navegador, com
  as imagens do `mkimg`: hello, halt42, fault (MEM_RANGE), trap,
  `--max-insns` (inclusive os limites exatos 3 e 4), stack ok e `--stack 8`
  (STACK), `--ram 64` (NO_RAM), imagem truncada, checksum corrompido, magic
  errado, arquivo vazio, `--ram 1k`, eco bloqueante e em poll, `files` (o
  grupo 3 não existe no navegador: comparado com `ksvm --no-fs`, código 11),
  trace com BRK (dump de registradores), rawedge, eco e limite. Ficam de
  fora os que testam a linha de comando, o `ksdis`/`ksimg`/`ksas` em si e o
  grupo 3 com arquivos reais.
- **RAM inválida** (0 e acima de 64 MiB → 64, como `ksvm --ram 0`).
- **Entrada**: suspensão sem girar (várias fatias seguidas em `WAIT_INPUT`
  sem nenhuma instrução executada e com o pc parado no `GETC`), retomada
  com entrada e EOF; `GETS` com a linha chegando aos pedaços (os bytes já
  copiados saem do anel e a saída bate com o nativo); modo poll com
  `YIELD`; entrada maior que o anel de 64 KiB; um único `GETS` de 200000
  bytes (`test/progs/bigread.ksasm`) com 100000 e 250000 bytes sem `\n`, e
  com a entrada chegando em pedaços de 7000; EOF imediato.
- **SLEEP_MS/YIELD**: o `vtdemo` cede 40 vezes com prazo de 25 ms.
- **MILLIS** (`test/progs/millis.ksasm`): recomeça perto de 0 a cada carga
  no mesmo `KsCore` ("desde o boot").
- **Trace com BRK em laço** (`test/progs/brkloop.ksasm`, 20 BRKs): idêntico
  ao `--trace` nativo, cada BRK com o dump de registradores, também num anel
  de 25 registros.
- **Cabeçalho** com `ram_base` desalinhado: `sp0` = sp do núcleo, e a
  execução comparada com o nativo.
- **Limite** exato de instruções com fatias menores que o limite.
- **`ksweb_step` + disasm × `ksdis`**: para cada exemplo, 400 passos; em
  cada pc o texto de `ksweb_disasm_at` tem de ser o da listagem do `ksdis`
  (exceto quando o `ksdis` troca o deslocamento de um desvio pelo nome do
  símbolo) e a sequência de pcs/instruções tem de ser a do trace nativo.
- **Depurador**: breakpoint para no pc certo e na contagem certa de
  instruções, para de novo a cada volta do laço (tantas vezes quanto o pc
  aparece no trace nativo), a saída fica intacta; tabela de 64
  breakpoints; parar em SYSCALL/BRK sem parar duas vezes na mesma
  instrução; breakpoint numa syscall de entrada não repete depois da
  espera; anel de trace com N configurável = os N últimos do trace nativo;
  fault deixa o pc na instrução culpada.
- **Memória**: `ksweb_header` contra os campos do arquivo; `ksweb_regions`
  (CODE R-X ROM em 0, RAM RW-); `ksweb_mem_read` do código e do `.data`
  contra o arquivo, o buraco entre CODE e RAM ilegível, leitura em vários
  pedaços e a volta no fim do espaço de endereços.
- **Registradores**: `cpu()`, e `format.regsDump` idêntico ao `ksvm
  --regs`.
- **Arena**: 50 reinícios com 8 MiB de RAM não fazem a memória crescer; RAM
  de 64 MiB com `memory.grow`.
- **Desempenho** (informativo): 5 milhões de instruções no caminho rápido
  (~50–80 M instruções/s em Node no WSL).

## `test_vt.js`

Alimenta sequências na `VtScreen` e confere grade, cursor e atributos:
controle (BS, HT, LF/VT/FF com e sem LNM, BEL), autowrap e o "wrap
pendente" da última coluna, `?7l`, CUP/HVP/CHA/VPA/CUU/CUD/CUF/CUB/CNL/CPL,
SCP/RCP e DECSC/DECRC com atributos, ED 0/1/2/3, EL 0/1/2, IL/DL, ICH/DCH,
ECH, SU/SD, REP, IRM, DSR 5/6 e DA (respostas), DECSTBM com rolagem
restrita à região (sem alimentar o histórico) e CUU/CUD presos nela, DECOM,
limite do histórico, IND/RI/NEL, SGR (todos os atributos e os
cancelamentos 22–29, 16/256 cores, truecolor, formas com `:`), erase com a
cor de fundo atual, paleta 256, `?25`, `?1049` e `?47`, modos aceitos e
ignorados, RIS, DEC special graphics por G0 e por G1 com SO/SI, DECALN, OSC
de título com BEL e ST, OSC/DCS/PM/APC desconhecidos consumidos,
sequências desconhecidas sem lixo na tela, controle dentro de CSI,
parâmetros enormes, UTF-8 partido byte a byte, UTF-8 inválido, largura
dupla (CJK, emoji, quebra na última coluna, sobrescrita de metade),
combinantes, redimensionamento e linhas sujas. Regressões da revisão: CUU/CUD
vindo de fora da região param na margem, IL/DL cancelam o wrap pendente,
SGR 38/48 inválido ou incompleto é ignorado, ESC aborta DCS/APC sem ST,
ECH/DCH ao lado de caractere largo, DECSTBM com fundo além da tela, e a
escrita fora de banda (`outOfBand`) no meio de OSC/CSI do guest. O último caso roda o
`vtdemo` no wasm e confere a caixa, a barra (truecolor) e o texto final.

## `check_dist.js`

1. `dist/` tem tudo o que `index.html` referencia, o wasm, o worker e os
   exemplos; `index.html` sem URL externa.
2. `ksweb-single.html` não tem `<script src>` nem `<link href>`, o base64
   embutido é igual a `dist/ksvm.wasm`, e todos os `<script>` (e todos os
   `.js` de `dist/`) compilam (`vm.Script`).
3. Os scripts sem DOM extraídos do HTML rodam num contexto `vm`: o wasm
   embutido executa o exemplo embutido `hello` e o VT mostra a saída.
4. O código do worker (o embutido no HTML e o de `dist/`) roda num `self`
   falso e é dirigido pelas mensagens do protocolo: `init`, `load`, `run`,
   saída, `waiting` → `input` → `eof`, depurador com breakpoint (`break`,
   `snapshot` com a janela de disassembly e o trace), `mem`, `step`
   (`stepped`) e `trace-export` no formato do `--trace`; mensagens mandadas
   antes do `ready` (atendidas depois dele, sem exceção), `run` repetido com
   a VM andando (não encurta o prazo do `SLEEP_MS`) e poll ligado com a VM
   esperando entrada (retoma).

## `test_terminal.js`

`terminal.js` carregado num contexto `vm` com um DOM falso mínimo: no modo
raw F8/F10/Ctrl+F9 ficam com a página e as demais teclas vão ao guest;
Ctrl+Alt+C/Pause interrompem; modo linha com Enter e Ctrl+D; `writeSystem`
com um OSC do guest aberto; a saída `<img ...>` do guest vira texto
escapado no HTML da linha.

## `browser_smoke.js` (opcional)

Abre `ksweb-single.html` por `file://`, `index.html` por HTTP (servidor
embutido) e `index.html` por `file://` num Chrome/Edge headless pelo
DevTools Protocol, e em cada um: espera o wasm, roda `hello`, `vtdemo`
(confere a caixa e a cor truecolor calculada), `float`, digita no
`maiusculas` (modo linha, Enter, Ctrl+D), usa o modo raw com o `ask_name`,
abre o depurador, põe um breakpoint clicando no disassembly, para nele,
dá um passo, confere registradores alterados, hexdump e pilha, remove o
breakpoint e termina; confere o tema claro; falha em qualquer exceção ou
`console.error`. `--shots DIR` salva screenshots. Precisa de Node 22+
(WebSocket global) e de um Chrome/Edge; sem eles, pula.
