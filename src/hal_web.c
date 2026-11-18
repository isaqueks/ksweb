/*
 * hal_web.c — HAL do navegador (ver hal_web.h).
 *
 * Suspensão por falta de entrada. O núcleo não tem getc bloqueante e o
 * WebAssembly não pode esperar dentro de uma chamada sem
 * SharedArrayBuffer/Atomics (que exigem cabeçalhos COOP/COEP, ausentes em
 * file:// e no GitHub Pages). Em vez de deixar o guest girar num laço de
 * GETC, a HAL trata cada syscall de entrada como uma transação:
 *
 *   1. no primeiro getc de uma syscall (pc e insn_count ainda são os da
 *      instrução SYSCALL durante a execução dela), guarda pc, insn_count,
 *      r1, r2 e a posição de leitura do anel;
 *   2. se o anel esvazia antes de a syscall terminar, devolve a posição de
 *      leitura ao ponto guardado (os bytes voltam a estar disponíveis),
 *      marca want_input e põe a VM em KSVM_YIELD, o que faz ksvm_run sair;
 *   3. ksweb_hal_rewind (chamado por ksweb.c depois de ksvm_run/ksvm_step)
 *      restaura pc, insn_count, r1 e r2: a SYSCALL é repetida do zero
 *      quando o JS entregar mais entrada.
 *
 * GETS que já tinha copiado parte da linha para o buffer do guest vai
 * copiar os mesmos bytes de novo, então o efeito visível é idêntico ao de
 * uma leitura bloqueante (o que o runner nativo faz com stdin redirecionado).
 */
#include "hal_web.h"

#define KSWEB_IMPORT(name) __attribute__((import_module("env"), import_name(name)))

KSWEB_IMPORT("js_putc")   extern void     js_putc(uint32_t c);
KSWEB_IMPORT("js_millis") extern uint32_t js_millis(void);
KSWEB_IMPORT("js_micros") extern uint32_t js_micros(void);

#define IN_MASK (KSWEB_IN_CAP - 1u)

static int web_putc(void *ctx, uint8_t c)
{
    (void)ctx;
    js_putc(c);
    return 0;
}

/* Início de uma nova syscall de entrada? Durante a execução de SYSCALL o
 * núcleo ainda não avançou pc nem insn_count. */
static void tx_begin(ksweb_hal *h)
{
    const ksvm *vm = h->vm;

    if (h->tx_valid && h->tx_pc == vm->cpu.pc && h->tx_count == vm->insn_count) {
        return;
    }
    h->tx_valid = true;
    h->tx_pc = vm->cpu.pc;
    h->tx_count = vm->insn_count;
    h->tx_r1 = vm->cpu.r[1];
    h->tx_r2 = vm->cpu.r[2];
    h->tx_head = h->in_head;
}

static int web_getc(void *ctx)
{
    ksweb_hal *h = (ksweb_hal *)ctx;
    uint8_t c;

    tx_begin(h);
    if (h->in_head != h->in_tail) {
        c = h->in[h->in_head & IN_MASK];
        h->in_head++;
        return c;
    }
    if (h->eof) {
        return KSVM_HAL_EOF;
    }
    if (h->block) {
        h->in_head = h->tx_head;           /* devolve o que esta syscall leu */
        h->want_input = true;
        h->vm->status = KSVM_YIELD;        /* ksvm_run sai após esta instrução */
    }
    return KSVM_HAL_NODATA;
}

static uint32_t web_millis(void *ctx)
{
    (void)ctx;
    return js_millis();
}

static void web_sleep_ms(void *ctx, uint32_t ms)
{
    ksweb_hal *h = (ksweb_hal *)ctx;

    h->sleep_ms = ms;
    h->vm->status = KSVM_YIELD;
}

static int web_syscall(ksvm *vm, uint32_t num)
{
    if (num == 0x22u) {                    /* MICROS */
        vm->cpu.r[1] = js_micros();
        vm->cpu.r[2] = 0u;
        return KSVM_SYS_OK;
    }
    return KSVM_SYS_UNKNOWN;
}

static void web_on_halt(void *ctx, uint32_t code)
{
    ksweb_hal *h = (ksweb_hal *)ctx;

    h->halted = true;
    h->halt_code = code;
}

void ksweb_hal_init(ksweb_hal *h, ksvm_hal *hal, ksvm *vm)
{
    h->vm = vm;
    h->in_head = 0u;
    h->in_tail = 0u;
    h->eof = false;
    h->block = true;
    h->tx_valid = false;
    h->want_input = false;
    h->sleep_ms = 0u;
    h->halted = false;
    h->halt_code = 0u;
    hal->ctx = h;
    hal->putc = web_putc;
    hal->getc = web_getc;
    hal->millis = web_millis;
    hal->sleep_ms = web_sleep_ms;
    hal->syscall = web_syscall;
    hal->on_halt = web_on_halt;
}

uint32_t ksweb_hal_pending(const ksweb_hal *h)
{
    return h->in_tail - h->in_head;
}

uint32_t ksweb_hal_space(const ksweb_hal *h)
{
    return KSWEB_IN_CAP - ksweb_hal_pending(h);
}

uint32_t ksweb_hal_feed(ksweb_hal *h, const uint8_t *src, uint32_t n)
{
    uint32_t i, room = ksweb_hal_space(h);

    if (n > room) {
        n = room;
    }
    for (i = 0; i < n; i++) {
        h->in[h->in_tail & IN_MASK] = src[i];
        h->in_tail++;
    }
    return n;
}

bool ksweb_hal_rewind(ksweb_hal *h)
{
    ksvm *vm = h->vm;

    if (!h->want_input) {
        return false;
    }
    h->want_input = false;
    h->tx_valid = false;                   /* a repetição abre outra transação */
    vm->cpu.pc = h->tx_pc;
    vm->insn_count = h->tx_count;
    vm->cpu.r[1] = h->tx_r1;
    vm->cpu.r[2] = h->tx_r2;
    if (vm->status == KSVM_RUNNING) {
        vm->status = KSVM_YIELD;
    }
    return true;
}
