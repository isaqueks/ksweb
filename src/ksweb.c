/*
 * ksweb.c — API exportada do módulo wasm: ciclo de vida, execução em
 * fatias, entrada, registradores, disassembly, memória, breakpoints e trace
 * (docs/02-api.md). Uma instância estática; nenhuma libc.
 *
 * Memória: a RAM do guest e o buffer da imagem saem de uma arena simples
 * (bump allocator) acima de __heap_base, crescida com memory.grow;
 * ksweb_init esvazia a arena. A região CODE aponta para dentro do buffer
 * da imagem (sem cópia), como no runner nativo.
 *
 * Desempenho: sem breakpoints nem paradas por opcode, ksweb_run é só
 * ksvm_run(max) (o caminho rápido do núcleo); o laço instrução a instrução
 * com as checagens do depurador só roda quando elas estão ativas. O trace
 * usa o hook do núcleo e só é instalado quando ligado.
 */
#include <string.h>

#include "ksvm/disasm.h"
#include "ksvm/ksvm.h"
#include "hal_web.h"
#include "ksweb.h"

#define EXPORT(name) __attribute__((export_name(name)))

extern unsigned char __heap_base;

/* ---- Estado ----------------------------------------------------------- */

typedef struct trace_entry {
    uint32_t pc, word, imm32;
    uint16_t flags;
    uint16_t brk;                /* NO_BRK: passo; senão slot em brk_snaps */
} trace_entry;

typedef struct brk_snap {
    ksvm_cpu cpu;
    uint32_t insns;
    uint32_t seq;                /* número do registro de trace que o usa */
} brk_snap;

/* Cada BRK grava dois registros (BRK e o passo dele), então o anel de
 * trace tem no máximo KSWEB_TRACE_MAX / 2 BRKs: com um retrato para cada um,
 * todo BRK do anel sai com o dump de registradores, como no ksvm --trace.
 * (~4,7 MB de .bss: não entram no arquivo.) */
#define BRK_SNAPS (KSWEB_TRACE_MAX / 2u + 1u)
#define NO_BRK    0xFFFFu

static ksvm      vm;
static ksvm_hal  hal;
static ksweb_hal hw;

static uintptr_t arena_top;
static uint8_t  *ram;
static uint32_t  ram_size;
static uint32_t  stack_override;
static uint8_t  *image;
static uint32_t  image_size;
static bool      loaded;
static ksvm_image_header hdr;

static uint32_t  bps[KSWEB_MAX_BP];
static uint32_t  bp_count;
static uint32_t  stop_flags;
static uint32_t  stop_reason;
static bool      skip_once;      /* a próxima instrução passa sem checagens */

static trace_entry trace_ring[KSWEB_TRACE_MAX];
static brk_snap    brk_snaps[BRK_SNAPS];
static uint32_t    trace_cap;    /* 0 = desligado */
static uint32_t    trace_total;  /* registros gravados desde a limpeza */
static uint32_t    brk_next;

static uint32_t fault_info[3];
static uint32_t info_buf[24];
static char     text_buf[KSWEB_TEXT_BUF];
static uint8_t  input_stage[KSWEB_INPUT_STAGE];

/* ---- Arena ------------------------------------------------------------ */

#define PAGE 65536u

static bool ensure_memory(uintptr_t end)
{
    uintptr_t have = (uintptr_t)__builtin_wasm_memory_size(0) * PAGE;

    if (end > have) {
        uintptr_t pages = (end - have + PAGE - 1u) / PAGE;
        if (__builtin_wasm_memory_grow(0, pages) == (uintptr_t)-1) {
            return false;
        }
    }
    return true;
}

static void *arena_alloc(uint32_t n)
{
    uintptr_t p = (arena_top + 15u) & ~(uintptr_t)15u;

    if (n > 0x7FFFFFFFu || p + n < p || !ensure_memory(p + n)) {
        return NULL;
    }
    arena_top = p + n;
    return (void *)p;
}

/* ---- Trace ------------------------------------------------------------ */

