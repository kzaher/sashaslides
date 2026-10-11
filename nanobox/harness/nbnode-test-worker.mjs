// Runtime-side test client for --nbnode-test: runs in a worker_thread (the VM thread never yields to
// its event loop, so promises can't resolve there — same split as the browser: VM worker + runtime worker).
import { parentPort, workerData } from "worker_threads";
import fsSync from "fs";
await import("../web/native/proto.js"); await import("../web/native/hcring.js"); await import("../web/native/guest.js");
const g = NanoboxGuest.connect({ ringSab: workerData.ringSab, inSab: workerData.inSab });
const T0 = Date.now(); const say = (m) => fsSync.writeSync(2, `[nbnode-test +${Date.now() - T0}ms] ${m}\n`);
g.onLog = (t) => say("guest log: " + t);
g.onChildOut = (cid, fd, b) => say(`child ${cid} fd${fd}: ${JSON.stringify(new TextDecoder().decode(b))}`);
g.onChildExit = (cid, code, sig) => say(`child ${cid} exit code=${code} sig=${sig}`);
g.onStdin = (b) => say(`stdin ${JSON.stringify(new TextDecoder().decode(b))}`);
// NBNODE_TEST_MODE=shell — the sandbox page's SPLIT VIEW mechanism, verified without a browser:
// the shim runs as a BACKGROUND service beside a foreground guest program, and the host spawns an
// interactive /bin/sh on a pty through it and pins that pty to the PANE's geometry (CHILD_RESIZE).
if (process.env.NBNODE_TEST_MODE === "shell") {
  const COLS = Number(process.env.NB_SHELL_COLS || 137), ROWS = Number(process.env.NB_SHELL_ROWS || 41);
  let out = "";
  g.onChildOut = (cid, fd, b) => { const t = new TextDecoder().decode(b); out += t; fsSync.writeSync(2, t.replace(/\r/g, "")); };
  g.onHello = async (h) => {
    say(`HELLO argv=${JSON.stringify(h.argv)} cwd=${h.cwd} pid=${h.pid} consoleTty=${h.cols}x${h.rows} isatty=${h.isatty}`);
    try {
      await g.spawn(7, ["/bin/sh", "-i"], [`COLUMNS=${COLS}`, `LINES=${ROWS}`, "TERM=xterm-256color", "PS1=nbsh$ ", "HOME=/root", "PATH=/usr/local/bin:/bin:/usr/bin"], "/root", 2);
      say(`spawned /bin/sh -i on a pty; CHILD_RESIZE -> ${COLS}x${ROWS}`);
      await g.childResize(7, COLS, ROWS);
      const typed = (s) => g.childStdin(7, new TextEncoder().encode(s));
      await new Promise((r) => setTimeout(r, 400));
      typed("unset COLUMNS LINES; printf NBSH-SIZE=; stty size\n");   // NOT $(stty size): in a command substitution busybox stty falls back to the COLUMNS/LINES env
      typed("echo NBSH-PS=$(ps | wc -l)\n");
      typed("ps\n");
      typed("echo NBSH-WROTE=$( (echo split-shell > /tmp/nbsh && cat /tmp/nbsh) )\n");
      typed("echo NBSH-DONE\n");
      await new Promise((r) => setTimeout(r, 3500));
      // a SECOND resize while the shell is idle at its prompt (the split view's divider drag)
      await g.childResize(7, 61, 17);
      await new Promise((r) => setTimeout(r, 300));
      typed("printf NBSH-SIZE2=; stty size\n");
      typed("echo NBSH-DONE2\n");
      await new Promise((r) => setTimeout(r, 2500));
      const s2 = (out.match(/NBSH-SIZE2=(\d+) (\d+)/) || []).slice(1).map(Number);
      const ok2 = s2[0] === 17 && s2[1] === 61;
      say(`RESULT after a second CHILD_RESIZE(61x17): stty rows ${s2[0]} cols ${s2[1]} -> ${ok2 ? "MATCH" : "MISMATCH"}`);
      const size = (out.match(/NBSH-SIZE=(\d+) (\d+)/) || []).slice(1).map(Number);
      const ok = size.length === 2 && size[0] === ROWS && size[1] === COLS && ok2;
      say(`RESULT stty size in the pty child = rows ${size[0]} cols ${size[1]} (asked ${ROWS}x${COLS}) -> ${ok ? "MATCH" : "MISMATCH"}`);
      say(`RESULT wrote+read /tmp/nbsh: ${/NBSH-WROTE=split-shell/.test(out) ? "ok" : "FAILED"}`);
      say(`RESULT the shell saw ${(out.match(/NBSH-PS=(\d+)/) || [])[1] || "?"} lines of ps`);
      say(`SHIM-BESIDE-${ok && /NBSH-WROTE=split-shell/.test(out) && /NBSH-DONE/.test(out) ? "OK" : "FAIL"}`);
      g.exit(ok ? 0 : 1);
    } catch (e) { say("ERROR " + (e && e.stack || e)); say("SHIM-BESIDE-FAIL"); g.exit(1); }
  };
} else
g.onHello = async (h) => {
  say(`HELLO argv=${JSON.stringify(h.argv)} cwd=${h.cwd} pid=${h.pid} tty=${h.cols}x${h.rows} isatty=${h.isatty} env=${h.env.length} vars`);
  try {
    let t = Date.now();
    const st = await g.stat("/"); say(`stat / mode=${(Number(st.mode) & 0o777).toString(8)} ino=${st.ino} (${Date.now() - t} ms round trip)`);
    t = Date.now(); for (let i = 0; i < 20; i++) await g.stat("/"); say(`20 sequential async stat round trips: ${Date.now() - t} ms`);
    t = Date.now(); for (let i = 0; i < 20; i++) g.sync.stat("/"); say(`20 sequential SYNC stat round trips: ${Date.now() - t} ms`);
    t = Date.now(); const bb = g.sync.readFile("/bin/busybox"); say(`sync readFile /bin/busybox ${bb.length} bytes in ${Date.now() - t} ms`);
    try { g.sync.stat("/nonexistent"); } catch (e) { say(`sync stat /nonexistent -> ${e.code} errno ${e.errno}`); }
    for (const d of ["/usr/local/bin", "/tmp", "/bundle/nb"]) { try { const ents = await g.readdir(d); say(`readdir ${d}: ${ents.map((e) => e.name).join(",")}`); } catch (e) { say(`readdir ${d}: ${e.message}`); } }
    for (const f of ["/usr/local/bin/codex", "/bin/busybox"]) { try { t = Date.now(); const data = await g.readFile(f); say(`readFile ${f}: ${data.length} bytes in ${Date.now() - t} ms (${(data.length / 1e6 / ((Date.now() - t) / 1000)).toFixed(2)} MB/s wall)`); } catch (e) { say(`readFile ${f}: ${e.message}`); } }
    const fd = await g.open("/tmp/nbtest.txt", 0o1101, 0o644); await g.write(fd, new TextEncoder().encode("hello from host V8\n")); await g.close(fd);
    say("wrote+read back /tmp/nbtest.txt: " + JSON.stringify(new TextDecoder().decode(await g.readFile("/tmp/nbtest.txt"))));
    const pid = await g.spawn(1, ["/bin/sh", "-c", "echo child says hi; uname -a; exit 3"], [], "/", 1); say(`spawned pid ${pid}`);
    say("ttySize " + JSON.stringify(await g.ttySize().catch((e) => e.code)));
    g.stdout(new TextEncoder().encode("\r\n[host] printed through the guest tty\r\n"));
    setTimeout(() => { say("exit 0"); g.exit(0); }, 1500);
  } catch (e) { say("ERROR " + e.message); g.exit(1); }
};
