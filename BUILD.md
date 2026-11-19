# Build e testes (ambiente de desenvolvimento)

O toolchain fica no WSL (Ubuntu 24.04); não há compilador C no Windows.
Caminho do projeto no WSL: `/mnt/c/Users/isaque.kanitz/KSVM2/ksweb`.

    wsl.exe -e bash -lc 'cd /mnt/c/Users/isaque.kanitz/KSVM2/ksweb && make clean && make && make test && make dist' | tr -d '\0'

Ferramentas usadas:

- `clang` 18 com alvo `wasm32` e `wasm-ld` (lld): o núcleo e a API viram
  `build/ksvm.wasm` com `--target=wasm32 -std=c99 -O2 -ffreestanding
  -nostdlib` e `wasm-ld --no-entry`. **Sem Emscripten** e sem libc: o
  `string.h` mínimo de `src/include/` declara `memcpy/memmove/memset/memcmp`,
  implementados em `src/libc_min.c`. A cola JS é escrita à mão
  (`web/vmcore.js`). Avisos: as mesmas flags estritas da ksvm2
  (`-Wall -Wextra -Wpedantic -Wconversion -Wshadow -Wstrict-prototypes
  -Wmissing-prototypes -Werror`).
- `clang --target=wasm32-wasi` + **wasi-libc** (pacote `wasi-libc` do
  Ubuntu; não há wasi-sdk): `ksas.wasm` e `ksdis.wasm` com os caminhos
  explícitos

      clang --target=wasm32-wasi -isystem /usr/include/wasm32-wasi -nostdlib -std=c99 -O2 ... -c x.c
      wasm-ld /usr/lib/wasm32-wasi/crt1-command.o *.o -L/usr/lib/wasm32-wasi -lc --strip-debug -o x.wasm

  Variáveis: `WASI_SYSROOT` (padrão `/usr`), `WASI_INC`
  (`$(WASI_SYSROOT)/include/wasm32-wasi`), `WASI_LIB`
  (`$(WASI_SYSROOT)/lib/wasm32-wasi`). Os fontes vêm direto da ksvm2
  (`src/tools/ksas/*.c`, `src/tools/ksdis/*.c`, `src/tools/toolio.c` e o
  núcleo), sem nenhum `#define`, com as mesmas flags de aviso e `-Werror`;
  o único ajuste é `src/wasi_strtof.c`, ligado ao `ksas.wasm` com
  `wasm-ld --wrap=strtof`: o `strtof` da wasi-libc (musl) ignora o sinal de
  `-nan` e a imagem sairia diferente da nativa (`-nan` = `0xFFC00000`); não faltou nenhum símbolo `__*` (não há compiler-rt para WASI
  nesta máquina, e não foi preciso). O `ksas` usa a config padrão do núcleo
  e o `ksdis` a das ferramentas (`-DKSVM_ENABLE_TRACE=1
  -DKSVM_ENABLE_SYSCALL_FS=1`), como no Makefile da ksvm2.
- `gcc` + o Makefile da própria ksvm2, chamado com `BUILD` apontando para
  `build/native/` (nada é escrito na árvore da ksvm2): `ksas`, `ksvm`,
  `ksdis` e o `mkimg` dos testes de `ksvm2/tests/tools`. São o oráculo dos
  testes e o assembler dos exemplos. `tools/isadump.c` também é nativo
  (ligado aos fontes do `ksas`) e gera a tabela que vira `isa.json`.
- `node` 18+: testes, `tools/mkexamples.js`, `tools/mkisa.js`,
  `tools/mksingle.js`.
- `python3`: `make serve` e, se houver, um teste do `.zip` (`zipfile`).

Configuração do núcleo no `ksvm.wasm` (`src/ksvm_config_user.h`): trace
ligado (passo a passo, trace do depurador e BRK), MUL/DIV, BITOPS e
extensão F ligados, grupo 3 de syscalls (arquivos) desligado.

## Editor (CodeMirror 6)

`web/vendor/codemirror.bundle.js` é gerado **uma vez** e commitado; `make`
não depende de npm nem de rede. Para atualizar (versões fixas em
`tools/editor/package.json`, o que é exportado em `tools/editor/entry.js`):

    sh tools/build_editor.sh

O script instala os pacotes em `build/editor-src/` com o `npm`, empacota
com `npx esbuild --bundle --minify --format=iife --global-name=CM` e
imprime as versões instaladas — atualize `web/vendor/LICENSES.md` com elas
e rode `make test` e `make test-browser`. Funciona pelo Git Bash do Windows
ou pelo WSL com o `npm`/`npx` do Windows no `PATH` (os caminhos passados ao
esbuild são relativos para isso). Variáveis: `NPM`, `NPX`.

## Alvos

| Alvo | Descrição |
|------|-----------|
| `make` / `make all` | `wasm` + `wasi` + `isa` + `native` + `examples` |
| `make wasm` | `build/ksvm.wasm` |
| `make wasi` | `build/ksas.wasm` e `build/ksdis.wasm` |
| `make isa` | `build/web/isa.json` e `isa.js` |
| `make native` | `build/native/{ksas,tools/ksvm,tools/ksdis,mkimg}` |
| `make examples` | `build/examples/*.ksx` (de `ksvm2/examples/`, `ksvm2/examples/v1_ported/` e `examples/`) e `build/web/examples.js` (imagens e fontes) |
| `make test` | tudo de `docs/03-testes.md` (inclui `make dist`) |
| `make dist` | `dist/` + `dist/ksweb-single.html` |
| `make serve` | servidor estático em `dist/` (`PORT`) |
| `make test-browser` | `test/browser_smoke.js` (Chrome/Edge headless via DevTools Protocol; exige Node 22+, pula se faltar) |
| `make clean` | remove `build/` e `dist/` |

O teste de navegador roda melhor pelo Node do Windows (22), que acha o
Chrome:

    node test/browser_smoke.js --shots %TEMP%\ksweb-shots

Variáveis: `KSVM2_HOME` (padrão `../ksvm2`), `CLANG`, `WASM_LD`, `NODE`,
`PYTHON`, `HOSTCC`, `PORT`, `WASI_SYSROOT`, `WASI_INC`, `WASI_LIB`.

Regras: arquivos com LF (o `.gitattributes` força `eol=lf`), UTF-8 sem BOM.
Definição de verde: `make clean && make && make test && make dist`.
