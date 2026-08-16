// cputest — deterministic CPU workload for differential testing of the nanobox x86-64 engines.
//
// Every phase mixes a PRNG-driven stream of operations through one instruction family and folds
// every result (values AND flags where they matter) into a running FNV-1a hash. The hashes are
// printed, so a run on native hardware, on the reference Bochs engine and on the optimised engine
// can be compared line by line; the harness additionally snapshots guest RAM at the @@NANOBOX-DUMP
// markers, which the guest emits at deterministic points.
//
// build: gcc -O2 -static -march=haswell -o cputest cputest.c
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <immintrin.h>

static uint64_t rng_state = 0x9E3779B97F4A7C15ull;
static inline uint64_t rnd(void) {
  uint64_t x = rng_state;
  x ^= x << 13; x ^= x >> 7; x ^= x << 17;
  rng_state = x;
  return x;
}
static uint64_t h = 0xcbf29ce484222325ull;
static inline void mix(uint64_t v) {
  for (int i = 0; i < 8; i++) { h ^= (v >> (i * 8)) & 0xff; h *= 0x100000001b3ull; }
}
static void mixbuf(const void *p, size_t n) { const uint8_t *b = p; while (n--) { h ^= *b++; h *= 0x100000001b3ull; } }
static void report(const char *name) { printf("%-12s %016llx\n", name, (unsigned long long)h); fflush(stdout); printf("@@NANOBOX-DUMP:%s@@\n", name); fflush(stdout); }
static void marker(const char *label) { printf("\n@@NANOBOX-DUMP:%s@@\n", label); fflush(stdout); }

#define FLAGS_MASK 0x8d5 /* CF PF AF ZF SF OF */
#define ALU2(op, T, sfx) \
  static void alu_##op##_##sfx(void) { \
    for (int i = 0; i < 20000; i++) { \
      T a = (T)rnd(), b = (T)rnd(); uint64_t f; \
      __asm__ volatile(#op " %[b], %[a]\n\tpushfq\n\tpopq %[f]" : [a] "+r"(a), [f] "=r"(f) : [b] "r"(b) : "cc"); \
      mix((uint64_t)a); mix(f & FLAGS_MASK); \
    } }
ALU2(add, uint64_t, q) ALU2(sub, uint64_t, q) ALU2(and, uint64_t, q) ALU2(or, uint64_t, q) ALU2(xor, uint64_t, q)
ALU2(adc, uint64_t, q) ALU2(sbb, uint64_t, q) ALU2(cmp, uint64_t, q) ALU2(test, uint64_t, q)
ALU2(add, uint32_t, l) ALU2(sub, uint32_t, l) ALU2(xor, uint32_t, l) ALU2(cmp, uint32_t, l)
ALU2(add, uint16_t, w) ALU2(sub, uint16_t, w) ALU2(and, uint16_t, w)
ALU2(add, uint8_t, b) ALU2(sub, uint8_t, b) ALU2(or, uint8_t, b)

static void phase_alu(void) {
  alu_add_q(); alu_sub_q(); alu_and_q(); alu_or_q(); alu_xor_q(); alu_adc_q(); alu_sbb_q(); alu_cmp_q(); alu_test_q();
  alu_add_l(); alu_sub_l(); alu_xor_l(); alu_cmp_l(); alu_add_w(); alu_sub_w(); alu_and_w(); alu_add_b(); alu_sub_b(); alu_or_b();
  // inc/dec/neg/not with flags
  for (int i = 0; i < 20000; i++) {
    uint64_t a = rnd(), f;
    __asm__ volatile("incq %[a]\n\tpushfq\n\tpopq %[f]" : [a] "+r"(a), [f] "=r"(f) :: "cc"); mix(a); mix(f & FLAGS_MASK);
    __asm__ volatile("decl %k[a]\n\tpushfq\n\tpopq %[f]" : [a] "+r"(a), [f] "=r"(f) :: "cc"); mix(a); mix(f & FLAGS_MASK);
    __asm__ volatile("negw %w[a]\n\tpushfq\n\tpopq %[f]" : [a] "+r"(a), [f] "=r"(f) :: "cc"); mix(a); mix(f & FLAGS_MASK);
    __asm__ volatile("notb %b[a]" : [a] "+r"(a)); mix(a);
  }
  report("alu");
}

