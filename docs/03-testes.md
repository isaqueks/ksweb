# 03 — Testes

`make test` roda tudo em Node, sem navegador (e antes faz `make all dist`).
O oráculo é o próprio `ksvm` nativo da ksvm2, construído em `build/native/`
pelo Makefile da ksvm2.

| Script | Casos | O que cobre |
|--------|------:|-------------|
| `test/run_node.js` | 100 | wasm × `ksvm` nativo e a API do ksweb, inclusive passo por cima / sair da função |
| `test/test_vt.js` | 60 | emulador VT puro (`web/vt.js`) |
| `test/test_format.js` | 10 | formatadores do depurador (`web/format.js`) |
| `test/test_lineedit.js` | 9 | teclado → bytes, editor de linha (`web/input.js`) com eco pelo VT e atalhos da IDE |
| `test/test_terminal.js` | 5 | `TerminalView` (`web/terminal.js`) num DOM falso: teclado, mensagens do runner, HTML escapado |
| `test/test_wasm_tools.js` | 58 | `ksas.wasm`/`ksdis.wasm` pelo shim WASI × `ksas`/`ksdis` nativos |
| `test/test_isa.js` | 9 | `isa.json` × `isa.def` e as tabelas do ksas |
| `test/test_asmtools.js` | 23 | erros (nomes normalizados), alcance dos `.include`, listing, mapa linha ↔ endereço, breakpoint movido, tokenizer, autocomplete, ajuda |
| `test/test_project.js` | 11 | explorador, IndexedDB falso e fallbacks, `.zip` e inflate |
| `test/test_srcmap.js` | 9 | linha atual ↔ linha da montagem com ChangeSets reais do CodeMirror (imagem desatualizada) |
| `test/test_worker.js` | 5 | o `worker.js` num contexto vm: passo por cima/sair da função com entrada pendente, Passo N, breakpoint |
| `test/check_dist.js` | 21 | `dist/`, `ksweb-single.html` e os dois workers pelo protocolo de mensagens |
| `test/browser_smoke.js` | opcional | a IDE num Chrome/Edge headless (`make test-browser`) |

Total do `make test`: 320 casos em 12 suítes.

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
- **Passo por cima / sair da função** (`test/progs/calls.ksasm`: recursão,
  chamadas aninhadas e `callr` indireto). A referência é independente do C:
  o trace do `ksvm --trace` nativo, sobre o qual o teste conta a
  profundidade (CALL/CALLR +1, RET -1). Para **cada** `call` do trace,
  `ksweb_frame_stop(0)` tem de parar no mesmo número de instruções e no
  mesmo pc que a referência (a instrução seguinte ao call); para **cada**
  instrução do programa, `ksweb_frame_stop(-1)` tem de parar onde a
  profundidade chega a -1 (ou terminar com código 11 no nível de `_start`).
  Mais: breakpoint no fundo da recursão e três "sair" sobem um nível por
  vez até o mesmo `pop`, com `r1` = 0, 1, 3; um breakpoint dentro da função
  interrompe o passo por cima.
- **Desempenho** (informativo): 5 milhões de instruções no caminho rápido
  (~50–80 M instruções/s em Node no WSL).

## `test_wasm_tools.js`

O `ksas.wasm` e o `ksdis.wasm` rodam pelo shim (`web/wasi.js`) com um FS
em memória, e o `ksas`/`ksdis` nativos de `build/native/` são o oráculo:

- todos os `.ksasm` de `ksvm2/examples/`, `ksvm2/examples/v1_ported/`,
  `examples/` e `test/progs/`, com e sem `-g`: `.ksx` **byte a byte
  idêntico**, listing (`-l`) idêntico, mesma stderr e mesmo código;
