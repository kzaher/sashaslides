// host-channel throughput: guest asks for N bytes ("bench N\n"), host streams them; guest times it
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <fcntl.h>
#include <unistd.h>
#include <termios.h>
#include <time.h>
int main(int argc, char **argv) {
  long want = argc > 1 ? atol(argv[1]) : 4 << 20;
  int fd = open("/dev/hvc1", O_RDWR | O_NOCTTY); if (fd < 0) { perror("hvc1"); return 1; }
  struct termios t; tcgetattr(fd, &t); cfmakeraw(&t); tcsetattr(fd, TCSANOW, &t);
  char req[64]; int rl = snprintf(req, sizeof req, "bench %ld\n", want); write(fd, req, rl);
  struct timespec a, b; clock_gettime(CLOCK_MONOTONIC, &a);
  static char buf[65536]; long got = 0;
  while (got < want) { int k = read(fd, buf, sizeof buf); if (k <= 0) break; got += k; }
  clock_gettime(CLOCK_MONOTONIC, &b);
  double s = (b.tv_sec - a.tv_sec) + (b.tv_nsec - a.tv_nsec) / 1e9;
  printf("HCBENCH got %ld bytes in %.3f s guest-time (%.1f MB/s)\n", got, s, got / 1e6 / (s > 0 ? s : 1e-9));
  // guest -> host: send 1 MB
  memset(buf, 'x', sizeof buf); clock_gettime(CLOCK_MONOTONIC, &a); long sent = 0;
  while (sent < (1 << 20)) { int k = write(fd, buf, sizeof buf); if (k <= 0) break; sent += k; }
  clock_gettime(CLOCK_MONOTONIC, &b); s = (b.tv_sec - a.tv_sec) + (b.tv_nsec - a.tv_nsec) / 1e9;
  printf("HCBENCH sent %ld bytes in %.3f s (%.1f MB/s)\n", sent, s, sent / 1e6 / (s > 0 ? s : 1e-9));
  return 0;
}
