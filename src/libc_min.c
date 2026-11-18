/*
 * libc_min.c — memcpy/memmove/memset/memcmp para o wasm freestanding.
 *
 * Laços simples byte a byte: o núcleo só os usa em init/carga (zerar a
 * struct, copiar .data, zerar .bss), nunca no laço de execução.
 */
#include <string.h>

void *memcpy(void *dst, const void *src, size_t n)
{
    unsigned char *d = (unsigned char *)dst;
    const unsigned char *s = (const unsigned char *)src;

    while (n-- > 0u) {
        *d++ = *s++;
    }
    return dst;
}

void *memmove(void *dst, const void *src, size_t n)
{
    unsigned char *d = (unsigned char *)dst;
    const unsigned char *s = (const unsigned char *)src;

    if (d < s) {
        while (n-- > 0u) {
            *d++ = *s++;
        }
    } else if (d > s) {
        d += n;
        s += n;
        while (n-- > 0u) {
            *--d = *--s;
        }
    }
    return dst;
}

void *memset(void *dst, int c, size_t n)
{
    unsigned char *d = (unsigned char *)dst;

    while (n-- > 0u) {
        *d++ = (unsigned char)c;
    }
    return dst;
}

int memcmp(const void *a, const void *b, size_t n)
{
    const unsigned char *x = (const unsigned char *)a;
    const unsigned char *y = (const unsigned char *)b;

    for (; n > 0u; n--, x++, y++) {
        if (*x != *y) {
            return (int)*x - (int)*y;
        }
    }
    return 0;
}