- `-D` e `-h`;
- 13 fontes com erro (mnemônico, operandos, registrador, rótulo duplicado
  e indefinido, imediato fora do alcance, string sem fim, instrução fora de
  `.text`, float, `.include` ausente, coluna depois de UTF-8, diretiva
  desconhecida, mais de 100 erros): mesma mensagem e código 1, e o listing
  apagado; arquivo inexistente, opção inválida, sem entrada, duas entradas
  (código 2);
- `ksdis.wasm`: listagem e `--raw` idênticas às nativas para cada imagem, e
  o round-trip do doc 07 com o par wasm (`ksdis --raw x | ksas` = `x`, com
  `-g` quando o texto pede); erros de imagem e de uso;
- o shim: `-o` criando arquivo em subpasta, caminhos com `./` e `../`,
  diretório como entrada, caminho fora da raiz, pasta inexistente, `Map` e
  objeto como FS, e um módulo wasm escrito à mão que importa um
  `fd_advise` não implementado (recebe `ENOSYS`) e sai por `proc_exit`;
- a **sonda** `test/wasi_probe.c`, compilada com a wasi-libc (roda pelo
  shim) e com a libc do host (num diretório de verdade): mesma saída,
  stderr, código e arquivos (truncar e escrever além do fim, `ftruncate`,
  `lseek` 0/1/2 e negativo, `writev`/`readv`, EOF, append, `O_EXCL`,
  diretórios, `./` e `..`, `unlink`/`rmdir`, argv UTF-8);
- `.float`/`fli` com `-nan`, `+nan`, `nan(...)` e 230 literais variados:
  imagem igual à nativa e os bits esperados (`-nan` = `0xFFC00000`).

## `test_isa.js`

Lê o `isa.def`, as tabelas `directives[]` do `parser.c` e `pseudos[]` do
`insn.c` com expressões regulares próprias (independentes do gerador) e
confere: todo `KSVM_OP` no `isa.json` com o mesmo opcode, formato, flags,
descrição e tamanho, e nada além; mesmo conjunto de diretivas e de
pseudo-instruções; cada `b<cond>`/`b.<cond>` monta com o código de
condição certo; cada syscall por nome monta com o número certo; cada
registrador e apelido vai para o campo certo; registradores especiais; e o
**snippet de cada instrução**, com operandos de exemplo, é aceito pelo
`ksas.wasm`.

## `test_asmtools.js`

- parser de erros (com/sem coluna, sem linha, resumo) e erros reais do
  `ksas.wasm` em arquivo incluído, com a coluna depois de caracteres UTF-8;
- **mapa linha ↔ endereço** de cada exemplo da ksvm2 contra o listing do
  `ksas` nativo lido por um parser independente (colunas fixas), e os bytes
  de cada linha de instrução contra a imagem; símbolos e `code_size`;
  linhas do `lib/io.ksasm` incluído;
- listing com `=`/equ, `.space` grande, `.bss`, dado em várias linhas;
- **breakpoint em linha sem código** (comentário, vazia, rótulo, dado) vai
  para a próxima linha com instrução; depois da última, `null`;
- `ksdis.wasm` com endereços e rótulos;
- **tokenizer**: instruções, registradores (todos os 32 e os que não são),
  pseudos, desvios, `syscall NOME`, `mfsr`, diretivas, strings e escapes
  inválidos, caracteres, equ, floats em `.float`/`fli`, números
  malformados, comentários `;` `#` `//`;
- **autocomplete**: rótulos do arquivo (função pura: prefixo,
  maiúsculas, sem o próprio rótulo, comentário e string não contam),
  contexto (início de comando, diretiva, operando, comentário, string) e
  opções (snippet do `add`, rótulos para desvio e `la`, registradores,
  syscalls, diretivas);
- palavra sob o cursor e ajuda (instrução, pseudo, desvio, diretiva,
  registrador, syscall, rótulo — inclusive "b" usado como rótulo).

## `test_project.js`