static void phase_shift(void) {
  for (int i = 0; i < 20000; i++) {
    uint64_t a = rnd(), f; uint8_t c = rnd();
    __asm__ volatile("shlq %%cl, %[a]\n\tpushfq\n\tpopq %[f]" : [a] "+r"(a), [f] "=r"(f) : "c"(c) : "cc"); mix(a); mix(f & FLAGS_MASK);
    a = rnd(); __asm__ volatile("shrl %%cl, %k[a]\n\tpushfq\n\tpopq %[f]" : [a] "+r"(a), [f] "=r"(f) : "c"(c) : "cc"); mix(a); mix(f & FLAGS_MASK);
    a = rnd(); __asm__ volatile("sarw %%cl, %w[a]\n\tpushfq\n\tpopq %[f]" : [a] "+r"(a), [f] "=r"(f) : "c"(c) : "cc"); mix(a); mix(f & FLAGS_MASK);
    a = rnd(); __asm__ volatile("rolq %%cl, %[a]\n\tpushfq\n\tpopq %[f]" : [a] "+r"(a), [f] "=r"(f) : "c"(c) : "cc"); mix(a); mix(f & 0x801);
    a = rnd(); __asm__ volatile("rorb %%cl, %b[a]\n\tpushfq\n\tpopq %[f]" : [a] "+r"(a), [f] "=r"(f) : "c"(c) : "cc"); mix(a); mix(f & 0x801);
    a = rnd(); __asm__ volatile("rcll %%cl, %k[a]\n\tpushfq\n\tpopq %[f]" : [a] "+r"(a), [f] "=r"(f) : "c"(c) : "cc"); mix(a); mix(f & 0x801);
    a = rnd(); __asm__ volatile("shlq $13, %[a]\n\tpushfq\n\tpopq %[f]" : [a] "+r"(a), [f] "=r"(f) :: "cc"); mix(a); mix(f & FLAGS_MASK);
    a = rnd(); __asm__ volatile("shlq $1, %[a]\n\tpushfq\n\tpopq %[f]" : [a] "+r"(a), [f] "=r"(f) :: "cc"); mix(a); mix(f & FLAGS_MASK);
    uint64_t b = rnd(); a = rnd();
    __asm__ volatile("shldq %%cl, %[b], %[a]\n\tpushfq\n\tpopq %[f]" : [a] "+r"(a), [f] "=r"(f) : [b] "r"(b), "c"(c) : "cc"); mix(a); mix(f & FLAGS_MASK);
    a = rnd(); __asm__ volatile("shrdl %%cl, %k[b], %k[a]\n\tpushfq\n\tpopq %[f]" : [a] "+r"(a), [f] "=r"(f) : [b] "r"(b), "c"(c) : "cc"); mix(a); mix(f & FLAGS_MASK);
    a = rnd(); __asm__ volatile("btq %[b], %[a]\n\tpushfq\n\tpopq %[f]" : [a] "+r"(a), [f] "=r"(f) : [b] "r"(b) : "cc"); mix(f & 1);
    a = rnd(); __asm__ volatile("btsl %k[b], %k[a]\n\tpushfq\n\tpopq %[f]" : [a] "+r"(a), [f] "=r"(f) : [b] "r"(b) : "cc"); mix(a); mix(f & 1);
    a = rnd(); __asm__ volatile("btcq %[b], %[a]\n\tpushfq\n\tpopq %[f]" : [a] "+r"(a), [f] "=r"(f) : [b] "r"(b) : "cc"); mix(a); mix(f & 1);
    a = rnd(); __asm__ volatile("bsfq %[b], %[a]\n\tpushfq\n\tpopq %[f]" : [a] "+r"(a), [f] "=r"(f) : [b] "r"(b) : "cc"); if (b) mix(a); mix(f & 0x40);
    a = rnd(); __asm__ volatile("bsrl %k[b], %k[a]\n\tpushfq\n\tpopq %[f]" : [a] "+r"(a), [f] "=r"(f) : [b] "r"(b) : "cc"); if ((uint32_t)b) mix(a); mix(f & 0x40);
    a = rnd(); __asm__ volatile("bswapq %[a]" : [a] "+r"(a)); mix(a);
    a = rnd(); __asm__ volatile("movbel %k[b], %k[a]" : [a] "=r"(a) : [b] "m"(b)); mix(a);
    mix((uint64_t)_lzcnt_u64(b)); mix((uint64_t)_tzcnt_u64(b)); mix((uint64_t)_mm_popcnt_u64(b));
    mix(_pdep_u64(a, b)); mix(_pext_u64(a, b)); mix(_bzhi_u64(a, (uint32_t)b)); mix(__andn_u64(a, b));
    mix(_blsi_u64(b)); mix(_blsmsk_u64(b)); mix(_blsr_u64(b)); mix(_bextr_u64(a, (uint32_t)b, (uint32_t)(b >> 8)));
    unsigned long long hi; mix(_mulx_u64(a, b, &hi)); mix(hi);
    { uint64_t q; __asm__ volatile("rorxq $17, %[a], %[q]" : [q] "=r"(q) : [a] "r"(a)); mix(q); __asm__ volatile("shlxq %[b], %[a], %[q]" : [q] "=r"(q) : [a] "r"(a), [b] "r"(b)); mix(q); __asm__ volatile("sarxq %[b], %[a], %[q]" : [q] "=r"(q) : [a] "r"(a), [b] "r"(b)); mix(q); __asm__ volatile("shrxq %[b], %[a], %[q]" : [q] "=r"(q) : [a] "r"(a), [b] "r"(b)); mix(q); }
    a = rnd(); __asm__ volatile("crc32q %[b], %[a]" : [a] "+r"(a) : [b] "r"(b)); mix(a);
    a = rnd(); __asm__ volatile("crc32b %b[b], %k[a]" : [a] "+r"(a) : [b] "r"(b)); mix(a);
    a = rnd(); __asm__ volatile("crc32w %w[b], %k[a]" : [a] "+r"(a) : [b] "r"(b)); mix(a);
    // setcc / cmovcc / adcx / adox
    uint64_t r;
    __asm__ volatile("cmpq %[b], %[a]\n\tsetbe %b[r]\n\tmovzbq %b[r], %[r]" : [r] "=&r"(r) : [a] "r"(a), [b] "r"(b) : "cc"); mix(r);
    __asm__ volatile("cmpq %[b], %[a]\n\tsetl %b[r]\n\tmovzbq %b[r], %[r]" : [r] "=&r"(r) : [a] "r"(a), [b] "r"(b) : "cc"); mix(r);
    __asm__ volatile("cmpq %[b], %[a]\n\tmovq %[a], %[r]\n\tcmovaq %[b], %[r]" : [r] "=&r"(r) : [a] "r"(a), [b] "r"(b) : "cc"); mix(r);
    __asm__ volatile("cmpq %[b], %[a]\n\tmovq %[a], %[r]\n\tcmovlel %k[b], %k[r]" : [r] "=&r"(r) : [a] "r"(a), [b] "r"(b) : "cc"); mix(r);
    // (adcx/adox are ADX = Broadwell+, not on the Haswell the engines emulate)
  }
  report("shift-bmi");
}

