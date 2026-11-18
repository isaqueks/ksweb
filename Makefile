# ksweb — a KSVM v2 em WebAssembly, com página de terminal e depurador.
#
#   make           build/ksvm.wasm, ferramentas nativas (oráculo) e exemplos
#   make test      testes em Node (wasm x ksvm nativo, VT, formatadores, dist)
#   make dist      dist/ autocontido + dist/ksweb-single.html
#   make serve     python3 -m http.server em dist/ (PORT=8000)
#   make clean
#
# O núcleo é compilado direto da árvore da ksvm2 (KSVM2_HOME), sem cópia.
# Toolchain: clang com alvo wasm32 + wasm-ld, sem Emscripten nem libc.

KSVM2_HOME ?= ../ksvm2
K          := $(abspath $(KSVM2_HOME))
BUILD      := build
DIST       := dist
NATIVE     := $(BUILD)/native
PORT       ?= 8000

CLANG   ?= clang
WASM_LD ?= wasm-ld
NODE    ?= node
PYTHON  ?= python3
HOSTCC  ?= gcc

WARN = -Wall -Wextra -Wpedantic -Wconversion -Wshadow \
       -Wstrict-prototypes -Wmissing-prototypes -Werror
WASM_CFLAGS = --target=wasm32 -std=c99 -O2 -ffreestanding -nostdlib \
              -fno-exceptions $(WARN) \
              -Isrc/include -Isrc -I$(K)/include -DKSVM_HAVE_USER_CONFIG
WASM_LDFLAGS = --no-entry --strip-debug -z stack-size=65536 \
               --export=__heap_base

CORE_SRC = $(wildcard $(K)/src/core/*.c)
WEB_SRC  = src/ksweb.c src/hal_web.c src/libc_min.c
CORE_OBJ = $(patsubst $(K)/src/core/%.c,$(BUILD)/wasm/core/%.o,$(CORE_SRC))
WEB_OBJ  = $(patsubst src/%.c,$(BUILD)/wasm/%.o,$(WEB_SRC))
WASM     = $(BUILD)/ksvm.wasm

# Oráculo nativo: o Makefile da própria ksvm2, com BUILD apontando para cá
# (nada é escrito na árvore da ksvm2).
KSAS   = $(NATIVE)/ksas
KSVM   = $(NATIVE)/tools/ksvm
KSDIS  = $(NATIVE)/tools/ksdis
NATIVE_DEPS = $(wildcard $(K)/src/core/*.c $(K)/src/hal/*.c $(K)/src/tools/*.c \n                          $(K)/src/tools/*/*.c $(K)/include/ksvm/*.h)
MKIMG  = $(NATIVE)/mkimg

EX_KSVM2 = $(wildcard $(K)/examples/*.ksasm $(K)/examples/v1_ported/*.ksasm)
EX_LOCAL = $(wildcard examples/*.ksasm)
EX_KSX   = $(patsubst %.ksasm,$(BUILD)/examples/%.ksx,$(notdir $(EX_KSVM2) $(EX_LOCAL)))
EX_JS    = $(BUILD)/web/examples.js

WEB_FILES = $(wildcard web/*)

.PHONY: all wasm native examples test test-node dist serve clean

all: wasm native examples

wasm: $(WASM)

$(BUILD)/wasm/core/%.o: $(K)/src/core/%.c src/ksvm_config_user.h
	@mkdir -p $(dir $@)
	@echo "  CC(wasm) $(notdir $<)"
	@$(CLANG) $(WASM_CFLAGS) -c $< -o $@

$(BUILD)/wasm/%.o: src/%.c src/ksweb.h src/hal_web.h src/ksvm_config_user.h
	@mkdir -p $(dir $@)
	@echo "  CC(wasm) $(notdir $<)"
	@$(CLANG) $(WASM_CFLAGS) -c $< -o $@

$(WASM): $(CORE_OBJ) $(WEB_OBJ)
	@$(WASM_LD) $(WASM_LDFLAGS) $^ -o $@
	@echo "ksvm.wasm: $$(wc -c <$@) bytes"

# ---- Oráculo nativo -------------------------------------------------------

native: $(KSAS) $(KSVM) $(MKIMG)

$(KSAS) $(KSVM) $(KSDIS) &: $(NATIVE_DEPS)
	@$(MAKE) --no-print-directory -C $(K) BUILD=$(abspath $(NATIVE)) ksas tools >/dev/null


$(MKIMG): $(K)/tests/tools/mkimg.c $(KSVM)
	$(HOSTCC) -std=c99 -O2 -I$(K)/include -DKSVM_ENABLE_TRACE=1 -DKSVM_ENABLE_SYSCALL_FS=1 \
	    $< $(NATIVE)/tools/libksvm.a -o $@

# ---- Exemplos -------------------------------------------------------------

examples: $(EX_KSX) $(EX_JS)

$(BUILD)/examples/%.ksx: $(K)/examples/%.ksasm $(KSAS)
	@mkdir -p $(dir $@)
	cd $(dir $<) && $(abspath $(KSAS)) $(notdir $<) -o $(abspath $@)

$(BUILD)/examples/%.ksx: $(K)/examples/v1_ported/%.ksasm $(KSAS)
	@mkdir -p $(dir $@)
	cd $(dir $<) && $(abspath $(KSAS)) $(notdir $<) -o $(abspath $@)

$(BUILD)/examples/%.ksx: examples/%.ksasm $(KSAS)
	@mkdir -p $(dir $@)
	cd $(dir $<) && $(abspath $(KSAS)) $(notdir $<) -o $(abspath $@)

$(EX_JS): $(EX_KSX) tools/mkexamples.js examples/menu.json
	@mkdir -p $(dir $@)
	$(NODE) tools/mkexamples.js examples/menu.json $(BUILD)/examples $(K)/examples examples >$@

# ---- Testes ---------------------------------------------------------------

test: all dist
	$(NODE) test/run_node.js --wasm $(WASM) --native $(NATIVE) --examples $(BUILD)/examples \
	    --ksvm2 $(K)
	$(NODE) test/test_vt.js
	$(NODE) test/test_format.js
	$(NODE) test/test_lineedit.js
	$(NODE) test/check_dist.js $(DIST)

# ---- Distribuição ---------------------------------------------------------

dist: $(DIST)/ksweb-single.html

$(DIST)/ksweb-single.html: $(WASM) $(EX_JS) $(EX_KSX) $(WEB_FILES) tools/mksingle.js
	@rm -rf $(DIST)
	@mkdir -p $(DIST)/examples
	cp web/* $(DIST)/
	cp $(WASM) $(EX_JS) $(DIST)/
	cp $(EX_KSX) $(DIST)/examples/
	$(NODE) tools/mksingle.js $(DIST) $@
	@echo "dist/: $$(ls $(DIST) | wc -l) arquivos; ksweb-single.html: $$(wc -c <$@) bytes"

serve: dist
	cd $(DIST) && $(PYTHON) -m http.server $(PORT)

clean:
	rm -rf $(BUILD) $(DIST)