static void trace_hook(void *ctx, const struct ksvm *v, ksvm_trace_event ev,
                       uint32_t pc, uint32_t word)
{
    trace_entry *e = &trace_ring[trace_total % trace_cap];

    (void)ctx;
    e->pc = pc;
    e->word = word;
    e->imm32 = 0u;
    e->flags = (uint16_t)(v->cpu.flags & 0xFFFFu);
    e->brk = NO_BRK;
    if (ev == KSVM_TRACE_BRK) {
        brk_snap *s = &brk_snaps[brk_next];
        s->cpu = v->cpu;
        s->insns = v->insn_count;
        s->seq = trace_total;
        e->brk = (uint16_t)brk_next;
        brk_next = (brk_next + 1u) % BRK_SNAPS;
    } else if (ksvm_disasm_len(word) == 8u) {
        (void)ksvm_bus_fetch32(&vm.bus, pc + 4u, &e->imm32);   /* já buscado pela VM */
    }
    trace_total++;
}

static void trace_install(void)
{
    ksvm_set_trace(&vm, (trace_cap != 0u) ? trace_hook : NULL, NULL);
}

/* Remove o último registro (syscall de entrada desfeita: ela vai se repetir). */
static void trace_pop(uint32_t pc)
{
    if (trace_cap != 0u && trace_total != 0u) {
        const trace_entry *e = &trace_ring[(trace_total - 1u) % trace_cap];
        if (e->pc == pc && e->brk == NO_BRK) {
            trace_total--;
        }
    }
}

/* ---- Formatação (sem stdio) ------------------------------------------- */

typedef struct out {
    char    *buf;
    uint32_t len, cap;
} out;

static void put_c(out *o, char c)
{
    if (o->len + 1u < o->cap) {
        o->buf[o->len++] = c;
    }
}

static void put_s(out *o, const char *s)
{
    while (*s != '\0') {
        put_c(o, *s++);
    }
}

static void put_hex(out *o, uint32_t v, unsigned digits)
{
    static const char hex[] = "0123456789ABCDEF";

    while (digits > 0u) {
        digits--;
        put_c(o, hex[(v >> (4u * digits)) & 0xFu]);
    }
}

static void put_dec(out *o, uint32_t v)
{
    char tmp[10];
    unsigned n = 0;

    do {
        tmp[n++] = "0123456789"[v % 10u];
        v /= 10u;
    } while (v != 0u);
    while (n > 0u) {
        put_c(o, tmp[--n]);
    }
}

static void pad_to(out *o, uint32_t start, uint32_t width)
{
    while (o->len - start < width && o->len + 1u < o->cap) {
        put_c(o, ' ');
    }
}

static void put_flags(out *o, uint32_t f)
{
    put_c(o, (f & KSVM_FLAG_Z) ? 'Z' : '-');
    put_c(o, (f & KSVM_FLAG_N) ? 'N' : '-');
    put_c(o, (f & KSVM_FLAG_C) ? 'C' : '-');
    put_c(o, (f & KSVM_FLAG_V) ? 'V' : '-');
}

/* Nome do registrador alinhado à direita em 3 colunas ("%3s"). */
static void put_reg_name(out *o, unsigned i)
{
    if (i == KSVM_REG_ZR) {
        put_s(o, " zr");
    } else if (i == KSVM_REG_FP) {
        put_s(o, " fp");
    } else if (i == KSVM_REG_SP) {
        put_s(o, " sp");
    } else {
        if (i < 10u) {
            put_c(o, ' ');
        }
        put_c(o, 'r');
        put_dec(o, i);
    }
}

/* Igual ao dump_regs de ksvm_main.c. */
static void put_regs(out *o, const ksvm_cpu *cpu, uint32_t insns)
{
    unsigned i;

    put_s(o, "pc=0x");
    put_hex(o, cpu->pc, 8u);
    put_s(o, " flags=");
    put_flags(o, cpu->flags);
    put_s(o, " insns=");
    put_dec(o, insns);
    put_c(o, '\n');
    for (i = 0; i < KSVM_NUM_REGS; i++) {
        put_reg_name(o, i);
        put_s(o, "=0x");
        put_hex(o, cpu->r[i], 8u);
        put_s(o, (i % 4u == 3u) ? "\n" : "  ");
    }
}