Explorador (novo, nomes inválidos, renomear levando principal,
breakpoints e abas, duplicar, excluir, principal reatribuído), JSON de ida
e volta, **IndexedDB falso** assíncrono (salvar, listar por data, "reabrir
a página" com outro `ProjectStore`, autosave visível, excluir, meta),
fallback para localStorage quando o IndexedDB falha e para memória com o
localStorage cheio e com os globais lançando `SecurityError`, `.zip` de ida
e volta com nomes UTF-8 (projeto numa pasta, arquivos sem extensão de
fonte, breakpoints e principal preservados), CRC corrompido,
inflate contra o zlib do Node em todos os níveis (stored, fixo, dinâmico),
`.zip` com pasta-raiz e entradas deflate, manifesto, e o zip gerado aberto
pelo `zipfile` do Python.

## `test_srcmap.js`

Carrega o bundle do CodeMirror num contexto `vm`, monta um fonte com o
`ksas.wasm` e o edita com transações reais (várias compostas, como a IDE
acumula): 3 linhas inseridas acima, linhas digitadas logo acima, Enter no
começo da linha, linhas apagadas acima, edição dentro da linha, a linha
apagada ou substituída inteira, edições abaixo e uma mistura. Confere que
o breakpoint na linha atual cai no mesmo endereço da imagem antiga, que a
linha nova é pendente (`null`), que o pc volta à linha atual certa (ou a
nenhuma, se a linha sumiu), a ida e volta das linhas, e que uma ChangeSet
que não bate com os textos dá "desconhecido".

## `test_worker.js`

Carrega `web/worker.js` num contexto `vm` do Node (`self`, `postMessage`,
`MessageChannel`) com o `ksvm.wasm` e um programa montado pelo
`ksas.wasm` (`_start` → `main` → `f`, que lê com `GETC`): passo por cima
que espera entrada e termina quando ela chega; F11 e Passo N durante essa
espera desligam a parada por profundidade (o Continuar seguinte vai até o
fim, o Passo N executa N instruções); sair da função em `_start` roda até o
fim; breakpoint dentro da função interrompe o passo por cima e o desliga.

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
ECH/DCH ao lado de caractere largo, DECSTBM com fundo além da tela,
combinantes limitados por célula, e a
escrita fora de banda (`outOfBand`) no meio de OSC/CSI do guest. O último caso roda o
`vtdemo` no wasm e confere a caixa, a barra (truecolor) e o texto final.

## `check_dist.js`

1. `dist/` tem tudo o que `index.html` referencia, os três `.wasm`, os dois
   workers, `wasi.js`, `isa.json`/`isa.js`, o CodeMirror e o
   `LICENSES.md`, e os exemplos; `index.html` sem URL externa.
2. `ksweb-single.html` não tem `<script src>` nem `<link href>`, nenhuma
   referência a recurso externo (`src/href=http`, `url(http`, `@import`,
   `import()`/`importScripts`/`fetch` de URL), e as únicas URLs no texto são
   os namespaces XML do CodeMirror e o comentário de licença; os três base64
   embutidos são iguais a `dist/ksvm.wasm`, `ksas.wasm` e `ksdis.wasm`; os
   dois workers e o editor estão inline; todos os `<script>` (e todos os
   `.js` de `dist/`) compilam (`vm.Script`).
3. O `isa.js` embutido é igual ao `dist/isa.json`, e todo exemplo embutido
   traz o fonte e cada arquivo que ele inclui.
4. Os scripts sem DOM extraídos do HTML rodam num contexto `vm`: o wasm
   embutido executa o exemplo embutido `hello` e o VT mostra a saída.
5. O código do worker da VM (o embutido no HTML e o de `dist/`) roda num
   `self` falso e é dirigido pelas mensagens do protocolo: `init`, `load`,
   `run`, saída, `waiting` → `input` → `eof`, depurador com breakpoint
   (`break`, `snapshot` com a janela de disassembly e o trace), `mem`,
   `step` (`stepped`) e `trace-export` no formato do `--trace`; mensagens
   mandadas antes do `ready`, `run` repetido com a VM andando (não encurta o
   prazo do `SLEEP_MS`), poll ligado com a VM esperando entrada (retoma), e
   `step {mode: over}` num call (para na instrução seguinte com a saída da
   função inteira), `over` numa instrução comum (um passo) e `out` de dentro
   da função.
6. O worker do assembler (embutido e de `dist/`) no `self` falso: um
   `assemble` mandado antes do `init` é atendido depois do `ready`; o `fib`
   com `lib/io.ksasm` monta numa imagem idêntica à do `ksas` nativo, com o
   mapa de linhas do arquivo incluído; um erro volta com linha e mensagem;
   `disassemble` devolve as linhas com endereço.

## `test_terminal.js`

`terminal.js` carregado num contexto `vm` com um DOM falso mínimo: no modo
raw F8/F10/Ctrl+F9 ficam com a página e as demais teclas vão ao guest;
Ctrl+Alt+C/Pause interrompem; modo linha com Enter e Ctrl+D; `writeSystem`
com um OSC do guest aberto; a saída `<img ...>` do guest vira texto
escapado no HTML da linha.


## `browser_smoke.js` (opcional)

Abre `ksweb-single.html` por `file://`, `index.html` por HTTP (servidor
embutido) e `index.html` por `file://` num Chrome/Edge headless pelo
DevTools Protocol (`make test-browser`, ou pelo Node do Windows:
`node test/browser_smoke.js --shots %TEMP%\ksweb-shots`). Em cada um:

- espera os workers e o editor; os exemplos pelo menu viram projetos e
  rodam: `hello` (saída e cabeçalho), `vtdemo` (a caixa DEC e a cor
  truecolor calculada), `float`, `maiusculas` no modo linha (Enter,
  Ctrl+D) e `ask_name` no modo raw;
- **roteiro da IDE** com teclas e cliques de verdade: abrir o exemplo
  `fib`, editar `COUNT = 20` para `5` (o lint termina sem erros), Ctrl+B
  (listing com `= 0x00000005` e desassembly), breakpoint clicando no gutter
  da linha do `call print_u32` (resolvido em `0x10`), F5 até parar com a
  linha destacada no editor, F10 por cima do call (linha seguinte, `0` no
  terminal, `r17 = 1`, registradores alterados, hexdump e pilha), F5 de
  novo e F11 para dentro (a aba `lib/io.ksasm` abre na linha do `subi sp`),
  Shift+F11 de volta ao chamador, breakpoint no rótulo `loop:` movido para
  a instrução seguinte (gutter e lista "movido"), Limpar e terminar (`0 1 1
  2 3`), antes disso **3 linhas inseridas acima dos breakpoints com a imagem
  antiga** (mesmos endereços nas linhas +3, breakpoint numa linha nova
  pendente, Ctrl+B com o código deslocado não troca o mapa, Continuar para
  na mesma instrução com a seta na linha nova), Ctrl+S e **recarregar a página** (o projeto editado volta do
  IndexedDB), breakpoint clicando numa instrução do Desassembly (vira o
  breakpoint da linha do fonte; o pc fica destacado no desassembly), e o
  **modo simples** (`hello.ksx` pelo seletor de arquivo roda direto e o
  centro mostra o desassembly); F1 abre e Esc fecha a ajuda;
- duas abas da IDE no mesmo banco: a que só está aberta, ao recarregar, não
  apaga o que a outra salvou;
- erro no principal não gera erros falsos no arquivo incluído aberto;
- `localStorage` e `IndexedDB` que lançam `SecurityError` (a IDE abre só em
  memória) e layout salvo corrompido (tipos errados, enorme, JSON inválido);
- confere o tema claro (terminal e editor) e a mensagem de orientação do
  `index.html` por `file://`; falha em qualquer exceção ou `console.error`.

`--shots DIR` salva screenshots. Precisa de Node 22+ (WebSocket global) e
de um Chrome/Edge; sem eles, pula.
