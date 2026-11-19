# 07 — IDE

A página é uma IDE da KSVM: editor de assembly com realce, autocomplete e
erros em tempo real, montagem no próprio navegador com o `ksas` compilado
para WebAssembly, execução no terminal VT100 e depuração com breakpoints no
código-fonte. Funciona offline, inclusive no arquivo único
(`dist/ksweb-single.html`).

```
┌─ barra: ☰ Projeto · nome / arquivo · Montar ▶Executar Depurar ■Parar ↻Reiniciar · Continuar Passo Passo-dentro Sair · Exemplos Importar Exportar Opções ? ┐
├──────────────┬─────────────────────────────────────────────────┬──────────────────────────┤
│ Arquivos     │ abas: ★main.ksasm  lib/io.ksasm                 │ Depurador                │
│  lib/io.ksasm│ ┌─────────────────────────────────────────────┐ │  Registradores           │
│  main.ksasm ★│ │ editor (CodeMirror 6)                       │ │  Watch                   │
│              │ │ ● breakpoint  ➤ linha atual  · gera código  │ │  Breakpoints             │
│              │ └─────────────────────────────────────────────┘ │  Pilha                   │
│              │ Terminal | Problemas | Saída da montagem | Desassembly │  Memória · Trace  │
├──────────────┴─────────────────────────────────────────────────┴──────────────────────────┤
│ estado · pc · instruções e instr/s · mensagem ·              Ln, Col · arquivo · imagem · persistência │
└────────────────────────────────────────────────────────────────────────────────────────────┘
```

## Uso

1. **Escrever**: o projeto começa com um `main.ksasm` de exemplo. Novos
   arquivos pelo **＋** do explorador; `.include "lib/x.ksasm"` resolve
   relativo ao arquivo que inclui, como no `ksas` nativo (os nomes do
   explorador são os caminhos). O arquivo marcado com ★ é o principal: é ele
   que o `ksas` monta.
2. **Erros enquanto digita**: 300 ms depois da última tecla o projeto é
   montado no worker do assembler; os erros (`arquivo:linha:coluna: erro:
   ...`) aparecem sublinhados no editor, no gutter, nas abas e no
   explorador (✖), e no painel **Problemas** (clique leva à linha). Se o
   arquivo ativo não é alcançado pelo principal (uma biblioteca sem
   `.include`), ele é montado sozinho para o lint.
3. **Montar** (Ctrl+B): atualiza **Saída da montagem** (o listing do
   `ksas -l`), **Desassembly** (o `ksdis` da imagem) e as marcas `·` das
   linhas que geraram código (endereço no título).
4. **Executar** (F5): remonta se o fonte mudou, carrega e roda; a saída vai
   para o **Terminal**. **Depurar** carrega e para na primeira instrução.
5. **Breakpoints**: clique no gutter ou F9 na linha do cursor. Uma linha sem
   código (comentário, rótulo, dado, vazia) passa para a próxima linha com
   instrução do mesmo arquivo, como nas IDEs: a marca muda de lugar, a barra
   de status explica e a lista do depurador mostra "(movido da N)". Clicar
   numa instrução do **Desassembly** também liga um breakpoint (vira o da
   linha do fonte, quando há). Breakpoints por endereço/rótulo no campo do
   depurador (`0x1C`, `loop`, `pc+8`).
6. **Parado**: a aba do arquivo certo abre, a linha atual fica destacada e
   rola para o centro; os registradores alterados ficam amarelos; passar o
   mouse num registrador mostra o valor (hex, decimal, float); num rótulo,
   o endereço, onde foi definido e o conteúdo (word, bytes, texto); numa
   instrução, formato, operandos, flags e descrição; num número, as bases.
7. **Passos**: **Passo** (F10) passa por cima de `call`/`callr` (a VM roda
   até voltar à instrução seguinte; recursão e breakpoints no meio são
   respeitados); **Passo-dentro** (F11) executa uma instrução; **Sair**
   (Shift+F11) roda até o `ret` que sai da função atual; **Continuar** (F5)
   até o próximo breakpoint. Em todos, um breakpoint no caminho interrompe.
8. **Fonte editado depois da montagem**: uma faixa avisa que a imagem na
   VM está desatualizada; Executar/Reiniciar remontam. Enquanto isso a
   depuração continua certa: breakpoints e linha atual usam o mapa linha ↔
   endereço **da imagem carregada**, e as edições feitas desde aquela
   montagem são acompanhadas (as transações do editor). Inserir ou apagar
   linhas acima de um breakpoint o leva junto, e ele continua na mesma
   instrução da imagem; ao parar, a seta vai para a linha atual daquela
   instrução. Um breakpoint numa linha nova (que não existia na montagem)
   fica **pendente** (○ cinza no gutter, "linha nova: remonte" na lista) e
   não vai para a VM; se a linha do pc foi apagada ou reescrita inteira, a
   seta some e o Desassembly mostra o pc. Ctrl+B durante a depuração monta
   e atualiza o Desassembly, mas o mapa ativo só muda quando a nova imagem
   é carregada (Executar/Reiniciar).
9. **Watch**: digite um rótulo ou endereço; a cada parada mostra o endereço
   e o conteúdo como word, byte, float e string.