/* Igual ao trace_line de ksvm_main.c: "pc: bytes  instrução  flags". */
static void put_trace_step(out *o, const trace_entry *e)
{
    char text[KSVM_DISASM_BUF];
    uint32_t len = ksvm_disasm_len(e->word), i, col;

    (void)ksvm_disasm_one(e->pc, e->word, e->imm32, text, sizeof text);
    put_hex(o, e->pc, 8u);
    put_s(o, ": ");
    col = o->len;
    for (i = 0; i < len; i++) {
        uint32_t w = (i < 4u) ? e->word : e->imm32;
        if (i != 0u) {
            put_c(o, ' ');
        }
        put_hex(o, (w >> (8u * (i % 4u))) & 0xFFu, 2u);
    }
    pad_to(o, col, 23u);
    put_s(o, "  ");
    col = o->len;
    put_s(o, text);
    pad_to(o, col, 28u);
    put_c(o, ' ');
    put_flags(o, e->flags);
    put_c(o, '\n');
}

static uint32_t put_cstr_text(const char *s)
{
    out o = { text_buf, 0u, KSWEB_TEXT_BUF };

    put_s(&o, s);
    o.buf[o.len] = '\0';
    return (uint32_t)(uintptr_t)text_buf;
}

/* ---- Ciclo de vida ---------------------------------------------------- */

/* Nova VM vazia com ram_bytes de RAM (zerada). stack_bytes != 0 substitui
 * o stack_size da imagem, como "ksvm --stack". Esvazia a arena: ponteiros
 * de ksweb_alloc anteriores deixam de valer. */
EXPORT("ksweb_init")
int ksweb_init(uint32_t ram_bytes, uint32_t stack_bytes)
{
    arena_top = (uintptr_t)&__heap_base;
    loaded = false;
    image = NULL;
    image_size = 0u;
    ram = NULL;
    ram_size = 0u;
    stack_override = stack_bytes;
    skip_once = false;
    stop_reason = KSWEB_STOP_NONE;
    trace_total = 0u;
    brk_next = 0u;
    memset(&hdr, 0, sizeof hdr);
    ksweb_hal_init(&hw, &hal, &vm);
    ksvm_init(&vm, &hal);
    trace_install();
    if (ram_bytes == 0u || ram_bytes > KSWEB_MAX_RAM) {
        return KSVM_E_ARG;
    }
    ram = (uint8_t *)arena_alloc(ram_bytes);
    if (ram == NULL) {
        return KSWEB_E_NOMEM;
    }
    memset(ram, 0, ram_bytes);             /* a arena é reaproveitada */
    ram_size = ram_bytes;
    return KSVM_OK;
}

/* Buffer na arena para o JS copiar a imagem; 0 se não couber. */
EXPORT("ksweb_alloc")
uint32_t ksweb_alloc(uint32_t n)
{
    return (uint32_t)(uintptr_t)arena_alloc(n);
}

/* Carrega a imagem já copiada em [ptr, ptr+len). Devolve KSVM_OK ou o erro
 * do loader (KSVM_E_*). O buffer precisa viver enquanto a VM rodar. */
EXPORT("ksweb_load")
int ksweb_load(uint32_t ptr, uint32_t len)
{
    int err;

    if (ram == NULL || ptr == 0u) {
        return KSVM_E_ARG;
    }
    image = (uint8_t *)(uintptr_t)ptr;
    image_size = len;
    if (stack_override != 0u && len >= KSVM_KSX_HEADER_SIZE) {
        /* stack_size fica fora da faixa do checksum ([0x38, fim)). */
        ksvm_st32le(image + KSVM_KSX_OFF_STACK_SIZE, stack_override);
    }
    memset(&hdr, 0, sizeof hdr);
    (void)ksvm_image_parse(image, len, NULL, &hdr);
    err = ksvm_load_image(&vm, image, len, ram, ram_size);
    loaded = (err == KSVM_OK);
    return err;
}

/* ---- Execução --------------------------------------------------------- */

