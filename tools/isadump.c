/*
 * isadump.c — despeja em JSON a tabela da ISA como o próprio ksas a vê:
 * nomes, opcodes, formatos, flags e descrições do isa.def (X-macro) e a
 * forma dos operandos/tipo de imediato/variantes que o assembler usa
 * (ksas_op_shape, ksas_op_imm_kind, ksas_op_suffixed, ksas_op_long_form,
 * de ksvm2/src/tools/ksas/mnemonic.c). Ferramenta de build nativa, ligada
 * com os fontes do ksas; a saída alimenta tools/mkisa.js -> isa.json.
 *
 *   isadump > isa-raw.json
 */
#include <stdio.h>
#include <string.h>

#include "ksvm/isa.h"
#include "ir.h"
#include "mnemonic.h"

static const char *const shape_names[] = {
    "NONE", "R3", "R2", "RA", "RB", "LOAD", "STORE", "RRI", "RI", "SR_RB", "IMM",
    "BRANCH", "JUMP"
};

static const char *imm_name(uint8_t k)
{
    switch (k) {
    case KSAS_IMM_NONE:    return "none";
    case KSAS_IMM_S14:     return "s14";
    case KSAS_IMM_U14:     return "u14";
    case KSAS_IMM_SHIFT:   return "shift";
    case KSAS_IMM_32:      return "imm32";
    case KSAS_IMM_PCREL14: return "pcrel14";
    case KSAS_IMM_PCREL32: return "pcrel32";
    case KSAS_IMM_BR20:    return "br20";
    case KSAS_IMM_J24:     return "j24";
    default:               return "?";
    }
}

/* Texto JSON (as descrições do isa.def são ASCII sem aspas, mas escapa). */
static void json_str(const char *s)
{
    putchar('"');
    for (; *s != '\0'; s++) {
        if (*s == '"' || *s == '\\') {
            putchar('\\');
        }
        putchar(*s);
    }
    putchar('"');
}

static void variant(const char *key, uint8_t op, const char *suffix)
{
    uint8_t v;
    char buf[32];

    if (ksas_op_suffixed(op, suffix, &v)) {
        printf(", \"%s\": ", key);
        json_str(ksas_op_lower(v, buf, sizeof buf));
    }
}

static void entry(const char *name, uint8_t op, const char *fmt, const char *fl,
                  const char *desc, int first)
{
    ksas_shape sh = ksas_op_shape(op);
    uint8_t lf = ksas_op_long_form(op);
    char buf[32];

    printf("%s\n  {\"name\": ", first ? "" : ",");
    json_str(name);
    printf(", \"opcode\": %u, \"format\": \"%s\", \"flags\": \"%s\", \"len\": %u, ",
           (unsigned)op, fmt, fl, (unsigned)ksvm_isa[op].len);
    printf("\"shape\": \"%s\", \"imm\": \"%s\", \"desc\": ", shape_names[sh],
           imm_name(ksas_op_imm_kind(op)));
    json_str(desc);
    if (lf != KSAS_NO_OP) {
        printf(", \"long\": ");
        json_str(ksas_op_lower(lf, buf, sizeof buf));
    }
    variant("immForm", op, "I");
    variant("indexed", op, "X");
    putchar('}');
}

int main(void)
{
    int first = 1;
    unsigned i;

    printf("{\"opcodes\": [");
#define KSVM_OP(name, code, fmt, fl, desc) \
    entry(#name, code, #fmt, #fl, desc, first); first = 0;
#include "ksvm/isa.def"
#undef KSVM_OP
    printf("\n], \"conds\": [");
    for (i = 0; i < 16u; i++) {
        printf("%s\"%s\"", i ? ", " : "", ksvm_cond_name((uint8_t)i));
    }
    printf("]}\n");
    return 0;
}