static void phase_muldiv(void) {
  for (int i = 0; i < 20000; i++) {
    uint64_t a = rnd(), b = rnd() | 1, lo, hi, f;
    __asm__ volatile("mulq %[b]\n\tpushfq\n\tpopq %[f]" : "=a"(lo), "=d"(hi), [f] "=r"(f) : "a"(a), [b] "r"(b) : "cc"); mix(lo); mix(hi); mix(f & 0x801);
    __asm__ volatile("imulq %[b]\n\tpushfq\n\tpopq %[f]" : "=a"(lo), "=d"(hi), [f] "=r"(f) : "a"(a), [b] "r"(b) : "cc"); mix(lo); mix(hi); mix(f & 0x801);
    __asm__ volatile("imulq %[b], %[a]\n\tpushfq\n\tpopq %[f]" : [a] "+r"(a), [f] "=r"(f) : [b] "r"(b) : "cc"); mix(a); mix(f & 0x801);
    __asm__ volatile("imulq $-12345, %[b], %[a]\n\tpushfq\n\tpopq %[f]" : [a] "=r"(a), [f] "=r"(f) : [b] "r"(b) : "cc"); mix(a); mix(f & 0x801);
    uint32_t a32 = (uint32_t)rnd(), b32 = (uint32_t)rnd() | 1, lo32, hi32;
    __asm__ volatile("mull %[b]" : "=a"(lo32), "=d"(hi32) : "a"(a32), [b] "r"(b32) : "cc"); mix(lo32); mix(hi32);
    __asm__ volatile("imull %[b]" : "=a"(lo32), "=d"(hi32) : "a"(a32), [b] "r"(b32) : "cc"); mix(lo32); mix(hi32);
    uint16_t a16 = (uint16_t)rnd(), b16 = (uint16_t)rnd() | 1, lo16, hi16;
    __asm__ volatile("mulw %[b]" : "=a"(lo16), "=d"(hi16) : "a"(a16), [b] "r"(b16) : "cc"); mix(lo16); mix(hi16);
    uint8_t a8 = (uint8_t)rnd(), b8 = (uint8_t)rnd() | 1; uint16_t r16;
    __asm__ volatile("mulb %[b]" : "=a"(r16) : "a"(a8), [b] "r"(b8) : "cc"); mix(r16);
    __asm__ volatile("imulb %[b]" : "=a"(r16) : "a"(a8), [b] "r"(b8) : "cc"); mix(r16);
    // divisions (dividend chosen so no #DE)
    uint64_t q, r; uint64_t bq = b | 0x100000000ull, dhi = rnd() % bq, dlo = rnd();
    __asm__ volatile("divq %[b]" : "=a"(q), "=d"(r) : "a"(dlo), "d"(dhi), [b] "r"(bq) : "cc"); mix(q); mix(r);
    int64_t sd = (int64_t)rnd() >> 8; int64_t sq, sr;
    __asm__ volatile("idivq %[b]" : "=a"(sq), "=d"(sr) : "a"(sd), "d"(sd >> 63), [b] "r"((int64_t)(b | 0x100000000ull)) : "cc"); mix(sq); mix(sr);
    __asm__ volatile("divl %[b]" : "=a"(lo32), "=d"(hi32) : "a"(a32), "d"(0u), [b] "r"(b32) : "cc"); mix(lo32); mix(hi32);
    int32_t sq32, sr32; __asm__ volatile("idivl %[b]" : "=a"(sq32), "=d"(sr32) : "a"((int32_t)a32), "d"((int32_t)a32 >> 31), [b] "r"((int32_t)((b32 | 0x100) & 0x7fffffff)) : "cc"); mix(sq32); mix(sr32);
    __asm__ volatile("divw %[b]" : "=a"(lo16), "=d"(hi16) : "a"(a16), "d"((uint16_t)0), [b] "r"(b16) : "cc"); mix(lo16); mix(hi16);
    __asm__ volatile("divb %[b]" : "=a"(r16) : "a"((uint16_t)(a8)), [b] "r"(b8) : "cc"); mix(r16);
    int8_t sb8 = (int8_t)(b8 | 0x40); int16_t sa16 = (int16_t)a16 / 512;
    __asm__ volatile("idivb %[b]" : "=a"(r16) : "a"(sa16), [b] "r"(sb8) : "cc"); mix(r16);
    // cdq/cqo/cbw family, xchg, xadd, cmpxchg
    int64_t x = (int64_t)rnd(); uint64_t y;
    __asm__ volatile("cqo" : "=d"(y) : "a"(x)); mix(y);
    __asm__ volatile("cltq" : "=a"(y) : "a"((uint32_t)x)); mix(y);
    __asm__ volatile("cwtl" : "=a"(y) : "a"((uint16_t)x)); mix(y);
    uint64_t m = rnd(), v = rnd();
    __asm__ volatile("xaddq %[v], %[m]" : [m] "+m"(m), [v] "+r"(v) :: "cc"); mix(m); mix(v);
    v = rnd(); __asm__ volatile("lock xaddl %k[v], %k[m]" : [m] "+m"(m), [v] "+r"(v) :: "cc"); mix(m); mix(v);
    uint64_t expect = (rnd() & 1) ? m : rnd(), nv = rnd();
    __asm__ volatile("lock cmpxchgq %[nv], %[m]\n\tpushfq\n\tpopq %[f]" : [m] "+m"(m), "+a"(expect), [f] "=r"(f) : [nv] "r"(nv) : "cc"); mix(m); mix(expect); mix(f & 0x40);
    __asm__ volatile("xchgq %[v], %[m]" : [m] "+m"(m), [v] "+r"(v)); mix(m); mix(v);
    struct { uint64_t lo, hi; } __attribute__((aligned(16))) c16 = { rnd(), rnd() };
    uint64_t elo = (rnd() & 1) ? c16.lo : rnd(), ehi = c16.hi;
    __asm__ volatile("lock cmpxchg16b %[m]\n\tpushfq\n\tpopq %[f]" : [m] "+m"(c16), "+a"(elo), "+d"(ehi), [f] "=r"(f) : "b"(rnd()), "c"(rnd()) : "cc");
    mix(c16.lo); mix(c16.hi); mix(elo); mix(ehi); mix(f & 0x40);
  }
  report("muldiv");
}

