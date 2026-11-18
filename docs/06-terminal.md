# 06 — Terminal

O terminal é uma grade de células (padrão 80×24, ou ajustada à janela; em
Opções) mantida por `web/vt.js`, um emulador VT100/xterm puro (sem DOM,
testado em `test/test_vt.js`), e desenhada por `web/terminal.js`.

## Modelo

- **Parser**: máquina de estados no estilo de vt100.net (Paul Williams):
  GROUND, ESC, ESC intermediário, CSI (parâmetros, intermediários,
  ignorar), OSC e strings DCS/SOS/PM/APC. CAN/SUB abortam qualquer
  sequência; ESC no meio de uma recomeça (inclusive dentro de OSC e de
  DCS/SOS/PM/APC sem terminador; `ESC \` é o ST); controles C0 dentro de CSI são
  executados. Sequências desconhecidas são consumidas inteiras sem
  aparecer na tela. OSC é limitado a 4096 caracteres; parâmetros, a 65535.
- **Tela**: linhas de células `{c, fg, bg, fl}`; cursor com "wrap
  pendente" na última coluna (como o xterm: `abcde` numa linha de 5 deixa o
  cursor na coluna 5 e só quebra no próximo caractere); região de rolagem;
  tela principal com histórico (5000 linhas) e tela alternativa sem
  histórico; tabulações a cada 8 (editáveis); G0/G1 com ASCII ou DEC special
  graphics.
- **UTF-8**: decodificador com estado entre escritas (um caractere pode
  chegar partido entre fatias de `putc`); bytes inválidos viram U+FFFD.
  Caracteres largos (CJK, Hangul, fullwidth, emoji) ocupam 2 células;
  combinantes (acentos, ZWJ, seletores de variação) juntam-se à célula
  anterior.
- **Nova linha**: LF faz CR+LF por padrão (como o `ONLCR` de um tty Unix,
  já que os programas da KSVM escrevem só `\n`); `CSI 20 l` (LNM desligado)
  volta ao LF puro.

## Sequências suportadas

### Controle (C0)
BEL (pisca a borda), BS, HT (até a próxima tabulação), LF, VT, FF (como LF),
CR, SO/SI (G1/G0), ESC, CAN, SUB.

### ESC
| Sequência | Função |
|-----------|--------|
| `ESC 7` / `ESC 8` | DECSC/DECRC: salva/restaura cursor, atributos, charset, modos de origem e wrap |
| `ESC c` | RIS: reset (o histórico fica) |
| `ESC D` / `ESC M` / `ESC E` | IND / RI / NEL |
| `ESC H` | HTS: tabulação na coluna |
| `ESC ( B`, `ESC ( 0`, `ESC ) B`, `ESC ) 0` | G0/G1 = ASCII ou DEC special graphics |
| `ESC # 8` | DECALN (tela de `E`) |
| `ESC =` / `ESC >` | teclado numérico de aplicação (registrado) |
| outros | consumidos |

DEC special graphics: `` ` `` ◆, `a` ▒, `f` °, `g` ±, `j` ┘, `k` ┐, `l` ┌,
`m` └, `n` ┼, `o`–`s` linhas de varredura, `q` ─, `t` ├, `u` ┤, `v` ┴,
`w` ┬, `x` │, `y` ≤, `z` ≥, `{` π, `|` ≠, `}` £, `~` ·.

### CSI
| Final | Nome | Final | Nome |
|-------|------|-------|------|
| `A` `B` `C` `D` | CUU CUD CUF CUB | `E` `F` | CNL CPL |
| `G` `` ` `` | CHA HPA | `H` `f` | CUP HVP (relativos à região com DECOM) |
| `d` | VPA | `a` `e` | HPR VPR |
| `J` 0 1 2 3 | ED (3 limpa o histórico) | `K` 0 1 2 | EL |
| `L` `M` | IL DL (dentro da região) | `@` `P` `X` | ICH DCH ECH |
| `S` `T` | SU SD | `b` | REP (repete o último caractere, já mapeado) |
| `I` `Z` | CHT CBT | `g` 0 3 | TBC |
| `m` | SGR (abaixo) | `n` 5 / 6 | DSR: responde `ESC[0n` / `ESC[linha;colunaR` no stdin |
| `c` | DA: responde `ESC[?1;2c` | `r` | DECSTBM: região de rolagem (fundo além da tela = última linha; topo >= fundo é ignorado); leva o cursor ao início |
| `s` `u` | SCP RCP | `h` `l` 4 / 20 | IRM (inserção) / LNM |
| `! p` | DECSTR (reset suave) | outros | consumidos |

CUU/CPL param na margem de cima da região e CUD/CNL na de baixo, a menos que
o cursor já comece além dessa margem (como `CursorUp/CursorDown` do xterm:
de baixo da região, CUU para na margem de cima). IL/DL e os movimentos do
cursor cancelam o wrap pendente. IND/LF
no fundo da região e RI no topo dela rolam só a região; só a rolagem com a
região começando na linha 1 da tela principal alimenta o histórico. Apagar
usa a cor de fundo atual (BCE, como o xterm).

### SGR (`CSI ... m`)
0 reset; 1 negrito (clareia as cores 0–7, como o xterm); 2 fraco; 3
itálico; 4 sublinhado (`4:0` desliga); 5/6 piscante; 7 inverso; 8 oculto; 9
riscado; 21 sublinhado; 22 sem negrito/fraco; 23 24 25 27 28 29 desligam
itálico, sublinhado, piscante, inverso, oculto, riscado; 30–37 / 40–47 e
90–97 / 100–107 (16 cores do tema); 38;5;n / 48;5;n (256 cores); 38;2;r;g;b /
48;2;r;g;b (truecolor); as formas com dois-pontos (`38:5:n`,
`38:2::r:g:b`); 39 / 49 cor padrão. Índice acima de 255, componente acima de
255 ou parâmetros faltando (`38;5`, `38;2;1;2`): a cor é ignorada e os
parâmetros são consumidos, como no xterm.

### Modos privados (`CSI ? n h/l`)
`1` DECCKM (setas em SS3), `6` DECOM, `7` autowrap, `25` cursor visível,
`47` / `1047` / `1049` tela alternativa (1049 salva o cursor e limpa),
`1048` salva/restaura cursor, `2004` colagem entre colchetes (o colar envia
`ESC[200~ … ESC[201~`). Aceitos e ignorados: `12` (cursor piscante),
`1000`–`1006` (mouse) e demais.

### OSC
`ESC ] 0 ; título BEL` (ou terminado por ST, `ESC \`) e `2 ; título`
mudam o rótulo de título acima do terminal. Outros OSC (52, 8, 777...) são
consumidos até BEL/ST.

## Teclado → stdin

**Modo linha** (padrão): eco local e edição antes de enviar (←/→, Home/End,
Backspace, Delete, Ctrl+A/E/U/W/H). Enter envia a linha com `\n`; Ctrl+D
numa linha vazia envia EOF e, com texto, envia o texto sem `\n` (como um tty
Unix); Ctrl+C mostra `^C`, descarta a linha e envia 0x03. Colar envia cada
linha completa e deixa o resto para editar.

**Modo raw**: cada tecla vai direto, sem eco (o programa ecoa se quiser).

| Tecla | Bytes |
|-------|-------|
| Enter | `\r` (`\n` no modo linha) |
| Backspace | `0x7F` (opção: `0x08`) |
| Tab / Shift+Tab | `\t` / `ESC[Z` |
| Esc | `ESC` |
| ↑ ↓ → ← | `ESC[A` `ESC[B` `ESC[C` `ESC[D` (`ESC O A`… com DECCKM) |
| Home / End | `ESC[H` / `ESC[F` |
| Insert / Delete / PgUp / PgDn | `ESC[2~` `ESC[3~` `ESC[5~` `ESC[6~` |
| F1–F4 | `ESC O P` … `ESC O S` |
| F5–F12 | `ESC[15~` `17~` `18~` `19~` `20~` `21~` `23~` `24~` (F8, F10 e Ctrl+F9 ficam com a página) |
| com Shift/Alt/Ctrl | parâmetro xterm: `ESC[1;5C` (Ctrl+→), `ESC[3;2~` (Shift+Del) |
| Ctrl+letra | código de controle (Ctrl+C = 0x03, Ctrl+D = 0x04...), Ctrl+Espaço = 0x00, Ctrl+[ \ ] ^ _; Ctrl + caractere não ASCII não gera nada |
| Alt+tecla | `ESC` + tecla |

Atalhos da página (não vão ao guest, em nenhum dos modos; `pageShortcut`
em `input.js`): Ctrl+Alt+C ou Pause interrompe a VM;
Ctrl+C com texto selecionado copia; Ctrl+V/Cmd+V cola; Shift+PgUp/PgDn rola
o histórico; F8 executar/parar; F10 passo; Ctrl+F9 depurador.

As respostas de DSR/DA vão direto ao stdin do guest, nos dois modos.

## Renderização

Só as linhas sujas são redesenhadas (no próximo quadro de animação); a
linha do cursor é sempre redesenhada. Linhas que rolam para fora viram
`<div>` estáticas no histórico (escondido na tela alternativa). Células com
os mesmos atributos são agrupadas num `<span>`; as 16 cores vêm de
variáveis CSS do tema (claro/escuro), as de 256 cores e truecolor vão
inline. A seleção com o mouse copia texto puro (espaços finais das linhas
são omitidos). Mensagens do ksweb (`[ksweb] ...`) usam um atributo próprio,
fora da paleta do guest, e são escritas fora de banda (`VtScreen.outOfBand`):
uma sequência que o guest deixou aberta (OSC sem terminador, CSI partido)
não as engole e continua depois delas.

Limitações: sem IME/composição nem teclado virtual de celular; ao
redimensionar o texto não é refluído; a largura das células largas depende
da fonte monoespaçada (forçada a 2ch).
