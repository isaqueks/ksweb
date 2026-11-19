# 04 — Roadmap

## Feito

### v1 — VM no navegador
- Núcleo da ksvm2 em wasm freestanding, API exportada, HAL web com
  suspensão por entrada e SLEEP_MS por `setTimeout`.
- Página com worker, terminal VT100/xterm, modo linha/raw, exemplos
  embutidos, arquivo único para `file://`.
- Depurador: registradores, disassembly com breakpoints, pilha, memória,
  trace exportável, paradas em BRK/SYSCALL.
- Testes em Node contra o `ksvm` nativo e fumaça opcional em Chrome.

### v2 — IDE (07-ide.md)
- `ksas` e `ksdis` da ksvm2 em WebAssembly (WASI, wasi-libc) com um shim
  WASI próprio e FS em memória; saída byte a byte idêntica à nativa.
- Editor CodeMirror 6 vendorizado com a linguagem ksasm, autocomplete,
  ajuda, lint em tempo real, busca e comentário.
- Projetos com vários arquivos e `.include`, explorador, abas, IndexedDB,
  importar/exportar `.zip`.
- Depuração em nível de fonte: breakpoints no editor, linha atual, passo
  por cima / para dentro / sair da função, watch, aviso de binário
  desatualizado.
- `isa.json` gerado do `isa.def` e das tabelas do `ksas`.

## Pendências

### `kscc` no navegador
Compilar C para `.ksx` na IDE (o kscc deriva do chibicc). O assembler já
está aqui; faltam:
- **trocar `fork/exec`**: o driver do kscc (`kscc/src/main.c`) roda as
  etapas como processos (`fork` + `execvp`). No WASI preview1 não há
  processos: o driver precisa de um modo "em processo" (chamar o montador
  como função, como o `ksas` já permite com `ksas_assemble`) ou a IDE
  encadeia os passos — `kscc -S` num módulo, o `.s` resultante para o
  `ksas.wasm` no FS em memória do shim;
- os headers e a libks no FS virtual do shim (arquivos embutidos ou
  baixados sob demanda); a libc que o compilador usa já é coberta pela
  wasi-libc.
Provavelmente outro módulo wasm, carregado sob demanda.

### Sistema de arquivos virtual (grupo 3 de syscalls)
`OPEN/CLOSE/READ/WRITE/SEEK` do guest sobre um FS em memória — o mesmo
modelo do shim WASI (`Map` caminho → bytes), com os arquivos do projeto
visíveis ao programa, arquivos criados por ele baixáveis no fim, fd 0/1/2
pré-abertos. Daria também um canal de stderr separado (`WRITE` no fd 2),
que hoje não existe: stdout e stderr saem pelo mesmo console. Exige ligar
`KSVM_ENABLE_SYSCALL_FS` e implementar o `hal_fs` na HAL web.

### Editor e IDE
- Macros (`.macro`/`.endm`) quando o ksas tiver (fase 5 da KSVM): realce e
  expansão no hover.
- Renomear rótulo em todos os arquivos; "ir para definição" (Ctrl+clique;
  o mapa de símbolos já tem arquivo e linha); referências.
- Breakpoints condicionais (`r1 == 5`), contagem de passagens, logpoints.
- Watchpoints de memória (o barramento já centraliza os acessos; exigiria
  um hook no núcleo ou uma região espelho).
- Edição de registradores e memória (hoje só leitura).
- Pilha de chamadas a partir do `fp` (a convenção dos exemplos permite).
- Mapa linha ↔ endereço dentro do `.ksx` (seção de debug), para depurar no
  fonte uma imagem carregada sem o projeto.
- Tema manual (claro/escuro/sistema) e tamanho da fonte do editor.
- Sincronização entre abas do navegador (BroadcastChannel) e
  armazenamento persistente (`navigator.storage.persist()`).

### Terminal e página
- IME/composição e teclado virtual de celular (a entrada hoje é por
  `keydown` num `<div>`; um `<textarea>` oculto resolveria).
- Reflow do texto ao redimensionar; seleção em modo retangular; busca no
  histórico.
- Relatar o tamanho do terminal ao guest (não há syscall para isso).
- Modo "poll inteligente": suspender só quando o guest gira em GETC sem
  fazer mais nada, para programas que leem teclado sem bloquear.

### Infra
- Rodar `browser_smoke.js` também com Firefox (WebDriver BiDi) e WebKit.
- Publicar `dist/` no GitHub Pages por CI.
- Regenerar o bundle do editor por CI quando `tools/editor/package.json`
  mudar, com verificação de licenças.