static uint8_t buf1[65536 + 64], buf2[65536 + 64];
static void phase_string(void) {
  for (int i = 0; i < 300; i++) {
    size_t n = rnd() % 4000, o1 = rnd() % 200, o2 = rnd() % 200; uint64_t f; void *d, *s;
    for (size_t k = 0; k < n + 8; k++) buf1[o1 + k] = (uint8_t)rnd();
    d = buf2 + o2; s = buf1 + o1;
    __asm__ volatile("rep movsb" : "+D"(d), "+S"(s), "+c"(n) :: "memory"); mixbuf(buf2 + o2, n = (rnd() % 4000));
    d = buf2 + o2; s = buf1 + o1; size_t nq = n / 8;
    __asm__ volatile("rep movsq" : "+D"(d), "+S"(s), "+c"(nq) :: "memory"); mixbuf(buf2 + o2, n);
    // backwards (DF=1)
    d = buf2 + o2 + n - 1; s = buf1 + o1 + n - 1; size_t nb = n;
    __asm__ volatile("std\n\trep movsb\n\tcld" : "+D"(d), "+S"(s), "+c"(nb) :: "memory"); mixbuf(buf2 + o2, n);
    d = buf2 + o2; uint64_t val = rnd(); size_t nl = n / 4;
    __asm__ volatile("rep stosl" : "+D"(d), "+c"(nl) : "a"((uint32_t)val) : "memory"); mixbuf(buf2 + o2, n);
    d = buf2 + o2; nb = n; __asm__ volatile("rep stosb" : "+D"(d), "+c"(nb) : "a"((uint8_t)val) : "memory");
    // make a difference somewhere and compare
    memcpy(buf1 + o1, buf2 + o2, n); if (n > 10) buf1[o1 + rnd() % n] ^= 1;
    d = buf2 + o2; s = buf1 + o1; nb = n;
    __asm__ volatile("repe cmpsb\n\tpushfq\n\tpopq %[f]" : "+D"(d), "+S"(s), "+c"(nb), [f] "=r"(f) :: "cc", "memory"); mix(nb); mix(f & FLAGS_MASK);
    d = buf2 + o2; nb = n; uint8_t needle = buf2[o2 + (n ? rnd() % n : 0)];
    __asm__ volatile("repne scasb\n\tpushfq\n\tpopq %[f]" : "+D"(d), "+c"(nb), [f] "=r"(f) : "a"(needle) : "cc", "memory"); mix(nb); mix(f & FLAGS_MASK);
    d = buf2 + o2; nb = n / 2; uint16_t needle16 = 0x1234;
    __asm__ volatile("repne scasw" : "+D"(d), "+c"(nb) : "a"(needle16) : "cc", "memory"); mix(nb);
    uint64_t lv; s = buf1 + o1; nb = 4;
    __asm__ volatile("lodsq" : "+S"(s), "=a"(lv)); mix(lv);
    // C library string ops (memcpy/strlen/memcmp use SSE/AVX2 in glibc; here static musl-like glibc)
    mix((uint64_t)memcmp(buf1 + o1, buf2 + o2, n)); buf2[o2 + n] = 0; mix((uint64_t)strlen((char *)buf2 + o2));
    memmove(buf1 + o1 + 3, buf1 + o1, n); mixbuf(buf1 + o1, n + 3);
  }
  report("string");
}