static uint32_t dbg_check(void)
{
    uint32_t pc = vm.cpu.pc, i, w = 0u;

    for (i = 0; i < bp_count; i++) {
        if (bps[i] == pc) {
            return KSWEB_STOP_BREAKPOINT;
        }
    }
    if (stop_flags != 0u && ksvm_bus_fetch32(&vm.bus, pc, &w) == KSVM_FAULT_NONE) {
        uint32_t op = w & 0xFFu;
        if (op == KSVM_OP_BRK && (stop_flags & KSWEB_STOPF_BRK) != 0u) {
            return KSWEB_STOP_BRK;
        }
        if (op == KSVM_OP_SYSCALL && (stop_flags & KSWEB_STOPF_SYSCALL) != 0u) {
            return KSWEB_STOP_SYSCALL;
        }
    }
    return KSWEB_STOP_NONE;
}

static int finish(void)
{
    if (ksweb_hal_rewind(&hw)) {
        trace_pop(vm.cpu.pc);
        skip_once = true;                  /* não parar de novo na mesma syscall */
        return KSWEB_WAIT_INPUT;
    }
    return (int)vm.status;
}

/* Executa até max_insns instruções (0 = sem limite) ou até parar. */
EXPORT("ksweb_run")
int ksweb_run(uint32_t max_insns)
{
    uint32_t done;

    if (!loaded) {
        return KSWEB_NOT_LOADED;
    }
    stop_reason = KSWEB_STOP_NONE;
    hw.sleep_ms = 0u;
    if (vm.status == KSVM_HALTED || vm.status == KSVM_FAULT) {
        return (int)vm.status;
    }
    if (bp_count == 0u && stop_flags == 0u) {
        skip_once = false;
        (void)ksvm_run(&vm, max_insns);    /* caminho rápido */
        return finish();
    }
    for (done = 0u; max_insns == 0u || done < max_insns; done++) {
        if (!skip_once) {
            uint32_t r = dbg_check();
            if (r != KSWEB_STOP_NONE) {
                stop_reason = r;
                skip_once = true;
                return KSWEB_BREAK;
            }
        }
        skip_once = false;
        if (ksvm_step(&vm) != KSVM_RUNNING) {
            break;
        }
    }
    return finish();
}

/* Uma instrução, sem checagens do depurador (é o próprio "Passo"). */
EXPORT("ksweb_step")
int ksweb_step(void)
{
    if (!loaded) {
        return KSWEB_NOT_LOADED;
    }
    stop_reason = KSWEB_STOP_NONE;
    hw.sleep_ms = 0u;
    (void)ksvm_step(&vm);
    skip_once = true;
    return finish();
}

EXPORT("ksweb_status")
int ksweb_status(void)
{
    return loaded ? (int)vm.status : KSWEB_NOT_LOADED;
}

EXPORT("ksweb_exit_code")   uint32_t ksweb_exit_code(void)   { return vm.exit_code; }
EXPORT("ksweb_sleep_ms")    uint32_t ksweb_sleep_ms(void)    { return hw.sleep_ms; }
EXPORT("ksweb_stop_reason") uint32_t ksweb_stop_reason(void) { return stop_reason; }
EXPORT("ksweb_insn_count")  uint32_t ksweb_insn_count(void)  { return vm.insn_count; }

/* Ponteiro para {código do fault (0 se não há), pc, addr}. */
EXPORT("ksweb_fault_info")
uint32_t ksweb_fault_info(void)
{
    fault_info[0] = (vm.status == KSVM_FAULT) ? (uint32_t)vm.fault : 0u;
    fault_info[1] = vm.cpu.pc;
    fault_info[2] = vm.fault_addr;
    return (uint32_t)(uintptr_t)fault_info;
}

/* Nome do fault ("MEM_RANGE"...) como C string em ksweb_text_buf(). */
EXPORT("ksweb_fault_name")
uint32_t ksweb_fault_name(uint32_t code)
{
    return put_cstr_text(ksvm_fault_name((ksvm_fault)code));
}