### Modo simples
Arrastar um `.ksx` para a página (ou ☰ → *Abrir e executar um .ksx*) roda a
imagem direto, sem fonte: o centro mostra o desassembly do `ksdis`, com
breakpoints por clique, e o depurador funciona por endereço. Clicar num
arquivo do explorador volta ao editor. Arrastar `.ksasm`/`.zip` importa.

### Exemplos
O seletor abre cada exemplo como um projeto (o fonte da ksvm2 com os
arquivos que ele inclui) e, com "executar ao abrir" ligado, monta e roda.
Reabrir um exemplo reabre o mesmo projeto, com as edições.

## Atalhos

| Tecla | Ação |
|-------|------|
| F5 | executar (remonta se preciso) / continuar |
| Shift+F5 | parar |
| Ctrl+Shift+F5 | reiniciar |
| F8 | executar/parar (como antes da IDE) |
| F9 | breakpoint na linha do cursor |
| F10 / F11 / Shift+F11 | passo por cima / para dentro / sair da função |
| Ctrl+B | montar |
| Ctrl+S | salvar agora (o projeto também é salvo sozinho) |
| Ctrl+F | buscar e substituir (Ctrl+G próxima, Esc fecha) |
| Ctrl+/ | comentar/descomentar com `;` |
| Ctrl+Espaço | sugestões |
| Ctrl+F9 | mostrar/esconder o depurador |
| F1 | ajuda com os atalhos |
| Ctrl+Alt+C / Pause | interromper a VM (no terminal) |

O terminal em **modo raw** pertence ao programa: as teclas que ele envia ao
guest (inclusive F5, F9, F11) não viram atalhos; só F8, F10, Ctrl+F9 e
Ctrl+Alt+C continuam com a página (06-terminal.md). Em modo linha, os
atalhos que o editor de linha não usa funcionam também no terminal. F11 e
Ctrl+Shift+F5 podem ser tomados pelo navegador ou pelo sistema em algumas
configurações: use os botões.

## Autocomplete

No início do comando: instruções da ISA (com assinatura, descrição, flags e
formato), pseudo-instruções (`li la fli clr inc dec b j`), desvios
`b<cond>` e diretivas; aceitar insere um snippet com os operandos (Tab
avança entre eles). Nos operandos: registradores (`zr r0..r31 fp sp`),
rótulos do arquivo atual e símbolos da última montagem (com endereço),
nomes de syscall depois de `syscall` (`PUTC`, `GETS`...) e registradores
especiais em `mfsr`/`mtsr`. O vocabulário vem de `isa.json`, gerado do
`isa.def` e das tabelas do `ksas` (01-arquitetura §8).

## Projetos e persistência

Os projetos ficam no IndexedDB do navegador (banco `ksweb-ide`, stores
`projects` e `meta`), com fallback para `localStorage` e, sem nenhum dos
dois (modo privado restrito), só em memória — a barra de status mostra qual.
O salvamento é automático (400 ms depois de cada mudança) e ao fechar a
página; ao reabrir, volta o último projeto. ☰ **Projeto** cria, abre,
renomeia e exclui projetos. Layout (tamanhos e painéis recolhidos), opções e
watches ficam no `localStorage`.

Formato salvo (JSON): `{id, name, main, files: [{name, text}], breakpoints:
{arquivo: [linhas]}, open: [abas], active, created, updated, example}`.

**Exportar** baixa `nome.zip` com os arquivos e um `ksweb-projeto.json`
(`{name, main, breakpoints}`); **Importar** aceita esse `.zip` (a pasta do
manifesto é a raiz do projeto e todos os arquivos voltam, com os nomes, o
principal e os breakpoints) ou qualquer `.zip` com `.ksasm/.asm/.s/.inc/.txt/.md`
(com ou sem pasta-raiz, entradas comprimidas ou não), arquivos de texto soltos (entram no projeto atual) e
`.ksx` (modo simples). ☰ também baixa os arquivos um a um e a imagem
`.ksx` montada.

## Limites

- Um arquivo de projeto é texto UTF-8; nomes com letras, dígitos, `_ . -` e
  `/` para pastas (sem `..`, aspas ou `\`, que o `.include` não aceitaria).
- Montagem com `-g` por padrão (todos os rótulos na tabela de símbolos do
  `.ksx`, para o depurador); desligável em Opções. A imagem exportada é a
  da última montagem.
- O passo por cima/sair da função conta `call`/`callr`/`ret` executados:
  uma função que volta por `jmpr` ou que desempilha o endereço de retorno à
  mão não é reconhecida (o passo roda até o fim ou até um breakpoint).
- Com a imagem desatualizada, uma linha editada só em parte continua
  sendo a instrução da imagem; uma linha substituída inteira (selecionar e
  digitar por cima, colar) conta como nova. Renomear, ou substituir um
  arquivo pela importação, deixa os breakpoints dele pendentes até
  remontar. O painel Desassembly mostra a última montagem (Ctrl+B), não
  necessariamente a imagem que está na VM.
- Sem `kscc` (C) no navegador e sem o grupo 3 de syscalls (arquivos):
  04-roadmap.md.
- Um só projeto aberto por aba do navegador; duas abas da IDE no mesmo
  navegador compartilham o banco e a última a salvar uma alteração vence
  (uma aba que só está aberta não grava nada ao fechar ou trocar de
  projeto).