static void phase_sse(void) {
  __m128i acc = _mm_set1_epi32(1);
  for (int i = 0; i < 20000; i++) {
    __m128i a = _mm_set_epi64x(rnd(), rnd()), b = _mm_set_epi64x(rnd(), rnd());
    acc = _mm_xor_si128(acc, _mm_add_epi8(a, b));
    acc = _mm_add_epi16(acc, _mm_sub_epi32(a, b));
    acc = _mm_xor_si128(acc, _mm_mullo_epi16(a, b));
    acc = _mm_add_epi64(acc, _mm_mul_epu32(a, b));
    acc = _mm_xor_si128(acc, _mm_madd_epi16(a, b));
    acc = _mm_add_epi32(acc, _mm_sad_epu8(a, b));
    acc = _mm_xor_si128(acc, _mm_cmpeq_epi8(a, b));
    acc = _mm_xor_si128(acc, _mm_cmpgt_epi16(a, b));
    acc = _mm_add_epi8(acc, _mm_unpacklo_epi8(a, b));
    acc = _mm_add_epi8(acc, _mm_unpackhi_epi32(a, b));
    acc = _mm_xor_si128(acc, _mm_packs_epi16(a, b));
    acc = _mm_xor_si128(acc, _mm_packus_epi16(a, b));
    acc = _mm_add_epi32(acc, _mm_shuffle_epi32(a, 0x1b));
    acc = _mm_add_epi32(acc, _mm_shufflelo_epi16(b, 0x93));
    acc = _mm_xor_si128(acc, _mm_slli_epi32(a, 5));
    acc = _mm_xor_si128(acc, _mm_srai_epi16(b, 3));
    acc = _mm_xor_si128(acc, _mm_srl_epi64(a, _mm_set_epi64x(0, (rnd() & 0x7f))));
    acc = _mm_xor_si128(acc, _mm_slli_si128(b, 5));
    acc = _mm_xor_si128(acc, _mm_srli_si128(a, 9));
    acc = _mm_xor_si128(acc, _mm_avg_epu8(a, b));
    acc = _mm_xor_si128(acc, _mm_max_epi16(a, b));
    acc = _mm_xor_si128(acc, _mm_min_epu8(a, b));
    acc = _mm_xor_si128(acc, _mm_adds_epi16(a, b));
    acc = _mm_xor_si128(acc, _mm_subs_epu8(a, b));
    acc = _mm_xor_si128(acc, _mm_mulhi_epu16(a, b));
    // SSSE3 / SSE4.1 / SSE4.2
    acc = _mm_xor_si128(acc, _mm_shuffle_epi8(a, b));
    acc = _mm_xor_si128(acc, _mm_alignr_epi8(a, b, 5));
    acc = _mm_xor_si128(acc, _mm_hadd_epi16(a, b));
    acc = _mm_xor_si128(acc, _mm_maddubs_epi16(a, b));
    acc = _mm_xor_si128(acc, _mm_mulhrs_epi16(a, b));
    acc = _mm_xor_si128(acc, _mm_sign_epi8(a, b));
    acc = _mm_xor_si128(acc, _mm_abs_epi32(a));
    acc = _mm_xor_si128(acc, _mm_blendv_epi8(a, b, acc));
    acc = _mm_xor_si128(acc, _mm_blend_epi16(a, b, 0x5a));
    acc = _mm_xor_si128(acc, _mm_mullo_epi32(a, b));
    acc = _mm_xor_si128(acc, _mm_mul_epi32(a, b));
    acc = _mm_xor_si128(acc, _mm_max_epi8(a, b));
    acc = _mm_xor_si128(acc, _mm_min_epu32(a, b));
    acc = _mm_xor_si128(acc, _mm_cvtepu8_epi16(a));
    acc = _mm_xor_si128(acc, _mm_cvtepi16_epi64(b));
    acc = _mm_xor_si128(acc, _mm_packus_epi32(a, b));
    acc = _mm_xor_si128(acc, _mm_minpos_epu16(a));
    acc = _mm_xor_si128(acc, _mm_cmpeq_epi64(a, b));
    acc = _mm_xor_si128(acc, _mm_cmpgt_epi64(a, b));
    acc = _mm_xor_si128(acc, _mm_insert_epi32(a, (int)rnd(), 2));
    mix((uint64_t)_mm_extract_epi16(b, 3)); mix((uint64_t)_mm_extract_epi64(a, 1)); mix((uint64_t)_mm_movemask_epi8(acc));
    mix((uint64_t)_mm_testz_si128(a, b)); mix((uint64_t)_mm_testc_si128(a, acc));
    // string compare
    mix((uint64_t)_mm_cmpistri(a, b, _SIDD_UBYTE_OPS | _SIDD_CMP_EQUAL_ANY));
    mix((uint64_t)_mm_cmpestri(a, 9, b, 12, _SIDD_UWORD_OPS | _SIDD_CMP_RANGES | _SIDD_MASKED_NEGATIVE_POLARITY));
    acc = _mm_xor_si128(acc, _mm_cmpistrm(a, b, _SIDD_UBYTE_OPS | _SIDD_CMP_EQUAL_EACH | _SIDD_UNIT_MASK));
    // AES / PCLMUL
    acc = _mm_xor_si128(acc, _mm_aesenc_si128(a, b));
    acc = _mm_xor_si128(acc, _mm_aesdec_si128(a, b));
    acc = _mm_xor_si128(acc, _mm_aesenclast_si128(a, b));
    acc = _mm_xor_si128(acc, _mm_aesdeclast_si128(a, b));
    acc = _mm_xor_si128(acc, _mm_aesimc_si128(a));
    acc = _mm_xor_si128(acc, _mm_aeskeygenassist_si128(b, 0x1b));
    acc = _mm_xor_si128(acc, _mm_clmulepi64_si128(a, b, 0x00));
    acc = _mm_xor_si128(acc, _mm_clmulepi64_si128(a, b, 0x11));
    acc = _mm_xor_si128(acc, _mm_clmulepi64_si128(a, b, 0x10));
    if ((i & 1023) == 0) { uint64_t t[2]; _mm_storeu_si128((__m128i *)t, acc); mix(t[0]); mix(t[1]); }
  }
  uint64_t t[2]; _mm_storeu_si128((__m128i *)t, acc); mix(t[0]); mix(t[1]);
  report("sse-int");
}

