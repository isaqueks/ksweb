/*
 * wasi_probe.c — exercita o shim WASI (web/wasi.js) pelas mesmas chamadas
 * de libc que um programa comum faz. Compilado duas vezes: com a wasi-libc
 * (build/wasi_probe.wasm, roda pelo shim) e com a libc do host
 * (build/native/wasi_probe, roda num diretório de verdade); o teste
 * (test_wasm_tools.js) compara a saída e os arquivos resultantes. Só
 * imprime resultados que não dependem da libc (sucesso/falha, bytes), nunca
 * números de errno nem mensagens.
 *
 * Espera no diretório: "old.txt" com 64 bytes 'X' e "in.txt" com "abcdefghij".
 */
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/uio.h>
#include <unistd.h>

static void dump(const char *what, const char *path)
{
    FILE *f = fopen(path, "rb");
    int c;

    printf("%s:", what);
    if (f == NULL) {
        printf(" (ausente)\n");
        return;
    }
    while ((c = fgetc(f)) != EOF) {
        printf(" %02x", (unsigned)c);
    }
    printf("\n");
    fclose(f);
}

int main(int argc, char **argv)
{
    int i, fd;
    char buf[64];
    FILE *f;
    struct iovec iov[3];
    ssize_t n;
    struct stat st;

    for (i = 0; i < argc; i++) {
        printf("argv[%d]=[%s] %u\n", i, argv[i], (unsigned)strlen(argv[i]));
    }

    /* truncar um arquivo existente e escrever além do fim: o buraco é zero */
    f = fopen("old.txt", "wb");
    fputs("ab", f);
    fseek(f, 10, SEEK_SET);
    fputc('z', f);
    fclose(f);
    dump("trunc+seek", "old.txt");

    /* ftruncate encolhe e depois cresce: o meio volta como zero */
    fd = open("old.txt", O_RDWR);
    printf("ftruncate 1: %d\n", ftruncate(fd, 1));
    printf("lseek end: %ld\n", (long)(lseek)(fd, 0, SEEK_END));
    printf("lseek +5 cur: %ld\n", (long)(lseek)(fd, 5, SEEK_CUR));
    printf("write: %ld\n", (long)write(fd, "Q", 1));
    printf("lseek -100: %ld\n", (long)(lseek)(fd, -100, SEEK_SET) == -1 ? -1L : 0L);
    close(fd);
    dump("ftruncate+grow", "old.txt");

    /* writev com vários iovecs e readv parcial até o EOF */
    fd = open("v.txt", O_WRONLY | O_CREAT | O_TRUNC, 0644);
    iov[0].iov_base = (void *)"um "; iov[0].iov_len = 3;
    iov[1].iov_base = (void *)""; iov[1].iov_len = 0;
    iov[2].iov_base = (void *)"dois"; iov[2].iov_len = 4;
    printf("writev: %ld\n", (long)writev(fd, iov, 3));
    close(fd);
    fd = open("in.txt", O_RDONLY);
    memset(buf, '.', sizeof buf);
    iov[0].iov_base = buf; iov[0].iov_len = 4;
    iov[1].iov_base = buf + 10; iov[1].iov_len = 4;
    iov[2].iov_base = buf + 20; iov[2].iov_len = 8;
    printf("readv: %ld\n", (long)readv(fd, iov, 3));
    printf("buf: %.28s\n", buf);
    printf("read no EOF: %ld\n", (long)read(fd, buf, 4));
    printf("lseek end in: %ld\n", (long)(lseek)(fd, 0, SEEK_END));
    printf("lseek +3 alem: %ld\n", (long)(lseek)(fd, 3, SEEK_END));
    printf("read alem: %ld\n", (long)read(fd, buf, 4));
    close(fd);

    /* append */
    f = fopen("v.txt", "ab");
    fputs("+tres", f);
    fclose(f);
    dump("append", "v.txt");

    /* O_EXCL, abrir inexistente, abrir diretório, criar em subpasta inexistente */
    printf("excl existe: %d\n", open("v.txt", O_WRONLY | O_CREAT | O_EXCL, 0644) == -1 ? -1 : 0);
    printf("ler inexistente: %d\n", fopen("nada.txt", "rb") == NULL ? -1 : 0);
    printf("criar em pasta inexistente: %d\n", fopen("naodir/x.txt", "wb") == NULL ? -1 : 0);
    printf("mkdir: %d\n", mkdir("d", 0755));
    printf("mkdir de novo: %d\n", mkdir("d", 0755));
    printf("abrir pasta para escrita: %d\n", fopen("d", "wb") == NULL ? -1 : 0);
    f = fopen("d/./../d/y.txt", "wb");
    printf("criar com ./ e ..: %d\n", f == NULL ? -1 : 0);
    if (f != NULL) {
        fputs("y", f);
        fclose(f);
    }
    i = stat("d/y.txt", &st);
    printf("stat y: %d %ld\n", i, (long)st.st_size);
    printf("rmdir cheio: %d\n", rmdir("d"));
    printf("unlink: %d\n", unlink("d/y.txt"));
    printf("unlink de novo: %d\n", unlink("d/y.txt"));
    printf("rmdir vazio: %d\n", rmdir("d"));
    printf("close invalido: %d\n", close(77));

    /* stdin até o EOF */
    n = (ssize_t)fread(buf, 1, sizeof buf, stdin);
    printf("stdin: %ld [%.*s] eof=%d\n", (long)n, (int)n, buf, feof(stdin) != 0);
    fprintf(stderr, "para stderr\n");
    fflush(stdout);
    return 3;
}
