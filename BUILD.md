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
- `gcc` + o Makefile da própria ksvm2, chamado com `BUILD` apontando para
  `build/native/` (nada é escrito na árvore da ksvm2): `ksas`, `ksvm`,
  `ksdis` e o `mkimg` dos testes de `ksvm2/tests/tools`. São o oráculo dos
  testes e o assembler dos exemplos.
- `node` 18+: testes, `tools/mkexamples.js`, `tools/mksingle.js`.
- `python3`: só para `make serve`.

Configuração do núcleo no wasm (`src/ksvm_config_user.h`): trace ligado
(passo a passo, trace do depurador e BRK), MUL/DIV, BITOPS e extensão F
ligados, grupo 3 de syscalls (arquivos) desligado.

## Alvos

| Alvo | Descrição |
|------|-----------|
| `make` / `make all` | `wasm` + `native` + `examples` |
| `make wasm` | `build/ksvm.wasm` |
| `make native` | `build/native/{ksas,tools/ksvm,tools/ksdis,mkimg}` |
| `make examples` | `build/examples/*.ksx` (de `ksvm2/examples/`, `ksvm2/examples/v1_ported/` e `examples/`) e `build/web/examples.js` |
| `make test` | tudo de `docs/03-testes.md` (inclui `make dist`) |
| `make dist` | `dist/` + `dist/ksweb-single.html` |
| `make serve` | servidor estático em `dist/` (`PORT`) |
| `make test-browser` | `test/browser_smoke.js` (Chrome/Edge headless via DevTools Protocol; exige Node 22+, pula se faltar) |
| `make clean` | remove `build/` e `dist/` |

O teste de navegador roda melhor pelo Node do Windows, que acha o Chrome:

    node test/browser_smoke.js --shots %TEMP%\ksweb-shots

Variáveis: `KSVM2_HOME` (padrão `../ksvm2`), `CLANG`, `WASM_LD`, `NODE`,
`PYTHON`, `HOSTCC`, `PORT`.

Regras: arquivos com LF (o `.gitattributes` força `eol=lf`), UTF-8 sem BOM.
Definição de verde: `make clean && make && make test && make dist`.