static void phase_avx2(void) {
  __m256i acc = _mm256_set1_epi32(7);
  for (int i = 0; i < 20000; i++) {
    __m256i a = _mm256_set_epi64x(rnd(), rnd(), rnd(), rnd()), b = _mm256_set_epi64x(rnd(), rnd(), rnd(), rnd());
    acc = _mm256_xor_si256(acc, _mm256_add_epi8(a, b));
    acc = _mm256_add_epi16(acc, _mm256_sub_epi32(a, b));
    acc = _mm256_xor_si256(acc, _mm256_mullo_epi16(a, b));
    acc = _mm256_add_epi64(acc, _mm256_mul_epu32(a, b));
    acc = _mm256_xor_si256(acc, _mm256_madd_epi16(a, b));
    acc = _mm256_add_epi32(acc, _mm256_sad_epu8(a, b));
    acc = _mm256_xor_si256(acc, _mm256_cmpeq_epi8(a, b));
    acc = _mm256_xor_si256(acc, _mm256_cmpgt_epi32(a, b));
    acc = _mm256_add_epi8(acc, _mm256_unpacklo_epi8(a, b));
    acc = _mm256_add_epi8(acc, _mm256_unpackhi_epi64(a, b));
    acc = _mm256_xor_si256(acc, _mm256_packs_epi32(a, b));
    acc = _mm256_xor_si256(acc, _mm256_packus_epi16(a, b));
    acc = _mm256_add_epi32(acc, _mm256_shuffle_epi32(a, 0x4e));
    acc = _mm256_xor_si256(acc, _mm256_shuffle_epi8(a, b));
    acc = _mm256_xor_si256(acc, _mm256_permute4x64_epi64(a, 0x93));
    acc = _mm256_xor_si256(acc, _mm256_permutevar8x32_epi32(a, b));
    acc = _mm256_xor_si256(acc, _mm256_permute2x128_si256(a, b, 0x21));
    acc = _mm256_xor_si256(acc, _mm256_slli_epi32(a, 5));
    acc = _mm256_xor_si256(acc, _mm256_srai_epi16(b, 3));
    acc = _mm256_xor_si256(acc, _mm256_sllv_epi32(a, _mm256_and_si256(b, _mm256_set1_epi32(63))));
    acc = _mm256_xor_si256(acc, _mm256_srlv_epi64(a, _mm256_and_si256(b, _mm256_set1_epi64x(127))));
    acc = _mm256_xor_si256(acc, _mm256_srav_epi32(a, b));
    acc = _mm256_xor_si256(acc, _mm256_slli_si256(b, 7));
    acc = _mm256_xor_si256(acc, _mm256_alignr_epi8(a, b, 11));
    acc = _mm256_xor_si256(acc, _mm256_avg_epu16(a, b));
    acc = _mm256_xor_si256(acc, _mm256_max_epi32(a, b));
    acc = _mm256_xor_si256(acc, _mm256_min_epu16(a, b));
    acc = _mm256_xor_si256(acc, _mm256_adds_epu8(a, b));
    acc = _mm256_xor_si256(acc, _mm256_subs_epi16(a, b));
    acc = _mm256_xor_si256(acc, _mm256_hadd_epi32(a, b));
    acc = _mm256_xor_si256(acc, _mm256_hsub_epi16(a, b));
    acc = _mm256_xor_si256(acc, _mm256_maddubs_epi16(a, b));
    acc = _mm256_xor_si256(acc, _mm256_sign_epi16(a, b));
    acc = _mm256_xor_si256(acc, _mm256_abs_epi8(a));
    acc = _mm256_xor_si256(acc, _mm256_blendv_epi8(a, b, acc));
    acc = _mm256_xor_si256(acc, _mm256_blend_epi32(a, b, 0x5a));
    acc = _mm256_xor_si256(acc, _mm256_mullo_epi32(a, b));
    acc = _mm256_xor_si256(acc, _mm256_cvtepu8_epi32(_mm256_castsi256_si128(a)));
    acc = _mm256_xor_si256(acc, _mm256_cvtepi8_epi64(_mm256_castsi256_si128(b)));
    acc = _mm256_xor_si256(acc, _mm256_broadcastb_epi8(_mm256_castsi256_si128(a)));
    acc = _mm256_xor_si256(acc, _mm256_broadcastsi128_si256(_mm256_castsi256_si128(b)));
    acc = _mm256_xor_si256(acc, _mm256_inserti128_si256(a, _mm256_castsi256_si128(b), 1));
    acc = _mm256_xor_si256(acc, _mm256_castsi128_si256(_mm256_extracti128_si256(a, 1)));
    mix((uint64_t)_mm256_movemask_epi8(acc)); mix((uint64_t)_mm256_testz_si256(a, b));
    // gathers + masked loads/stores
    static int32_t table[256]; for (int k = 0; k < 8; k++) table[(i * 8 + k) & 255] = (int32_t)rnd();
    __m256i idx = _mm256_and_si256(a, _mm256_set1_epi32(255));
    acc = _mm256_xor_si256(acc, _mm256_i32gather_epi32(table, idx, 4));
    static int64_t tab64[64]; tab64[i & 63] = (int64_t)rnd();
    acc = _mm256_xor_si256(acc, _mm256_i64gather_epi64((const long long *)tab64, _mm256_and_si256(b, _mm256_set1_epi64x(63)), 8));
    static int32_t mbuf[16]; _mm256_maskstore_epi32(mbuf, a, b); acc = _mm256_xor_si256(acc, _mm256_maskload_epi32(mbuf, b));
    if ((i & 1023) == 0) { uint64_t t[4]; _mm256_storeu_si256((__m256i *)t, acc); mix(t[0]); mix(t[1]); mix(t[2]); mix(t[3]); }
  }
  uint64_t t[4]; _mm256_storeu_si256((__m256i *)t, acc); mix(t[0]); mix(t[1]); mix(t[2]); mix(t[3]);
  report("avx2-int");
}

