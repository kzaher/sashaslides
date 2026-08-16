// host-channel smoke test: open /dev/hvc1 raw, send a line, expect it echoed (harness --hc-echo)
#include <stdio.h>
#include <string.h>
#include <fcntl.h>
#include <unistd.h>
#include <termios.h>
#include <sys/select.h>
int main(int argc, char **argv) {
  const char *dev = argc > 1 ? argv[1] : "/dev/hvc1";
  int fd = open(dev, O_RDWR | O_NOCTTY);
  if (fd < 0) { perror(dev); return 1; }
  struct termios t; if (tcgetattr(fd, &t) == 0) { cfmakeraw(&t); tcsetattr(fd, TCSANOW, &t); }
  const char *msg = "ping from guest\n";
  write(fd, msg, strlen(msg));
  char buf[256]; int n = 0;
  for (int i = 0; i < 50 && n < (int) strlen(msg); i++) {
    fd_set r; FD_ZERO(&r); FD_SET(fd, &r); struct timeval tv = {0, 100000};
    if (select(fd + 1, &r, NULL, NULL, &tv) > 0) { int k = read(fd, buf + n, sizeof(buf) - 1 - n); if (k > 0) n += k; }
  }
  buf[n] = 0;
  printf("HCTEST got %d bytes: %s\n", n, buf);
  return n == (int) strlen(msg) && memcmp(buf, msg, n) == 0 ? 0 : 2;
}
