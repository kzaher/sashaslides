// Node-style errno errors + the recording of "APIs Claude Code touched that we don't implement".
export const ERRNO = {
  EPERM: 1, ENOENT: 2, ESRCH: 3, EINTR: 4, EIO: 5, EBADF: 9, ECHILD: 10, EAGAIN: 11, ENOMEM: 12, EACCES: 13, EEXIST: 17, EXDEV: 18,
  ENOTDIR: 20, EISDIR: 21, EINVAL: 22, EMFILE: 24, ENOTTY: 25, EFBIG: 27, ENOSPC: 28, ESPIPE: 29, EROFS: 30, EPIPE: 32, ERANGE: 34,
  ENOSYS: 38, ENOTEMPTY: 39, ELOOP: 40, ENOTSUP: 95, EADDRINUSE: 98, EADDRNOTAVAIL: 99, ENETUNREACH: 101, ECONNRESET: 104,
  ENOTCONN: 107, ETIMEDOUT: 110, ECONNREFUSED: 111, EHOSTUNREACH: 113, ENOTFOUND: -3008, ECANCELED: 125,
};
const MSG = {
  EPERM: "operation not permitted", ENOENT: "no such file or directory", ESRCH: "no such process", EIO: "i/o error", EBADF: "bad file descriptor",
  ECHILD: "no child processes", EAGAIN: "resource temporarily unavailable", EACCES: "permission denied", EEXIST: "file already exists",
  EXDEV: "cross-device link not permitted", ENOTDIR: "not a directory", EISDIR: "illegal operation on a directory", EINVAL: "invalid argument",
  EMFILE: "too many open files", ENOTTY: "inappropriate ioctl for device", ENOSPC: "no space left on device", ESPIPE: "invalid seek",
  EROFS: "read-only file system", EPIPE: "broken pipe", ENOSYS: "function not implemented", ENOTEMPTY: "directory not empty",
  ELOOP: "too many symbolic links encountered", ENOTSUP: "operation not supported", EADDRINUSE: "address already in use",
  ENETUNREACH: "network is unreachable", ECONNRESET: "connection reset by peer", ENOTCONN: "socket is not connected",
  ETIMEDOUT: "connection timed out", ECONNREFUSED: "connection refused", EHOSTUNREACH: "no route to host", ENOTFOUND: "getaddrinfo ENOTFOUND",
  ECANCELED: "operation canceled",
};
import { reportError } from "./report.js";
// ENOENT/EEXIST/ENOTDIR on stat/access/open are the CLI probing (thousands, expected); everything
// else — and any errno on write-side syscalls — is worth a server-side line with the caller's stack
const QUIET = new Set(["ENOENT", "EEXIST", "ENOTDIR", "ENOTEMPTY"]);
const PROBE = new Set(["stat", "lstat", "access", "open", "readlink", "readdir", "realpath", "scandir", "readFile", "readfile", "read"]);
export function errnoError(code, syscall, path, dest) {
  let msg = `${code}: ${MSG[code] || code}, ${syscall}`;
  if (path != null) msg += ` '${path}'`;
  if (dest != null) msg += ` -> '${dest}'`;
  const e = new Error(msg);
  e.code = code; e.errno = -(ERRNO[code] || 1); e.syscall = syscall;
  if (path != null) e.path = path;
  if (dest != null) e.dest = dest;
  if (!(QUIET.has(code) && PROBE.has(syscall))) reportError("errno", e);
  return e;
}
export function isErrno(e) { return e && typeof e === "object" && typeof e.code === "string" && typeof e.errno === "number"; }
// backend errors travel as {__errno: code, syscall, path} over RPC; rehydrate on this side
export function rethrow(e, syscall, path) {
  if (e && e.__errno) throw errnoError(e.__errno, e.syscall || syscall, e.path != null ? e.path : path, e.dest);
  throw e;
}
export function nodeError(code, message) { const e = new Error(message); e.code = code; return e; }