static double dr(void) { // random double with wide exponent range incl. denormals/nan sometimes
  uint64_t r = rnd(); int k = r & 15; double d;
  if (k == 0) return 0.0; if (k == 1) return -0.0;
  if (k == 2) { uint64_t bits = (r >> 4) & 0x000fffffffffffffull; memcpy(&d, &bits, 8); return d; } // denormal
  if (k == 3) return __builtin_inf() * ((r >> 5) & 1 ? 1 : -1);
  if (k == 4) return __builtin_nan("");
  memcpy(&d, &r, 8); if (d != d) return 1.5; return d;
}
static float fr(void) { double d = dr(); return (float)d; }
static void phase_fp(void) {
  volatile double acc = 0; volatile float facc = 0;
  for (int i = 0; i < 20000; i++) {
    double a = dr(), b = dr(); float fa = fr(), fb = fr(); uint64_t bits; uint32_t fbits;
    double r = a + b; memcpy(&bits, &r, 8); mix(bits);
    r = a * b; memcpy(&bits, &r, 8); mix(bits);
    r = a / b; memcpy(&bits, &r, 8); mix(bits);
    r = a - b; memcpy(&bits, &r, 8); mix(bits);
    r = __builtin_sqrt(a < 0 ? -a : a); memcpy(&bits, &r, 8); mix(bits);
    r = __builtin_fma(a, b, acc); memcpy(&bits, &r, 8); mix(bits);
    r = __builtin_fmax(a, b); memcpy(&bits, &r, 8); mix(bits);
    r = __builtin_fmin(a, b); memcpy(&bits, &r, 8); mix(bits);
    r = __builtin_floor(a); memcpy(&bits, &r, 8); mix(bits);
    r = __builtin_ceil(b); memcpy(&bits, &r, 8); mix(bits);
    r = __builtin_trunc(a); memcpy(&bits, &r, 8); mix(bits);
    r = __builtin_nearbyint(b); memcpy(&bits, &r, 8); mix(bits);
    float fr_ = fa * fb + fa; memcpy(&fbits, &fr_, 4); mix(fbits);
    fr_ = fa / fb; memcpy(&fbits, &fr_, 4); mix(fbits);
    fr_ = __builtin_sqrtf(fa < 0 ? -fa : fa); memcpy(&fbits, &fr_, 4); mix(fbits);
    fr_ = (float)a; memcpy(&fbits, &fr_, 4); mix(fbits);
    r = (double)fb; memcpy(&bits, &r, 8); mix(bits);
    // conversions
    mix((uint64_t)(int64_t)(a == a && a < 9e18 && a > -9e18 ? a : 0.0));
    mix((uint64_t)(int32_t)(fa == fa && fa < 2e9f && fa > -2e9f ? fa : 0.0f));
    r = (double)(int64_t)rnd(); memcpy(&bits, &r, 8); mix(bits);
    fr_ = (float)(int32_t)rnd(); memcpy(&fbits, &fr_, 4); mix(fbits);
    r = (double)(uint64_t)rnd(); memcpy(&bits, &r, 8); mix(bits);
    // comparisons (ucomisd flags)
    mix((uint64_t)(a < b)); mix((uint64_t)(a == b)); mix((uint64_t)(a >= b)); mix((uint64_t)__builtin_isunordered(a, b));
    // packed
    __m128d pa = _mm_set_pd(a, b), pb = _mm_set_pd(dr(), dr());
    __m128d pr = _mm_add_pd(_mm_mul_pd(pa, pb), _mm_div_pd(pa, _mm_add_pd(pb, _mm_set1_pd(1.0))));
    pr = _mm_addsub_pd(pr, _mm_hadd_pd(pa, pb));
    pr = _mm_xor_pd(pr, _mm_cmplt_pd(pa, pb));
    pr = _mm_max_pd(pr, _mm_min_pd(pa, pb));
    pr = _mm_round_pd(pr, _MM_FROUND_TO_NEG_INF | _MM_FROUND_NO_EXC);
    pr = _mm_blendv_pd(pr, pa, pb);
    pr = _mm_dp_pd(pr, pa, 0x31);
    double t2[2]; _mm_storeu_pd(t2, pr); memcpy(&bits, &t2[0], 8); mix(bits); memcpy(&bits, &t2[1], 8); mix(bits);
    __m128 fpa = _mm_set_ps(fa, fb, fr(), fr()), fpb = _mm_set_ps(fr(), fr(), fa, fb);
    __m128 fpr = _mm_add_ps(_mm_mul_ps(fpa, fpb), _mm_sqrt_ps(_mm_and_ps(fpa, _mm_castsi128_ps(_mm_set1_epi32(0x7fffffff)))));
    fpr = _mm_sub_ps(fpr, _mm_rcp_ps(fpb)); fpr = _mm_add_ps(fpr, _mm_rsqrt_ps(_mm_and_ps(fpb, _mm_castsi128_ps(_mm_set1_epi32(0x7fffffff)))));
    fpr = _mm_shuffle_ps(fpr, fpa, 0x1b); fpr = _mm_movehdup_ps(fpr); fpr = _mm_unpacklo_ps(fpr, fpb);
    fpr = _mm_cvtepi32_ps(_mm_cvttps_epi32(fpr)); fpr = _mm_hadd_ps(fpr, fpa);
    float t4[4]; _mm_storeu_ps(t4, fpr); mixbuf(t4, 16);
    // AVX / FMA 256-bit FP
    __m256d ya = _mm256_set_pd(a, b, dr(), dr()), yb = _mm256_set_pd(dr(), dr(), a, b);
    __m256d yr = _mm256_fmadd_pd(ya, yb, ya); yr = _mm256_fmsub_pd(yr, yb, ya); yr = _mm256_fnmadd_pd(yr, ya, yb);
    yr = _mm256_hadd_pd(yr, ya); yr = _mm256_permute_pd(yr, 5); yr = _mm256_permute2f128_pd(yr, ya, 0x21);
    yr = _mm256_max_pd(yr, _mm256_sqrt_pd(_mm256_andnot_pd(_mm256_set1_pd(-0.0), yb)));
    yr = _mm256_blend_pd(yr, ya, 0x6); yr = _mm256_round_pd(yr, _MM_FROUND_TO_NEAREST_INT | _MM_FROUND_NO_EXC);
    yr = _mm256_cvtepi32_pd(_mm256_cvttpd_epi32(yr));
    double t8[4]; _mm256_storeu_pd(t8, yr); mixbuf(t8, 32);
    __m256 za = _mm256_set_ps(fa, fb, fr(), fr(), fr(), fr(), fa, fb);
    __m256 zr = _mm256_fmadd_ps(za, za, za); zr = _mm256_rcp_ps(zr); zr = _mm256_dp_ps(zr, za, 0xf1);
    zr = _mm256_cvtph_ps(_mm256_cvtps_ph(zr, 0)); zr = _mm256_addsub_ps(zr, za);
    float t16[8]; _mm256_storeu_ps(t16, zr); mixbuf(t16, 32);
    mix((uint64_t)_mm256_movemask_pd(_mm256_cmp_pd(ya, yb, _CMP_LT_OQ)));
    mix((uint64_t)_mm256_movemask_ps(_mm256_cmp_ps(za, zr, _CMP_NEQ_UQ)));
    // x87
    long double la = a, lb = b, lr;
    lr = la * lb + la / (lb == 0 ? 1 : lb) - lb; unsigned char lbuf[16] = {0}; memcpy(lbuf, &lr, 10); mixbuf(lbuf, 10);
    lr = __builtin_sqrtl(la < 0 ? -la : la); memcpy(lbuf, &lr, 10); mixbuf(lbuf, 10);
    lr = __builtin_fmodl(la, lb == 0 ? 3 : lb); memcpy(lbuf, &lr, 10); mixbuf(lbuf, 10);
    if (a == a && a > -1e300 && a < 1e300) { lr = __builtin_sinl(la > 1e6 || la < -1e6 ? 1.0L : la); memcpy(lbuf, &lr, 10); mixbuf(lbuf, 10); }
    mix((uint64_t)(la < lb)); mix((uint64_t)(la == lb));
    int64_t li = (int64_t)(la == la && la < 9e18 && la > -9e18 ? la : 0); mix((uint64_t)li);
    // MXCSR flags
    unsigned csr = _mm_getcsr(); mix(csr & 0x3f); _mm_setcsr(csr & ~0x3fu);
    unsigned short sw; __asm__ volatile("fnstsw %0" : "=m"(sw)); mix(sw & 0x3f); __asm__ volatile("fnclex");
    acc = r; facc = fr_;
  }
  report("fp");
}

