/*
 * hal_web.h — HAL da KSVM para o navegador (WebAssembly).
 *
 *   putc      import js_putc(c): o worker acumula os bytes e os envia à
 *             página a cada fatia
 *   getc      anel de entrada alimentado por ksweb_feed/ksweb_feed_input.
 *             Sem dado, no modo bloqueante (padrão): a HAL desfaz a
 *             syscall (GETC/GETS) e pede que o laço pare com WAIT_INPUT;
 *             quando chegar entrada, a mesma syscall é executada de novo,
 *             o que equivale a um read(2) bloqueante. No modo poll devolve
 *             KSVM_HAL_NODATA ao guest (r1 = -1, r2 = AGAIN), como o
 *             "ksvm --stdin-poll". Depois de EOF (Ctrl+D) e com o anel
 *             vazio, getc devolve KSVM_HAL_EOF para sempre (como o runner
 *             nativo com stdin redirecionado).
 *   millis    import js_millis(): performance.now() desde o início
 *   sleep_ms  não dorme: registra o prazo e põe a VM em KSVM_YIELD; o
 *             worker retoma depois de setTimeout(prazo)
 *   syscall   MICROS (0x22) por js_micros(); grupo 3 (arquivos), GPIO e
 *             o resto: KSVM_SYS_UNKNOWN (r2 = ENOSYS)
 *   on_halt   registra o código de saída
 */
#ifndef KSWEB_HAL_WEB_H
#define KSWEB_HAL_WEB_H

#include "ksvm/vm.h"

/* Capacidade do anel de entrada (potência de 2). */
#define KSWEB_IN_CAP 65536u

typedef struct ksweb_hal {
    ksvm    *vm;
    uint8_t  in[KSWEB_IN_CAP];
    uint32_t in_head;          /* próximo byte a ler (contador livre) */
    uint32_t in_tail;          /* próximo byte a escrever */
    bool     eof;              /* Ctrl+D / fim do arquivo de entrada */
    bool     block;            /* getc sem dado suspende a VM */
    /* "Transação" da syscall de entrada em andamento (para desfazê-la). */
    bool     tx_valid;
    uint32_t tx_pc, tx_count, tx_r1, tx_r2, tx_head;
    bool     want_input;       /* a última syscall foi desfeita: falta entrada */
    uint32_t sleep_ms;         /* prazo pedido pelo último SLEEP_MS */
    bool     halted;
    uint32_t halt_code;
} ksweb_hal;

/* Preenche h (modo bloqueante, anel vazio) e hal com as funções da porta. */
void ksweb_hal_init(ksweb_hal *h, ksvm_hal *hal, ksvm *vm);

/* Copia até n bytes para o anel; devolve quantos couberam. */
uint32_t ksweb_hal_feed(ksweb_hal *h, const uint8_t *src, uint32_t n);

/* Espaço livre no anel. */
uint32_t ksweb_hal_space(const ksweb_hal *h);

/* Bytes à espera no anel. */
uint32_t ksweb_hal_pending(const ksweb_hal *h);

/* Se a última syscall de entrada foi desfeita por falta de dado, restaura
 * pc, insn_count, r1 e r2 do início dela e devolve true (a VM fica em
 * KSVM_YIELD, pronta para repetir a syscall). */
bool ksweb_hal_rewind(ksweb_hal *h);

#endif /* KSWEB_HAL_WEB_H */
