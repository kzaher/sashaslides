#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
static void marker(const char *l) { printf("\n@@NANOBOX-DUMP:%s@@\n", l); fflush(stdout); }
int main(int argc, char **argv) {
  long passes = argc > 1 ? atol(argv[1]) : 5000;
  volatile uint64_t sink; uint64_t acc2 = 0;
  marker("m0");
  for (long p = 0; p < passes; p++) {
    __asm__ volatile(".rept 4096\n\t add $3, %[a]\n\t jmp 1f\n\t 1:\n\t .endr\n\t" : [a] "+r"(acc2) :: "cc");
  }
  sink = acc2; marker("many2");
  // same with 6-instruction blocks (mov/add/xor/mov/inc/jmp)
  for (long p = 0; p < passes; p++) {
    __asm__ volatile(".rept 4096\n\t mov %[a], %%rdx\n\t add $3, %[a]\n\t xor %%rdx, %[a]\n\t mov %[a], %%rcx\n\t inc %[a]\n\t jmp 1f\n\t 1:\n\t .endr\n\t" : [a] "+r"(acc2) :: "rcx", "rdx", "cc");
  }
  sink = acc2; marker("many6");
  return 0;
}
