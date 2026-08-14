// Real flow: pick a home folder, add mounts, watch the mount table persist into home.
// Uses the FakeVm as the backend so the whole loop is exercisable today; swap createCheerpxVm()
// once its ADAPT regions are wired.

import { createFakeVm } from "./adapters/vm.js";
import { Nanobox, fsApiAvailable } from "./nanobox.js";

const app = document.getElementById("app");

if (!fsApiAvailable()) {
  app.innerHTML = `<div class="unsupported">This needs the File System Access API — open in Chrome, Edge, or Brave (Chromium).</div>`;
} else {
  app.appendChild(document.getElementById("main-tpl").content.cloneNode(true));

  const vm = createFakeVm();
  const box = new Nanobox(vm, { conflict: "keep-both" });
  const logEl = document.getElementById("log");
  const mountsEl = document.getElementById("mounts");
  const repickEl = document.getElementById("repick");

  box.log = (m) => { logEl.textContent += m + "\n"; logEl.scrollTop = logEl.scrollHeight; };
  box.onChange = renderMounts;

  function renderMounts() {
    mountsEl.innerHTML = "";
    for (const m of box.mountList()) {
      const div = document.createElement("div");
      div.className = "mount" + (m.isHome ? " home" : "");
      div.innerHTML = `<div><div class="vp">${m.vmPath}</div><div class="lbl">${m.label}${m.isHome ? " · home" : ""}</div></div>`;
      if (!m.isHome) {
        const b = document.createElement("button");
        b.className = "ghost"; b.textContent = "unmount";
        b.onclick = () => box.removeMountAt(m.id);
        div.appendChild(b);
      }
      mountsEl.appendChild(div);
    }
    repickEl.textContent = (box.needsRepick || []).length
      ? "Re-pick needed: " + box.needsRepick.map((m) => m.vmPath).join(", ")
      : "";
    document.getElementById("add-area").style.display = box.registry ? "" : "none";
  }

  document.getElementById("pick-home").onclick = async () => {
    try {
      const dir = await window.showDirectoryPicker({ mode: "readwrite" });
      await box.setHome(dir);
    } catch (e) { box.log("home pick cancelled: " + e.message); }
  };

  document.getElementById("add-mount").onclick = async () => {
    const vmPath = document.getElementById("mount-path").value.trim() || "/mnt/data";
    try {
      const dir = await window.showDirectoryPicker({ mode: "readwrite" });
      await box.addMount(dir, vmPath, dir.name);
    } catch (e) { box.log("add mount failed: " + e.message); }
  };

  window.__nanobox = box;
}