/* Nome de um código KSVM_E_* (como tool_err_name do runner nativo). */
EXPORT("ksweb_err_name")
uint32_t ksweb_err_name(int err)
{
    const char *s;

    switch (err) {
    case KSVM_OK:               s = "OK"; break;
    case KSVM_E_ARG:            s = "ARG"; break;
    case KSVM_E_FULL:           s = "FULL"; break;
    case KSVM_E_OVERLAP:        s = "OVERLAP"; break;
    case KSVM_E_RANGE:          s = "RANGE"; break;
    case KSVM_E_IMAGE_MAGIC:    s = "IMAGE_MAGIC"; break;
    case KSVM_E_IMAGE_VERSION:  s = "IMAGE_VERSION"; break;
    case KSVM_E_IMAGE_CHECKSUM: s = "IMAGE_CHECKSUM"; break;
    case KSVM_E_IMAGE_RANGE:    s = "IMAGE_RANGE"; break;
    case KSVM_E_IMAGE_ENTRY:    s = "IMAGE_ENTRY"; break;
    case KSVM_E_NO_RAM:         s = "NO_RAM"; break;
    case KSWEB_E_NOMEM:         s = "NOMEM"; break;
    default:                    s = "?"; break;
    }
    return put_cstr_text(s);
}

/* Versão da VM (major<<16 | minor<<8 | patch), como a syscall VERSION. */
EXPORT("ksweb_version")
uint32_t ksweb_version(void)
{
    return (KSVM_VERSION_MAJOR << 16) | (KSVM_VERSION_MINOR << 8) | KSVM_VERSION_PATCH;
}

/* ---- Entrada ---------------------------------------------------------- */

EXPORT("ksweb_input_buf")
uint32_t ksweb_input_buf(void)
{
    return (uint32_t)(uintptr_t)input_stage;
}

EXPORT("ksweb_input_space")   uint32_t ksweb_input_space(void)   { return ksweb_hal_space(&hw); }
EXPORT("ksweb_input_pending") uint32_t ksweb_input_pending(void) { return ksweb_hal_pending(&hw); }
EXPORT("ksweb_input_eof")     void     ksweb_input_eof(void)     { hw.eof = true; }
EXPORT("ksweb_wants_input")   uint32_t ksweb_wants_input(void)   { return hw.want_input ? 1u : 0u; }

EXPORT("ksweb_set_stdin_block")
void ksweb_set_stdin_block(uint32_t on)
{
    hw.block = (on != 0u);
}

/* Copia len bytes de ksweb_input_buf() para o anel; devolve quantos couberam. */
EXPORT("ksweb_feed")
uint32_t ksweb_feed(uint32_t len)
{
    if (len > KSWEB_INPUT_STAGE) {
        len = KSWEB_INPUT_STAGE;
    }
    return ksweb_hal_feed(&hw, input_stage, len);
}

/* Um byte; devolve 1 se coube. */
EXPORT("ksweb_feed_input")
uint32_t ksweb_feed_input(uint32_t byte)
{
    uint8_t b = (uint8_t)(byte & 0xFFu);

    return ksweb_hal_feed(&hw, &b, 1u);
}

/* ---- Registradores e disassembly -------------------------------------- */

EXPORT("ksweb_reg")
uint32_t ksweb_reg(uint32_t i)
{
    return (i < KSVM_NUM_REGS) ? vm.cpu.r[i] : 0u;
}

EXPORT("ksweb_pc")    uint32_t ksweb_pc(void)    { return vm.cpu.pc; }
EXPORT("ksweb_flags") uint32_t ksweb_flags(void) { return vm.cpu.flags; }

/* Ponteiro para ksvm_cpu: r[0..31], pc, flags (34 palavras). */
EXPORT("ksweb_cpu_ptr")
uint32_t ksweb_cpu_ptr(void)
{
    return (uint32_t)(uintptr_t)&vm.cpu;
}

/* Buffer de texto de KSWEB_TEXT_BUF bytes para disasm/trace/nomes. */
EXPORT("ksweb_text_buf")
uint32_t ksweb_text_buf(void)
{
    return (uint32_t)(uintptr_t)text_buf;
}

/* Desmonta a instrução em pc para buf (n bytes, terminado em '\0'), com o
 * mesmo texto do trace do runner (sem símbolos). Devolve 4/8, ou 0 se pc
 * não é executável (desalinhado ou fora de região EXEC). */
