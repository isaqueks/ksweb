/*
 * ksweb.h — API que o módulo WebAssembly exporta para o JavaScript
 * (documentação completa em docs/02-api.md).
 *
 * Todos os ponteiros são endereços na memória linear do wasm; inteiros de
 * 32 bits. Há uma única instância de VM por módulo.
 */
#ifndef KSWEB_H
#define KSWEB_H

#include <stdint.h>

/* Estados devolvidos por ksweb_run/ksweb_step (0..3 = ksvm_status). */
enum ksweb_state {
    KSWEB_RUNNING    = 0,   /* fatia esgotada; chame ksweb_run de novo */
    KSWEB_HALT       = 1,   /* HALT/EXIT: ksweb_exit_code() */
    KSWEB_FAULT      = 2,   /* ksweb_fault_info() */
    KSWEB_YIELD      = 3,   /* YIELD/WFI/SLEEP_MS: retome após ksweb_sleep_ms() ms */
    KSWEB_WAIT_INPUT = 4,   /* GETC/GETS sem dado: retome quando houver entrada */
    KSWEB_BREAK      = 5,   /* depurador: ksweb_stop_reason() */
    KSWEB_NOT_LOADED = 6    /* nenhuma imagem carregada */
};

/* Motivos de KSWEB_BREAK. */
enum ksweb_stop {
    KSWEB_STOP_NONE       = 0,
    KSWEB_STOP_BREAKPOINT = 1,
    KSWEB_STOP_BRK        = 2,   /* instrução BRK em pc (opção KSWEB_STOPF_BRK) */
    KSWEB_STOP_SYSCALL    = 3,   /* instrução SYSCALL em pc (KSWEB_STOPF_SYSCALL) */
    KSWEB_STOP_STEP       = 4    /* passo por cima / sair da função concluído (ksweb_frame_stop) */
};

#define KSWEB_STOPF_BRK     1u
#define KSWEB_STOPF_SYSCALL 2u

/* ksweb_frame_stop(KSWEB_FRAME_OFF) desliga a parada por profundidade. */
#define KSWEB_FRAME_OFF INT32_MAX

/* Erro de ksweb_init além dos KSVM_E_* (types.h): memory.grow recusou. */
#define KSWEB_E_NOMEM (-100)

#define KSWEB_MAX_RAM      (UINT32_C(64) * 1024u * 1024u)
#define KSWEB_MAX_BP       64u
#define KSWEB_TRACE_MAX    65536u
#define KSWEB_TEXT_BUF     4096u
#define KSWEB_INPUT_STAGE  4096u

/* Ciclo de vida */
int      ksweb_init(uint32_t ram_bytes, uint32_t stack_bytes);
uint32_t ksweb_alloc(uint32_t n);
int      ksweb_load(uint32_t ptr, uint32_t len);
uint32_t ksweb_version(void);

/* Execução e estado */
int      ksweb_run(uint32_t max_insns);
int      ksweb_step(void);
int      ksweb_status(void);
uint32_t ksweb_exit_code(void);
uint32_t ksweb_sleep_ms(void);
uint32_t ksweb_stop_reason(void);
uint32_t ksweb_insn_count(void);
uint32_t ksweb_fault_info(void);
uint32_t ksweb_fault_name(uint32_t code);
uint32_t ksweb_err_name(int err);

/* Entrada */
uint32_t ksweb_input_buf(void);
uint32_t ksweb_input_space(void);
uint32_t ksweb_input_pending(void);
void     ksweb_input_eof(void);
uint32_t ksweb_wants_input(void);
void     ksweb_set_stdin_block(uint32_t on);
uint32_t ksweb_feed(uint32_t len);
uint32_t ksweb_feed_input(uint32_t byte);

/* Registradores, disassembly, memória */
uint32_t ksweb_reg(uint32_t i);
uint32_t ksweb_pc(void);
uint32_t ksweb_flags(void);
uint32_t ksweb_cpu_ptr(void);
uint32_t ksweb_text_buf(void);
uint32_t ksweb_disasm_at(uint32_t pc, uint32_t buf, uint32_t n);
uint32_t ksweb_mem_read(uint32_t addr, uint32_t len, uint32_t dst, uint32_t mask);
uint32_t ksweb_regions(uint32_t dst);
uint32_t ksweb_header(void);

/* Depurador */
int      ksweb_bp_set(uint32_t addr);
int      ksweb_bp_clear(uint32_t addr);
void     ksweb_bp_clear_all(void);
uint32_t ksweb_bp_count(void);
uint32_t ksweb_bp_get(uint32_t i);
void     ksweb_set_stop_flags(uint32_t f);
void     ksweb_frame_stop(int32_t depth);
int32_t  ksweb_frame_depth(void);
uint32_t ksweb_trace_enable(uint32_t n);
void     ksweb_trace_clear(void);
uint32_t ksweb_trace_total(void);
uint32_t ksweb_trace_count(void);
uint32_t ksweb_trace_line(uint32_t i, uint32_t buf, uint32_t n);
uint32_t ksweb_trace_pc(uint32_t i);

#endif /* KSWEB_H */
