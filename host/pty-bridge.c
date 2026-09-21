// pty-bridge: 给无 tty 的父进程（Bun 宿主）提供真 pty 的子进程桥。
//
// 背景：node-pty 是 NAPI 原生模块，Bun 下加载成功但其 spawn-helper 起不来
// （实测 posix_spawnp failed）；macOS 自带 script(1) 又要求 stdin 必须是 tty
// （管道 stdin 直接 tcgetattr 报错）。Tauri 开发机必有 Xcode CLT（cc），
// 因此宿主首次需要 PTY 时用 cc 编译本文件为缓存二进制（~/.omp 下，按源码
// hash 失效），长期只编一次。
//
// 用法: pty-bridge <ctl-socket> <shell> <cwd> <cols> <rows>
//   stdin  = 父进程写入的 pty 输入（普通管道）
//   stdout = pty 输出（普通管道，子进程退出即 EOF）
//   ctl-socket = 父进程预先 listen 的 unix socket；连入后发 "r <cols> <rows>\n"
//                调整窗口尺寸（TIOCSWINSZ + SIGWINCH），实现 resize 语义。
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <fcntl.h>
#include <errno.h>
#include <signal.h>
#include <termios.h>
#include <sys/ioctl.h>
#include <sys/wait.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <util.h>

int main(int argc, char **argv) {
  if (argc < 6) { fprintf(stderr, "usage: pty-bridge <ctl> <shell> <cwd> <cols> <rows>\n"); return 2; }
  const char *ctlPath = argv[1], *shell = argv[2], *cwd = argv[3];
  int cols = atoi(argv[4]), rows = atoi(argv[5]);

  int master, slave;
  struct winsize ws;
  memset(&ws, 0, sizeof(ws));
  ws.ws_col = cols; ws.ws_row = rows;
  if (openpty(&master, &slave, NULL, NULL, &ws) < 0) { perror("openpty"); return 1; }

  pid_t pid = fork();
  if (pid == 0) {
    // 子进程：新会话 + 把 pty 接管为控制终端（shell 任务控制/清屏依赖 ctty）
    close(master);
    setsid();
#ifdef TIOCSCTTY
    ioctl(slave, TIOCSCTTY, 0);
#endif
    dup2(slave, 0); dup2(slave, 1); dup2(slave, 2);
    if (slave > 2) close(slave);
    if (chdir(cwd) < 0) { /* 目录失效不致命，留在原地 */ }
    char *args[] = { (char *)shell, "-i", NULL };
    execvp(shell, args);
    _exit(127);
  }
  close(slave);
  signal(SIGPIPE, SIG_IGN);

  // 连接控制 socket（父进程先 listen 好，最多重试 5s）
  int ctl = -1;
  for (int i = 0; i < 50 && ctl < 0; i++) {
    ctl = socket(AF_UNIX, SOCK_STREAM, 0);
    struct sockaddr_un addr;
    memset(&addr, 0, sizeof(addr));
    addr.sun_family = AF_UNIX;
    strncpy(addr.sun_path, ctlPath, sizeof(addr.sun_path) - 1);
    if (connect(ctl, (struct sockaddr *)&addr, sizeof(addr)) < 0) { close(ctl); ctl = -1; usleep(100000); }
  }
  if (ctl < 0) { fprintf(stderr, "ctl connect failed: %s\n", strerror(errno)); return 1; }

  char buf[65536];
  for (;;) {
    fd_set rfds;
    FD_ZERO(&rfds);
    FD_SET(0, &rfds);       // 父进程 -> pty 输入
    FD_SET(master, &rfds);  // pty -> 父进程输出
    int maxfd = master > 0 ? master : 0;
    if (ctl >= 0) { FD_SET(ctl, &rfds); if (ctl > maxfd) maxfd = ctl; }
    if (select(maxfd + 1, &rfds, NULL, NULL, NULL) < 0) {
      if (errno == EINTR) continue;
      break;
    }
    if (FD_ISSET(0, &rfds)) {
      ssize_t n = read(0, buf, sizeof(buf));
      if (n <= 0) { close(master); break; }  // 父进程断开：PTY 结束
      ssize_t off = 0;
      while (off < n) { ssize_t w = write(master, buf + off, n - off); if (w < 0) break; off += w; }
    }
    if (FD_ISSET(master, &rfds)) {
      ssize_t n = read(master, buf, sizeof(buf));
      if (n <= 0) break;  // 子进程侧 pty 关闭
      ssize_t off = 0;
      while (off < n) { ssize_t w = write(1, buf + off, n - off); if (w < 0) break; off += w; }
    }
    if (ctl >= 0 && FD_ISSET(ctl, &rfds)) {
      char line[128];
      ssize_t n = read(ctl, line, sizeof(line) - 1);
      if (n <= 0) { close(ctl); ctl = -1; }  // 父进程关闭 ctl：resize 能力废弃，PTY 继续跑
      else {
        line[n] = 0;
        int c, r;
        if (sscanf(line, "r %d %d", &c, &r) == 2 && c > 0 && r > 0) {
          struct winsize nws;
          memset(&nws, 0, sizeof(nws));
          nws.ws_col = c; nws.ws_row = r;
          ioctl(master, TIOCSWINSZ, &nws);
          kill(pid, SIGWINCH);
        }
      }
    }
    int status;
    if (waitpid(pid, &status, WNOHANG) == pid) break;  // 子进程退出：桥随之退出
  }
  kill(pid, SIGHUP);
  return 0;
}