EXPORT("ksweb_disasm_at")
uint32_t ksweb_disasm_at(uint32_t pc, uint32_t buf, uint32_t n)
{
    uint32_t w = 0u, imm32 = 0u;
    char *b = (char *)(uintptr_t)buf;

    if (n == 0u) {
        return 0u;
    }
    b[0] = '\0';
    if ((pc & 3u) != 0u || ksvm_bus_fetch32(&vm.bus, pc, &w) != KSVM_FAULT_NONE) {
        return 0u;
    }
    if (ksvm_disasm_len(w) == 8u) {
        (void)ksvm_bus_fetch32(&vm.bus, pc + 4u, &imm32);
    }
    return ksvm_disasm_one(pc, w, imm32, b, (size_t)n);
}

/* ---- Memória ---------------------------------------------------------- */

/* Copia [addr, addr+len) do espaço do guest para dst (memória wasm). Bytes
 * fora de região legível saem 0 e, se mask != 0, mask[i] = 1 nos legíveis.
 * Devolve quantos eram legíveis. Não altera a VM. */
EXPORT("ksweb_mem_read")
uint32_t ksweb_mem_read(uint32_t addr, uint32_t len, uint32_t dst, uint32_t mask)
{
    uint8_t *d = (uint8_t *)(uintptr_t)dst, *m = (uint8_t *)(uintptr_t)mask;
    uint32_t i, ok = 0u;

    for (i = 0; i < len; i++) {
        uint8_t b = 0u;
        bool good = ksvm_bus_read8(&vm.bus, addr + i, &b) == KSVM_FAULT_NONE;
        d[i] = good ? b : 0u;
        if (m != NULL) {
            m[i] = good ? 1u : 0u;
        }
        ok += good ? 1u : 0u;
    }
    return ok;
}

/* Escreve em dst 5 palavras por região (base, size, perm, kind, ponteiro do
 * backing na memória wasm) e devolve a quantidade de regiões. */
EXPORT("ksweb_regions")
uint32_t ksweb_regions(uint32_t dst)
{
    uint32_t *d = (uint32_t *)(uintptr_t)dst;
    uint32_t i;

    for (i = 0; i < vm.bus.count; i++) {
        const ksvm_region *r = &vm.bus.regions[i];
        d[5u * i + 0u] = r->base;
        d[5u * i + 1u] = r->size;
        d[5u * i + 2u] = r->perm;
        d[5u * i + 3u] = r->kind;
        d[5u * i + 4u] = (uint32_t)(uintptr_t)r->backing;
    }
    return vm.bus.count;
}

/* Cabeçalho da imagem e estado derivado do carregamento; ponteiro para 22
 * palavras (ordem em docs/02-api.md):
 *  0 ver_major  1 ver_minor  2 flags  3 entry  4 code_off  5 code_size
 *  6 data_off  7 data_size  8 bss_size  9 ram_base (do arquivo)  10 ram_min
 * 11 stack_size (efetivo)  12 sym_off  13 sym_size  14 checksum
 * 15 ram_base efetivo  16 ram_size  17 sp inicial  18 stack_limit
 * 19 heap_start  20 tamanho da imagem  21 carregada (0/1) */
EXPORT("ksweb_header")
uint32_t ksweb_header(void)
{
    uint32_t *d = info_buf, i, rb = 0u;

    for (i = 0; i < vm.bus.count; i++) {
        if (vm.bus.regions[i].kind == KSVM_REGION_RAM) {
            rb = vm.bus.regions[i].base;
        }
    }
    d[0] = hdr.ver_major;   d[1] = hdr.ver_minor;  d[2] = hdr.flags;
    d[3] = hdr.entry;       d[4] = hdr.code_off;   d[5] = hdr.code_size;
    d[6] = hdr.data_off;    d[7] = hdr.data_size;  d[8] = hdr.bss_size;
    d[9] = hdr.ram_base;    d[10] = hdr.ram_min;   d[11] = hdr.stack_size;
    d[12] = hdr.sym_off;    d[13] = hdr.sym_size;  d[14] = hdr.checksum;
    d[15] = rb;             d[16] = ram_size;
    d[17] = (rb + ram_size) & ~3u;          /* como plan_ram do loader */
    d[18] = vm.stack_limit; d[19] = vm.heap_start;
    d[20] = image_size;     d[21] = loaded ? 1u : 0u;
    return (uint32_t)(uintptr_t)info_buf;
}