static void phase_mem(void) {
  static uint8_t big[(1 << 20) + 4096]; // 1 MiB + spill
  // unaligned + page-crossing loads/stores of every width, incl. SSE/AVX
  for (int i = 0; i < 20000; i++) {
    size_t o = (rnd() % ((1 << 20) - 64)); uint64_t v = rnd();
    o = (o & ~4095) + 4096 - (rnd() % 40); // near a page boundary
    memcpy(big + o, &v, 8); mix(*(uint32_t *)(big + o + 2)); mix(*(uint16_t *)(big + o + 5)); mix(*(uint64_t *)(big + o - 3));
    *(uint64_t *)(big + o + 1) = v * 3; *(uint32_t *)(big + o + 6) = (uint32_t)v; *(uint16_t *)(big + o + 3) = (uint16_t)v;
    _mm_storeu_si128((__m128i *)(big + o + 4), _mm_set_epi64x(v, ~v));
    _mm256_storeu_si256((__m256i *)(big + o + 9), _mm256_set_epi64x(v, ~v, v ^ 0x55, v + 1));
    uint64_t t[4]; _mm256_storeu_si256((__m256i *)t, _mm256_loadu_si256((const __m256i *)(big + o + 1))); mix(t[0]); mix(t[1]); mix(t[2]); mix(t[3]);
    _mm_storeu_si128((__m128i *)t, _mm_loadu_si128((const __m128i *)(big + o + 7))); mix(t[0]); mix(t[1]);
    // push/pop, lea, call/ret patterns
    uint64_t r1, r2;
    __asm__ volatile("pushq %[v]\n\tpushq %[o]\n\tpopq %[r1]\n\tpopq %[r2]" : [r1] "=r"(r1), [r2] "=r"(r2) : [v] "r"(v), [o] "r"((uint64_t)o) : "memory"); mix(r1); mix(r2);
    __asm__ volatile("leaq 0x123(%[a],%[b],4), %[r]" : [r] "=r"(r1) : [a] "r"(v), [b] "r"((uint64_t)o)); mix(r1);
    __asm__ volatile("leal -7(%k[a],%k[b],8), %k[r]" : [r] "=r"(r1) : [a] "r"(v), [b] "r"((uint64_t)o)); mix(r1);
    __asm__ volatile("leaw 3(%k[a]), %w[r]" : [r] "=r"(r1) : [a] "r"(v)); mix(r1 & 0xffff);
    // segment-relative (fs) access: TLS
    static __thread uint64_t tls = 5; tls += v; mix(tls);
    // movsx/movzx variants
    __asm__ volatile("movsbq %b[a], %[r]" : [r] "=r"(r1) : [a] "r"(v)); mix(r1);
    __asm__ volatile("movswl %w[a], %k[r]" : [r] "=r"(r1) : [a] "r"(v)); mix(r1);
    __asm__ volatile("movslq %k[a], %[r]" : [r] "=r"(r1) : [a] "r"(v)); mix(r1);
    __asm__ volatile("movzwq %w[a], %[r]" : [r] "=r"(r1) : [a] "r"(v)); mix(r1);
    __asm__ volatile("movzbl %b[a], %k[r]" : [r] "=r"(r1) : [a] "r"(v)); mix(r1);
    __asm__ volatile("movb %b[a], %b[r]" : [r] "+r"(r1) : [a] "r"(v)); mix(r1);
    __asm__ volatile("movw %w[a], %w[r]" : [r] "+r"(r1) : [a] "r"(v)); mix(r1);
    __asm__ volatile("movl %k[a], %k[r]" : [r] "+r"(r1) : [a] "r"(v)); mix(r1); // zero-extends
    // 8-bit high registers
    __asm__ volatile("movq %[a], %%rax\n\tmovb %%ah, %%bl\n\taddb %%al, %%bh\n\tmovq %%rbx, %[r]" : [r] "=r"(r1) : [a] "r"(v) : "rax", "rbx", "cc"); mix(r1 & 0xffff);
  }
  // heap churn: malloc/free/realloc patterns of a real allocator
  void *ptrs[256] = {0};
  for (int i = 0; i < 20000; i++) {
    int k = rnd() & 255; size_t n = rnd() % 5000;
    if (ptrs[k]) { mix(*(uint8_t *)ptrs[k]); free(ptrs[k]); ptrs[k] = 0; }
    else { ptrs[k] = malloc(n + 1); memset(ptrs[k], (int)i, n + 1); }
  }
  for (int k = 0; k < 256; k++) free(ptrs[k]);
  report("mem");
}

static int cmp_u64(const void *a, const void *b) { uint64_t x = *(const uint64_t *)a, y = *(const uint64_t *)b; return x < y ? -1 : x > y; }
static void phase_mixed(void) {
  // "real code": sort, hash table, printf formatting, string building — the kind of thing a CLI does
  static uint64_t arr[200000];
  for (int i = 0; i < 200000; i++) arr[i] = rnd();
  qsort(arr, 200000, 8, cmp_u64);
  for (int i = 0; i < 200000; i += 997) mix(arr[i]);
  char tmp[256];
  for (int i = 0; i < 20000; i++) { int n = snprintf(tmp, sizeof tmp, "%d %x %llu %.6f %s", (int)rnd(), (unsigned)rnd(), (unsigned long long)rnd(), (double)(int64_t)rnd() / 1e9, "abc"); mixbuf(tmp, n); }
  report("mixed");
}

int main(int argc, char **argv) {
  int reps = argc > 1 ? atoi(argv[1]) : 1;
  marker("start");
  for (int r = 0; r < reps; r++) {
    phase_alu(); phase_shift(); phase_muldiv(); phase_string(); phase_sse(); phase_avx2(); phase_fp(); phase_mem(); phase_mixed();
  }
  printf("FINAL        %016llx\n", (unsigned long long)h);
  marker("end");
  return 0;
}
