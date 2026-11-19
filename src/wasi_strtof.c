/*
 * wasi_strtof.c — strtof do ksas.wasm com o sinal de NaN do literal.
 *
 * O ksas (parser.c, ksas_parse_float) entrega o texto de .float/fli ao
 * strtof da libc e canonicaliza o NaN preservando o sinal: "-nan" é
 * 0xFFC00000 (ksvm2/tests/ksas/test_ksas_float.c). A glibc devolve -NaN;
 * o strtof da wasi-libc (musl, __floatscan) ignora o sinal de "nan" e
 * devolve +NaN, e a imagem sairia diferente da do ksas nativo. Ligado com
 * wasm-ld --wrap=strtof: chama o original e, se o resultado é NaN, aplica o
 * sinal escrito no texto (depois dos espaços iniciais, como o strtof).
 * Nenhum fonte da ksvm2 é alterado.
 */
#include <ctype.h>
#include <stdint.h>
#include <string.h>

float __real_strtof(const char *s, char **end);
float __wrap_strtof(const char *s, char **end);

float __wrap_strtof(const char *s, char **end)
{
    const char *p = s;
    float f = __real_strtof(s, end);
    uint32_t u;

    memcpy(&u, &f, sizeof u);
    if ((u & UINT32_C(0x7FFFFFFF)) > UINT32_C(0x7F800000)) {
        while (isspace((unsigned char)*p)) {
            p++;
        }
        u = (*p == '-') ? (u | UINT32_C(0x80000000)) : (u & UINT32_C(0x7FFFFFFF));
        memcpy(&f, &u, sizeof f);
    }
    return f;
}