/* ---- Breakpoints e paradas -------------------------------------------- */

/* 0 = ok (inclusive se já existia), -1 = tabela cheia. */
EXPORT("ksweb_bp_set")
int ksweb_bp_set(uint32_t addr)
{
    uint32_t i;

    for (i = 0; i < bp_count; i++) {
        if (bps[i] == addr) {
            return 0;
        }
    }
    if (bp_count == KSWEB_MAX_BP) {
        return -1;
    }
    bps[bp_count++] = addr;
    return 0;
}

/* 0 = removido, -1 = não existia. */
EXPORT("ksweb_bp_clear")
int ksweb_bp_clear(uint32_t addr)
{
    uint32_t i;

    for (i = 0; i < bp_count; i++) {
        if (bps[i] == addr) {
            bps[i] = bps[--bp_count];
            return 0;
        }
    }
    return -1;
}

EXPORT("ksweb_bp_clear_all") void ksweb_bp_clear_all(void) { bp_count = 0u; }
EXPORT("ksweb_bp_count") uint32_t ksweb_bp_count(void) { return bp_count; }

EXPORT("ksweb_bp_get")
uint32_t ksweb_bp_get(uint32_t i)
{
    return (i < bp_count) ? bps[i] : 0u;
}

/* KSWEB_STOPF_BRK | KSWEB_STOPF_SYSCALL. */
EXPORT("ksweb_set_stop_flags")
void ksweb_set_stop_flags(uint32_t f)
{
    stop_flags = f & (KSWEB_STOPF_BRK | KSWEB_STOPF_SYSCALL);
}

/* ---- Trace ------------------------------------------------------------ */

/* Liga o trace guardando os últimos n registros (até KSWEB_TRACE_MAX) ou o
 * desliga (n = 0). Sempre limpa o histórico. Devolve a capacidade. */
EXPORT("ksweb_trace_enable")
uint32_t ksweb_trace_enable(uint32_t n)
{
    trace_cap = (n > KSWEB_TRACE_MAX) ? KSWEB_TRACE_MAX : n;
    trace_total = 0u;
    brk_next = 0u;
    trace_install();
    return trace_cap;
}

EXPORT("ksweb_trace_clear") void     ksweb_trace_clear(void) { trace_total = 0u; }
EXPORT("ksweb_trace_total") uint32_t ksweb_trace_total(void) { return trace_total; }

EXPORT("ksweb_trace_count")
uint32_t ksweb_trace_count(void)
{
    return (trace_total < trace_cap) ? trace_total : trace_cap;
}

/* Registro i (0 = o mais antigo guardado) formatado como no "ksvm --trace",
 * com '\n' final, em buf (n bytes, terminado em '\0'). Um BRK sai como
 * "brk at pc=..." seguido dos registradores, como no runner. Devolve o
 * comprimento. */
EXPORT("ksweb_trace_line")
uint32_t ksweb_trace_line(uint32_t i, uint32_t buf, uint32_t n)
{
    out o = { (char *)(uintptr_t)buf, 0u, n };
    uint32_t count = ksweb_trace_count(), seq;
    const trace_entry *e;

    if (n == 0u) {
        return 0u;
    }
    if (i >= count) {
        o.buf[0] = '\0';
        return 0u;
    }
    seq = trace_total - count + i;
    e = &trace_ring[seq % trace_cap];
    if (e->brk == NO_BRK) {
        put_trace_step(&o, e);
    } else {
        const brk_snap *s = &brk_snaps[e->brk];
        put_s(&o, "brk at pc=0x");
        put_hex(&o, e->pc, 8u);
        put_c(&o, '\n');
        if (s->seq == seq) {
            put_regs(&o, &s->cpu, s->insns);
        }
    }
    o.buf[o.len] = '\0';
    return o.len;
}

/* pc do registro i (o painel do depurador usa sem formatar a linha). */
EXPORT("ksweb_trace_pc")
uint32_t ksweb_trace_pc(uint32_t i)
{
    uint32_t count = ksweb_trace_count();

    return (i < count) ? trace_ring[(trace_total - count + i) % trace_cap].pc : 0u;
}
