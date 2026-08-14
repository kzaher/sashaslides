// nanobox controller — ties the picked local folders, the mount registry, the sync engine, and the
// VM together. Used by both index.html (real flow) and demo.html.
//
// Model:
//   - The FIRST folder the user picks becomes HOME (registry.home.vmPath, default /root).
//   - `.nanobox/mounts.json` lives INSIDE home, so the mount table rides along on the user's disk.
//   - On a later session, picking home reloads the table and recreates the other mounts
//     (re-permissioning persisted handles; anything unavailable is reported for a fresh pick).

import { FsaStore } from "./adapters/fsa-store.js";
import { VmStore } from "./adapters/vm.js";
import { runSync } from "./lib/sync.js";
import {
  emptyRegistry, parseRegistry, serializeRegistry, addMount, removeMount,
  requiredHandleKeys, planRemount, REGISTRY_PATH,
} from "./lib/mounts.js";
import {
  putHandle, getHandle, resolvableKeys, ensurePermission,
} from "./adapters/idb-handles.js";
import { toText } from "./lib/util.js";

export class Nanobox {
  constructor(vm, { conflict = "keep-both" } = {}) {
    this.vm = vm;
    this.conflict = conflict;
    this.registry = null;
    this.stores = new Map(); // handleKey -> { fsa, vmStore, vmPath, base }
    this.log = () => {};
    this.onChange = () => {};
  }

  _register(handleKey, fsa, vmPath) {
    this.stores.set(handleKey, { fsa, vmStore: new VmStore(this.vm, vmPath), vmPath, base: new Map() });
  }

  async syncOne(handleKey) {
    const s = this.stores.get(handleKey);
    if (!s) return null;
    await s.vmStore.pull();
    const res = await runSync(s.fsa, s.vmStore, s.base, { conflict: this.conflict });
    await s.vmStore.commit();
    s.base = res.nextBase;
    if (res.conflicts.length) this.log(`⚠ ${res.conflicts.length} conflict(s) in ${s.vmPath}: ${res.conflicts.map((c) => c.path).join(", ")}`);
    return res;
  }

  async syncAll() {
    for (const key of this.stores.keys()) await this.syncOne(key);
    this.onChange();
  }

  // Pick #1 → HOME. Loads the mount table and recreates whatever it can.
  async setHome(dirHandle) {
    await putHandle("home", dirHandle);
    if (!(await ensurePermission(dirHandle))) throw new Error("permission denied for home folder");
    const fsa = new FsaStore(dirHandle);

    // Load an existing mount table from the picked folder, if any.
    this.registry = await this._loadRegistry(fsa);
    this._register(this.registry.home.handleKey, fsa, this.registry.home.vmPath);
    this.vm.setCwd?.(this.registry.home.vmPath);
    this.log(`home → ${this.registry.home.vmPath}  (from your folder)`);
    await this.syncOne(this.registry.home.handleKey);

    // Recreate the other mounts from the table.
    const avail = await resolvableKeys(requiredHandleKeys(this.registry));
    const plan = planRemount(this.registry, avail);
    const needRepick = [...plan.needsRepick];
    for (const m of plan.ready) {
      const h = await getHandle(m.handleKey);
      if (h && (await ensurePermission(h))) {
        this._register(m.handleKey, new FsaStore(h), m.vmPath);
        await this.syncOne(m.handleKey);
        this.log(`remounted ${m.vmPath}  (${m.label})`);
      } else {
        needRepick.push(m);
      }
    }
    for (const m of needRepick) this.log(`↻ needs re-pick: ${m.vmPath} (${m.label}) — grant it again`);
    this.needsRepick = needRepick;

    await this._saveRegistry();
    this.onChange();
    return { plan, needRepick };
  }

  // Pick #N → an extra mount at vmPath.
  async addMount(dirHandle, vmPath, label) {
    if (!this.registry) throw new Error("pick a home folder first");
    const m = addMount(this.registry, { vmPath, label });
    await putHandle(m.handleKey, dirHandle);
    if (!(await ensurePermission(dirHandle))) { removeMount(this.registry, m.id); throw new Error("permission denied"); }
    this._register(m.handleKey, new FsaStore(dirHandle), m.vmPath);
    await this.syncOne(m.handleKey);
    await this._saveRegistry();
    this.log(`mounted ${m.vmPath}  (${m.label})`);
    this.onChange();
    return m;
  }

  async removeMountAt(id) {
    const m = this.registry.mounts.find((x) => x.id === id || x.vmPath === id);
    if (!m) return;
    removeMount(this.registry, m.id);
    this.stores.delete(m.handleKey);
    await this._saveRegistry();
    this.onChange();
  }

  mountList() {
    if (!this.registry) return [];
    return [
      { ...this.registry.home, label: "home", id: "home", isHome: true },
      ...this.registry.mounts,
    ];
  }

  async _loadRegistry(fsaHome) {
    try {
      const bytes = await fsaHome.read(REGISTRY_PATH);
      const reg = parseRegistry(toText(bytes));
      this.log(`loaded mount table (${reg.mounts.length} extra mount(s))`);
      return reg;
    } catch {
      return emptyRegistry();
    }
  }

  async _saveRegistry() {
    const home = this.stores.get(this.registry.home.handleKey);
    if (!home) return;
    await home.fsa.write(REGISTRY_PATH, serializeRegistry(this.registry));
    await this.syncOne(this.registry.home.handleKey); // land it in the VM too
  }
}

export function fsApiAvailable() {
  return typeof window !== "undefined" && "showDirectoryPicker" in window;
}
