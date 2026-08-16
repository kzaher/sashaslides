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
