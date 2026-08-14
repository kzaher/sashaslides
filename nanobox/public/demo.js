// Demo wiring: boot a FakeVm with a seeded home, a working terminal, and claude/codex "installed".
// Runs in any Chromium tab with no folder pick required (so it also captures cleanly in automation).

import { createFakeVm } from "./adapters/vm.js";
import { Nanobox, fsApiAvailable } from "./nanobox.js";

const screen = document.getElementById("screen");
const cmd = document.getElementById("cmd");
const vmbadge = document.getElementById("vmbadge");

function write(text, cls = "o") {
  const span = document.createElement("span");
  span.className = cls;
  span.textContent = text;
  screen.appendChild(span);
  screen.scrollTop = screen.scrollHeight;
}
function line(text = "", cls = "o") { write(text + "\n", cls); }

const CLAUDE_BANNER = String.raw`
        \ | /
      -- claude --      Claude Code  ·  v2.0.0
        / | \
`;

const vm = createFakeVm();
vm.setCwd("/root");

async function seed() {
  await vm.exec('echo "# my project (home = the folder you picked)" > /root/README.md');
  await vm.exec('echo "print(\'hello from nanobox\')" > /root/hello.py');
  await vm.exec("mkdir /root/.nanobox");
}

async function boot() {
  await seed();
  vmbadge.innerHTML = '<span class="dot"></span>VM: <b>FakeVm ready</b>';
  line("nanobox — Linux in the browser", "accent");
  line("Booting FakeVm… ok. claude + codex preinstalled on PATH.\n");
  write(CLAUDE_BANNER, "accent");
  line("claude + codex are the REAL CLIs (proxied to the backend via /api/agent).", "o");
  line('Try a real prompt:  claude write a haiku about sandboxes', "accent");
  line('Filesystem is local:  ls   cat README.md   echo hi > note.txt', "o");
  line("");
  cmd.focus();
}

async function runCommand(input) {
  line(`root@nanobox:${vm.getCwd().replace("/root", "~")}$ ${input}`, "u");
  const [cmd, ...rest] = input.trim().split(/\s+/);
  if (cmd === "claude" || cmd === "codex") {
    const prompt = rest.join(" ");
    if (!prompt) { line(`${cmd}: real ${cmd === "claude" ? "Claude Code" : "Codex"} CLI wired in. Usage: ${cmd} <your prompt>`, "o"); return; }
    await runAgent(cmd, prompt);
    return;
  }
  const { stdout, stderr } = await vm.exec(input);
  if (stdout) write(stdout, "o");
  if (stderr) write(stderr, "e");
}

// Call the REAL claude/codex CLI running in the backend (server /api/agent).
async function runAgent(tool, prompt) {
  write(`${tool}: `, "accent"); write("running the real CLI…\n", "o");
  const t0 = performance.now();
  try {
    const r = await fetch("/api/agent", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tool, prompt }) });
    const j = await r.json();
    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    line(`${tool} (${secs}s${j.code != null ? `, exit ${j.code}` : ""}):`, "accent");
    write((j.output || "(no output)") + "\n", j.ok ? "o" : "e");
  } catch (e) {
    line(`${tool}: backend unreachable (${e.message}). Is the nanobox server running?`, "e");
  }
}

cmd.addEventListener("keydown", async (e) => {
  if (e.key !== "Enter") return;
  const input = cmd.value;
  cmd.value = "";
  if (input.trim()) await runCommand(input);
});

document.getElementById("run-claude").addEventListener("click", () => runCommand("claude write a haiku about running Linux in a browser tab"));
document.getElementById("run-codex").addEventListener("click", () => runCommand("codex print a one-line hello from codex"));

// Optional: connect a real local folder as home (needs a user gesture; Chromium only).
document.getElementById("connect").addEventListener("click", async () => {
  if (!fsApiAvailable()) { line("File System Access API unavailable — use Chrome/Edge.", "e"); return; }
  try {
    const dir = await window.showDirectoryPicker({ mode: "readwrite" });
    const box = new Nanobox(vm, { conflict: "keep-both" });
    box.log = (m) => line("· " + m, "o");
    line(`Connecting "${dir.name}" as home /root …`, "accent");
    await box.setHome(dir);
    line("Synced. Files created in the VM now write back to your folder.", "o");
    window.__nanobox = box;
  } catch (err) {
    line("connect cancelled: " + err.message, "e");
  }
});

// expose for automation/debugging
window.__vm = vm;
window.__runCommand = runCommand;

boot();
