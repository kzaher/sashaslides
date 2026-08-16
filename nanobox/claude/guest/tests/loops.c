// loops — tight micro-kernels for the JIT (each prints a marker so the harness can time it)
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
static void marker(const char *l) { printf("\n@@NANOBOX-DUMP:%s@@\n", l); fflush(stdout); }
int main(int argc, char **argv) {
  long n = argc > 1 ? atol(argv[1]) : 50000000;
  volatile uint64_t sink;
  marker("l0");
  // 1) register-only xorshift
  uint64_t x = 88172645463325252ull;
  for (long i = 0; i < n; i++) { x ^= x << 13; x ^= x >> 7; x ^= x << 17; }
  sink = x; marker("xorshift");
  // 2) memory: sum an array (loads)
  static uint64_t arr[65536]; for (int i = 0; i < 65536; i++) arr[i] = i * 2654435761u;
  uint64_t s = 0; for (long i = 0; i < n; i++) s += arr[i & 65535];
  sink = s; marker("memsum");
  // 3) stores + calls: push/pop/call/ret via a non-inlined function
  volatile long acc = 0;
  for (long i = 0; i < n / 4; i++) { acc += i; }
  sink = acc; marker("volatile");
  // 4) branchy: collatz-ish
  uint64_t c = 0; for (long i = 1; i < n / 8; i++) { uint64_t v = i; while (v != 1 && v > (uint64_t)i / 2) { v = (v & 1) ? 3 * v + 1 : v >> 1; c++; } }
  sink = c; marker("branchy");
  // 5) two-trace loop: measures per-trace overhead (each iteration = 2 tiny traces)
  { uint64_t a = 0, b = n / 2;
    __asm__ volatile(
      "1:\n\t inc %[a]\n\t jmp 2f\n\t .p2align 4\n\t"
      "2:\n\t dec %[b]\n\t jnz 1b\n\t"
      : [a] "+r"(a), [b] "+r"(b) :: "cc");
    sink = a; }
  marker("twotrace");
  // 6) call-heavy: tiny function call/ret per iteration
  { volatile long z = 0; long i;
    for (i = 0; i < n / 4; i++) { __asm__ volatile("call 3f\n\t jmp 4f\n\t 3: ret\n\t 4:" ::: "memory"); z++; }
    sink = z; }
  marker("callret");
  // 7) stack-heavy self loop: 4 stack ops per iteration
  { long i = n / 2;
    __asm__ volatile("1:\n\t push %%rax\n\t push %%rbx\n\t pop %%rbx\n\t pop %%rax\n\t dec %[i]\n\t jnz 1b" : [i] "+r"(i) :: "cc", "memory"); }
  marker("stackops");
  // 8) memory-heavy self loop: load/store to a small buffer
  { static uint64_t buf[64]; long i = n / 2; uint64_t *p = buf;
    __asm__ volatile("1:\n\t mov (%[p]), %%rax\n\t mov %%rax, 8(%[p])\n\t mov 16(%[p]), %%rdx\n\t add %%rdx, 24(%[p])\n\t dec %[i]\n\t jnz 1b" : [i] "+r"(i) : [p] "r"(p) : "rax", "rdx", "cc", "memory"); }
  marker("memops");
  // 9) many distinct traces: 4096 blocks `add; jmp next` executed n/40000 times each
  { long passes = n / 40000; uint64_t acc2 = 0;
    for (long p = 0; p < passes; p++) {
      __asm__ volatile(
        ".rept 4096\n\t add $3, %[a]\n\t jmp 1f\n\t 1:\n\t .endr\n\t"
        : [a] "+r"(acc2) :: "cc");
    }
    sink = acc2; }
  marker("manytraces");
  printf("done %llu %llu %ld %llu\n", (unsigned long long)x, (unsigned long long)s, (long)acc, (unsigned long long)c);
  marker("end");
  return 0;
}
