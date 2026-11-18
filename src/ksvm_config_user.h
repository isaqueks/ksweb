/*
 * ksvm_config_user.h — configuração do núcleo para o alvo WebAssembly.
 *
 * Incluído por ksvm/config.h quando KSVM_HAVE_USER_CONFIG está definido
 * (o Makefile passa -DKSVM_HAVE_USER_CONFIG -Isrc). Núcleo e ksweb.c veem
 * a mesma configuração, o que importa porque KSVM_ENABLE_TRACE muda o
 * layout de struct ksvm.
 */
#ifndef KSWEB_CONFIG_USER_H
#define KSWEB_CONFIG_USER_H

#define KSVM_ENABLE_TRACE      1   /* passo a passo, trace e BRK no depurador */
#define KSVM_ENABLE_MULDIV     1
#define KSVM_ENABLE_BITOPS     1
#define KSVM_ENABLE_FLOAT      1
#define KSVM_ENABLE_SYSCALL_FS 0   /* grupo 3 (arquivos): ENOSYS no navegador */
#define KSVM_ENABLE_DISASM     1

#endif /* KSWEB_CONFIG_USER_H */
