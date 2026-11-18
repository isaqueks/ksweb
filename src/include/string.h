/*
 * string.h mínimo para o alvo wasm32 freestanding (sem libc).
 *
 * O núcleo da KSVM só usa memcpy/memset (doc 08: "só <string.h>"), e o
 * clang pode gerar chamadas implícitas a memcpy/memset/memmove para cópias
 * de structs; as implementações estão em src/libc_min.c.
 */
#ifndef KSWEB_STRING_H
#define KSWEB_STRING_H

#include <stddef.h>

void *memcpy(void *dst, const void *src, size_t n);
void *memmove(void *dst, const void *src, size_t n);
void *memset(void *dst, int c, size_t n);
int   memcmp(const void *a, const void *b, size_t n);

#endif /* KSWEB_STRING_H */
