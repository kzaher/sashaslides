# Hosting untrusted user shells in hardened microVMs

Status: design, from four research streams (VM hardening, VM-escape history, layered filesystem,
blob storage). Identity and control plane are pending a fifth stream and marked as such.

Every load-bearing claim below carries a primary source. Vendor self-reported numbers are marked
`[vendor]`; paper numbers `[paper]`. Claims that could not be confirmed from a primary source are
listed in **Unconfirmed** at the end rather than smoothed over.

---

## Read this first — the design in plain language

**What we are building.** Each user gets their own small Linux virtual machine. They get a shell in
it. It starts in well under a second, their files are still there next time, and if they do something
hostile inside it they cannot reach us or any other user.

**The four choices, one line each:**

| Question | Answer | Why |
|---|---|---|
| What runs the VM? | **Firecracker**, on Linux KVM | Smallest attack surface of anything available, and it ships the tooling to lock itself down |
| Where does the filesystem come from? | A **read-only virtual disk** whose contents are fetched from storage on demand, in 512 KB pieces | You never copy a whole image to start a VM — you fetch only the pieces actually read |
| Where do the pieces live? | **Garage** (small) or **Ceph** (bigger) for the pieces; **FoundationDB** for the index | Those two self-heal without an operator. FoundationDB holds the index, never the data |
| How does the user get in? | Browser terminal -> our gateway -> a tiny agent inside the VM | The login decision happens on **our** side. The VM has no network at all |

### How a filesystem actually works here — the key idea

A filesystem is **a list of content hashes** (a "manifest"). The actual bytes are stored once,
addressed by their hash, and shared by every VM that needs them.

```
manifest for alice's VM            the shared chunk store
  chunk 0 -> sha256:a1b2...          sha256:a1b2...  [512 KB of bytes]
  chunk 1 -> sha256:c3d4...   ──>    sha256:c3d4...  [512 KB of bytes]
  chunk 2 -> sha256:e5f6...          sha256:e5f6...  [512 KB of bytes]
  ...                                ... shared across all users ...
```

Three consequences, and they are the whole reason for this design:

1. **"Mount an arbitrary filesystem" just means "point a VM at a different manifest."** It costs the
   size of the manifest (a few MB for a 16 GB image), not the size of the image. That is why it is
   effectively instant and why arbitrary images are cheap.
2. **Lazy loading is automatic.** The VM asks for disk block N; if we don't have that chunk locally
   we fetch it, then hand it over. Nothing is "loaded" in advance unless we choose to.
3. **Deduplication is free.** Ten thousand users on the same base image share one copy of every
   chunk, including in the host's memory cache.

**Eager vs lazy**, which you asked for specifically: don't maintain a list of files to preload. Lay
the files you want eagerly next to each other on the virtual disk, and the guest's own kernel
read-ahead fetches them as a side effect of reading the first one. The only thing worth recording is
*where the eager region ends*. For big files (model weights and such), each gets its own contiguous
region, so reading it streams. Details and the evidence are in §3.6.

**Writes** go to a second, private virtual disk per VM, copy-on-write at 64 KB granularity. So
writing one byte into a 5 GB file costs 64 KB, not 5 GB. That matters enough that §4.1 explains why
the obvious alternative (overlayfs) is the wrong choice for large files.

### How it boots in under a second

Boot is **not** the slow part. Firecracker reaches the guest's init in **under 125 ms**. The slow
part is fetching filesystem chunks over the network, so that is what the design attacks:

| | Warm (user returns to the same host) | Cold (user moved to a new host) |
|---|---|---|
| Starting Firecracker and booting Linux | ~125 ms | ~125 ms |
| Fetching the chunks the boot actually reads | local cache, <100 µs each | zone cache, ~2.75 ms each |
| **Total** | **~0.2-0.4 s** | **~1-3 s** |

So: a three-level chunk cache (this host -> this datacenter -> blob storage), and **send a returning
user back to the host that already has their chunks**. If that is still not fast enough, keep a few
VMs pre-booted and hand one over at login — the published arithmetic is that one spare VM covers 8
starts per second.

**We do not use VM snapshots**, even though that sounds like the obvious way to make resume instant.
§7.1 gives four reasons; the short version is that a snapshot would pin each user to one exact CPU
model, which breaks the ability to move them when a machine dies — and it would not help anyway,
because it removes the 125 ms, not the chunk fetching that actually dominates.

### How it stays secure with a hostile user inside

Three ideas, in order of importance:

1. **Give the VM almost no devices.** Nearly every VM escape in history has been a bug in emulated
   hardware, so the VM gets five things and nothing else: a read-only disk, a private writable disk,
   one communication channel for the shell, a random-number source, and a reset button. **No network
   card. No shared folders with the host** — that one is non-negotiable, and §2.2 has the CVEs.
2. **Decide who gets in on our side, never inside the VM.** No SSH server in the guest. The shell
   arrives over a host-controlled channel, and the little agent in the VM just moves bytes — it
   never decides anything.
3. **Wrap the VM process itself.** Its own user account, its own network namespace, its own resource
   limits, a restricted system-call list, and hyper-threading disabled on the host (that last one is
   what stops one VM from spying on another through the CPU).

### Jargon you will hit below

| Term | Means |
|---|---|
| **microVM** | A VM with almost no emulated hardware, so it boots in milliseconds |
| **Firecracker** | Amazon's open-source microVM runner; what AWS Lambda uses |
| **KVM** | The virtualization built into the Linux kernel; Firecracker drives it |
| **virtio-blk** | The standard "virtual disk" interface a guest sees |
| **dm-verity** | Linux feature that checks every disk block against a hash tree as it is read, so corrupt or substituted data fails instead of being trusted |
| **CoW (copy-on-write)** | Writes go to a private layer instead of modifying the shared original |
| **vsock** | A socket between host and guest that needs no network |
| **jailer** | Firecracker's helper that drops privileges before starting a VM |
| **manifest** | The list of content hashes that defines one filesystem |
| **chunk** | One 512 KB piece of a filesystem, named by its own hash |

Everything after this point is the evidence, the alternatives considered, and the parts that are
still unverified. Read §0 next if you only want the things that rule options out.

---

## 0. Findings that remove options

Read this section first. Each item kills a design that is still widely recommended, so each is a
place where following current advice would have cost real work.

**0.1 EROFS-over-fscache is gone from mainline.** Removed by `c37460cd9b2f` *"erofs: remove fscache
backend entirely"* (2026-06-22, erofs-for-7.2-rc1), after deprecation in v6.12 (`0d442ce0b302`);
cachefiles' on-demand mode followed in `949eb95d5bcc` *"cachefiles,netfs: sunset ondemand mode"*
(2026-08-12). `fs/erofs/fscache.c` and `fs/cachefiles/ondemand.c` resolve at tag `v6.18` and 404 on
master; `fsid=` is gone from `erofs.rst` and `CACHEFILES_ONDEMAND` from `fs/cachefiles/Kconfig`.
This was the one lazy-loading path that ran in-kernel rather than through FUSE. **Any guide
recommending Nydus's fscache / "fast mode" for RAFS v6 describes an interface that no longer
exists.** What remains in-kernel is exactly one combination: EROFS file-backed mounts
(`CONFIG_EROFS_FS_BACKED_BY_FILE`, v6.12) plus fanotify pre-content hooks (`FAN_PRE_ACCESS`, v6.14)
with a userspace HSM daemon serving misses.

**0.2 A lazily-populated overlayfs lower is unusable, online and offline.** `overlayfs.rst`:
*"Changes to the underlying filesystems while part of a mounted overlay filesystem are not
allowed."* And, decisively: *"Offline changes to the lower tree are only allowed if the 'metacopy',
'index', 'xino' and 'redirect_dir' features have not been used."* A redirect-based content-addressed
base **necessarily** uses those features, so unmounting first does not rescue it. overlayfs also has
no userspace upcall for an absent lower object, so there is nothing to implement fetch-on-miss
against.

**0.3 Cloud Hypervisor disqualifies itself, in writing.** `docs/threat-model.md`: *"Cloud Hypervisor
is not hardened against denial of service attacks from the guest kernel"*, and *"Until support for
blocking AF_UNIX sockets is implemented in Landlock and used by Cloud Hypervisor, **sandbox escapes
will not be considered security vulnerabilities**."* It also owns the only two 2026 guest-triggerable
escapes in the field: CVE-2026-45782 (8.9) virtio-blk async-I/O UAF, *"a full guest-to-host (VM)
escape"*, **vulnerable in the default configuration**; and CVE-2026-27211 (9.1), where a guest
rewrites its own disk header and format auto-detection serves host files back.

**0.4 MinIO is not "AGPL-risky", it is dead.** `minio/minio` archived 2026-04-25; README reads
**"THIS REPOSITORY IS NO LONGER MAINTAINED"**. Last release was a CVE fix, 2025-10-15 — zero releases
in 2026. The community edition is source-only, no binaries; `mc`, the operator and KES are archived
and `console` was deleted. AIStor Free is **single-node only** with redistribution prohibited, so
multi-node erasure coding — the only configuration that self-heals — is now commercial. Adopting it
means owning every future CVE in the durability layer with no upstream.

**0.5 FoundationDB is the right database and cannot hold the blobs.** Values <= 100 KB, transactions
<= 10 MB of affected data, and *"FoundationDB currently does not support transactions running for
over five seconds"*. A 200 MB base layer is 2,000+ values and exceeds the transaction ceiling 20x.
Apple's own Record Layer answer is `SPLIT_RECORD_SIZE = 100_000` — split the value, not store it.
FDB is the **index**, never the warehouse.

**0.6 Guest-side hardening does not protect the host.** Lockdown, module signing, guest KASLR and
guest SELinux are scoped intra-guest by their own documentation; guest root drives the host's device
models, ioctls, MSRs and CPUID regardless. Omitting a guest virtio *driver* also achieves nothing —
the host device model stays reachable by hand-driving the queues. **The only way to shrink host
surface is to not configure the device.**

**0.7 Confidential computing is the inverse threat model and is net-negative here.** The upstream
threat model names the adversary as *"a potentially misbehaving host"* and the goal as preserving
*"the confidentiality and integrity of CoCo guest's private memory"* — i.e. SEV-SNP and TDX defend
the guest **from us**. Every known attack against them (Heckler, WeSee, CacheWarp, CipherLeaks,
TDXdown, BadRAM, Battering RAM, WireTap) is host-to-guest or physical, so irrelevant to us, while
both add host-side code to our surface. Firecracker has no support and no roadmap: PR #5625
explicitly disables `CONFIG_KVM_AMD_SEV`.

**0.8 Snapshotting and vhost-user are mutually exclusive in Firecracker** — and the resolution is
that we should not use vhost-user at all. See §3.3.

---

## 1. Shape of the system

One VM per user, persistent across sessions. The user gets an interactive shell and nothing else:
no guest IP, no host filesystem sharing, no serial console.

```
  user ──(auth, §6)──> control plane ──> host broker ──┐
                                                       │ AF_UNIX
                                            ┌──────────┴──────────┐
                                            │  Firecracker (MMIO) │  jailer: per-VM uid/gid,
                                            │  under jailer       │  netns, pidns, cgroup v2,
                                            └──┬────────┬─────┬───┘  seccomp allowlist
                                   virtio-blk  │        │     │ virtio-vsock (userspace)
                                   (ro base)   │        │     └──> in-guest agent -> shell
                                               │        │ virtio-blk (rw session)
                     ┌─────────────────────────┘        └────────────┐
                     │ dm-verity, host-supplied signed root hash     │ dm-thin / cow, 64 KiB
              ┌──────┴───────┐                                 ┌─────┴──────┐
              │ host FUSE    │  512 KiB chunks, by digest      │ per-user   │
              │ chunk daemon │ ──> 3-tier cache ──> blob store │ CoW volume │
              └──────────────┘                                 └────────────┘
                     │                                                 │
                     └──────────> FDB index (manifests, digests, ──────┘
                                  refcounts, GC, leases)
```

The single rule that the security analysis and the integrity analysis arrive at independently:
**the host answers by content digest, never by a guest-supplied name.** A digest is
self-authenticating; a name is not.

---

## 2. The VM

### 2.1 Firecracker, MMIO, under jailer

**The field, and why each alternative lost.**

| | Firecracker | Cloud Hypervisor | QEMU `microvm` | gVisor | Nitro |
|---|---|---|---|---|---|
| What it is | KVM VMM, Rust, ~50k LoC device model | KVM VMM, Rust, crosvm/Firecracker-derived | KVM VMM, C, >1.4M LoC, *"more than 40 emulated devices"* | **not a VMM** — userspace kernel intercepting syscalls | hardware; I/O terminated on separate silicon |
| Devices | 6 | many more: ACPI, RTC, virtio-fs, VFIO/vfio-user, hotplug, virtio-console/-pmem/-iommu/-mem, TPM | ISA + <= 8 virtio-mmio instantiated, but a default build **links all ~40** | n/a | n/a |
| Transport | virtio-MMIO; PCI opt-in | **virtio-PCI only** | MMIO | n/a | n/a |
| Self-confinement | **`jailer`** (chroot/pivot_root, cgroups, uid drop, netns/pidns, rlimits) + built-in per-thread **allowlist** seccomp with ioctl-argument filtering | per-thread allowlist seccomp + opt-in Landlock (filesystem-only); **no jailer equivalent** | `-sandbox` is a **denylist**; confinement outsourced to libvirt sVirt | own sandbox, with its own escape history | closed |
| Lifetime CVEs | 5 (1 guest-reachable escape-class, **PCI transport only**) | 3 — but **2 guest-triggerable escapes, both 2026** | **458** records 2010-2026, 61 "important" | CVE-2018-19333 (9.8), CVE-2018-16359, CVE-2023-7258, CVE-2025-2713 | n/a |
| Who runs it | AWS Lambda + Fargate; Vercel Sandbox | fly.io **GPU Machines only** (capability-driven, not security-driven) | general virtualisation | **Modal** | AWS |

**Cloud Hypervisor — rejected on its own words.** `docs/threat-model.md` contains two disqualifying
sentences: *"Cloud Hypervisor is not hardened against denial of service attacks from the guest
kernel"*, and *"Until support for blocking AF_UNIX sockets is implemented in Landlock and used by
Cloud Hypervisor, **sandbox escapes will not be considered security vulnerabilities**."* That second
one means an escape in our threat model would not even be triaged as a security bug. It also owns the
only two guest-triggerable escapes in the field this year: CVE-2026-45782 (8.9), a virtio-blk
async-I/O use-after-free giving *"a full guest-to-host (VM) escape"* and **vulnerable in the default
configuration**; and CVE-2026-27211 (9.1), where a guest rewrites its own disk header and QCOW2
format auto-detection serves host files back. It becomes defensible at >= v51.2 with
`backing_files=off` **if** you need VFIO for GPU passthrough — which is exactly why fly.io uses it
only for GPU Machines.

**QEMU `microvm` — right idea, two structural problems.** KVM + `microvm` *is* inside QEMU's
security-covered scope (TCG is not: *"Users with non-virtualization use cases must not rely on QEMU
to provide guest isolation"*). But (i) `microvm` reduces the devices *instantiated*, not the ones
*linked* — trimming the actual binary needs `--without-default-devices` plus Kconfig work; and (ii)
`-sandbox on` is a deny-list **by design**, because *"building a whitelist of syscalls used by QEMU
emulators is an intractable problem"*. So its confinement story is libvirt sVirt — real, with per-VM
MCS labels and AppArmor profiles, but a far larger moving-parts budget than `jailer`.

**gVisor — a different kind of thing, and it cannot sit under us.** It is a userspace kernel, not a
VMM, and *"[u]sage of KVM from within the sandbox is not supported"* — so it cannot host a microVM.
As a *replacement* boundary it is weaker for this threat model, and its own non-goals say so: no
protection against *"hardware side channels (e.g. Spectre, L1TF)"*, and *"a sandbox is not a
substitute for a secure architecture."* Modal runs it, which is a real datapoint — but Modal's
workload is short-lived code execution, not a persistent interactive root shell. Note also that
stacking it *around* the VMM adds no new kernel boundary: that is what Kata Containers is, and it
repackages the namespace/cgroup/MAC primitives `jailer` already applies. **Layers whose failure mode
is "host kernel LPE" do not multiply.**

**Nitro — the reference point we cannot buy.** *"By design the Nitro System has no operator access"*,
with I/O terminated on separate cards. The NCC Group report is a design review of the API security
claims, not a hypervisor pentest. The transferable lesson is architectural rather than a product:
**a device-emulation bug cannot be a host-kernel-adjacent bug if the device model is not software
running on the host CPU.** We cannot move I/O onto separate silicon, so the only lever we have is
shrinking the device set — which is what §2.2 does.

**Kata Containers** deliberately picks no default hypervisor, so it is a packaging choice rather than
an alternative to one.


Chosen because its published threat model is ours — *"all vCPU threads are considered to be running
malicious code as soon as they have been started"*, and its production doc assumes *"arbitrary code
execution in a multi-tenant context"*. It is also the only candidate that ships privilege-dropping
confinement (`jailer`) and an **allowlist** seccomp policy; QEMU's `-sandbox` is a denylist by
design, because *"building a whitelist of syscalls used by QEMU emulators is an intractable
problem"*.

Firecracker is honest about its limit, and we inherit it: *"Firecracker is not able to mitigate
host's hardware vulnerabilities."*

- Version >= 1.14.4 / 1.15.1 (CVE-2026-5747, 8.7, OOB write up to 524,284 bytes).
- **virtio-MMIO only — never `--enable-pci`.** That CVE exists solely in the opt-in virtio-PCI
  transport; MMIO is unaffected.
- Default built-in seccomp. No `--seccomp-filter`, no `--no-seccomp`. The vmm filter has **no
  `clone`, no `execve`, no `openat`**, `socket` restricted to AF_UNIX/SOCK_STREAM, and ioctl
  filtered on the request number.
- `jailer --uid/--gid` unique per microVM, `--cgroup-version 2` (**the jailer defaults to v1**),
  `--netns` per VM, `--new-pid-ns`, `--resource-limit`. The jailer *"treats all its inputs as
  trusted"* and CVE-2026-1386 was a symlink bug, so the chroot base must be on a dedicated
  filesystem, root-owned, writable by no unprivileged user. **That directory layout is in the TCB
  and needs a test, not a runbook.**

### 2.2 Device set

Escapes come from device emulation, and the numbers are not close. ViDeZZo (IEEE S&P'23) finds
**57.4% (252/439) of QEMU vulnerabilities in virtual devices and 41.5% (22/53) of published VM
escapes**; a Red Hat security-data count gives **212 CVEs in legacy emulated hardware against 54 in
virtio/vhost**. MORPHUZZ *"found new bugs in every block/network/USB controller it fuzzed"*. Every
successful Pwn2Own VM escape 2016-2025 was a device parser.

**Expose exactly:**

| Device | Why, and the constraint |
|---|---|
| virtio-blk, read-only base | `format=raw` **pinned explicitly, never auto-detected** — auto-detection is CVE-2026-27211. Read-only enforced by the VMM's `is_read_only`, not by guest `fstab`. |
| virtio-blk, session volume | Per-VM CoW. See §3. |
| virtio-vsock | One port, the shell agent. Firecracker implements this **in VMM userspace**, *"bypassing vhost kernel code on the host"*. |
| virtio-rng | Smallest surface of any virtio device; rate-limited. |
| i8042 | Reboot only. |

**Refuse, with the reason:**

- **virtio-fs / 9p — categorically.** The escapes are *semantic*, so memory safety buys nothing:
  CVE-2020-35517 (8.2) *"a privileged guest user is able to create a device special file in the
  shared directory and use it to r/w access host devices"*; CVE-2022-0358 SGID-to-host LPE;
  CVE-2026-93834, whose vendor headline reads *"allows VM guest escape"*. 9p is also the heap-shaping
  half of the only recent *demonstrated* full QEMU escape (virtio-snd CVE-2024-7730 chained with a 9p
  xattr spray). NSDI'20 reached the same conclusion: *"we chose to support block devices for storage,
  rather than filesystem passthrough, as a security consideration."*
- **virtio-net.** Not needed — the shell runs over vsock. Drops CVE-2021-3748, CVE-2023-6693,
  CVE-2024-6505, and on the host side CVE-2019-14835 (vhost buffer overflow to host privilege
  escalation).
- **virtio-balloon.** Firecracker's own doc: *"Firecracker does not and cannot introspect into the
  guest to check the integrity of the balloon driver"*; stats are *"an indication rather than a
  guarantee"*; free-page hinting has a memory-corruption race.
- **Serial console.** `8250.nr_uarts=0`. CVE-2020-27174 was unbounded buffering of guest output
  growing host memory, and the vendor says *"We do not recommend that users enable the serial device
  in production"*. Note it *"can be reactivated from within the guest even if it was disabled at
  boot"* — so also bound whatever the VMM writes.
- **vhost-user anything** (§3.3), VFIO/passthrough, virtio-gpu/VGA/virgl, USB, audio, all legacy NIC
  and storage models, slirp, virtio-mem/-pmem, MMDS, **nested virt** (CVE-2021-3653/3656, 8.8 each,
  let L2 *"read/write physical pages of the host"*; the named mitigation is literally `nested=0`).

Both 2026 Rust-VMM escape CVEs were in features that had just been **added back** (virtio-PCI
transport; async block I/O). **Surface tracks features, not language** — treat "we enabled a new
device" as a security change.

### 2.3 CPU and memory posture

Use the kernel's own `attack_vector_controls` mapping rather than folklore. Two corrections to
widely repeated claims: **Meltdown is not guest-to-host** (user-to-kernel only; L1TF is the VM
analogue), and **Spectre-BHB/BHI is**.

- `mitigations=auto,nosmt` + `nosmt=force`. `mitigations=off` is disqualifying. Plain `auto`
  *"leave[s] SMT enabled, even if it's vulnerable"*.
- **SMT off is non-negotiable.** MDS doc: *"If the MDS mitigation is enabled and SMT is disabled,
  guest to host and guest to guest attacks are prevented."* L1TF doc: *"The kernel does not by
  default enforce the disabling of SMT, which leaves SMT systems vulnerable when running untrusted
  guests with EPT enabled."* AWS disables SMT fleet-wide for this reason [paper, NSDI'20].
- **Core scheduling is not a substitute.** Its own doc: *"Core scheduling cannot protect against MDS
  attacks between the siblings ... for any combination of sibling CPU modes (host or guest mode)"*,
  and for L1TF *"The only solution is to disable EPT."*
- Also: `tsx=off`, `spectre_bhi=on`, `vmscape=ibpb` (CVE-2025-40300 reaches hypervisor *userspace* —
  i.e. the VMM process), `spec_rstack_overflow=ibpb-vmexit` on affected AMD,
  `kvm.nx_huge_pages=force`, `kvm-intel.vmentry_l1d_flush=cond`, and **no**
  `KVM_CAP_X86_DISABLE_EXITS` bits (MWAIT passthrough reopens Cross-Thread RSB).
- Host-side KVM policy: `KVM_X86_SET_MSR_FILTER` default-deny;
  `KVM_CAP_ENFORCE_PV_FEATURE_CPUID` (*"Otherwise, a guest may use the paravirtual features
  regardless of what has actually been exposed through the CPUID leaf"*);
  `KVM_CAP_X86_BUS_LOCK_EXIT`; `KVM_CAP_X86_NOTIFY_VMEXIT`.
- Verify `/sys/devices/system/cpu/vulnerabilities/*` and `/sys/devices/system/cpu/smt/control` on
  every boot **as a gate**, not a spot check.

**KSM off** — but correct the usual framing: the kernel KSM doc contains **no** security warning.
The citable operator statement is Firecracker's: *"Users should disable Kernel Samepage Merging to
mitigate side channel issues that rely on page deduplication."* Research backing: Flip Feng Shui
(USENIX Sec'16), CAIN, Dedup Est Machina. CVE-2015-2877 is **DISPUTED**, with NVD's own note
*"Basically if you care about this attack vector, disable deduplication"*. Verify
`/sys/kernel/mm/ksm/run == 0` **and** `pages_sharing == 0` (`echo 2` unmerges stale pages); best is
`CONFIG_KSM` absent. Check the VMM too: QEMU's `mem-merge` is **on by default**; Firecracker never
calls `MADV_MERGEABLE`.

**Memory:** swap off (*"mitigates data remanence issues"*). Boot-preallocated hugetlbfs — hugetlb
pages *"cannot be swapped out under memory pressure"*, which structurally removes host swap of guest
memory, and hugetlb VMAs are KSM-excluded via `ksm_compatible()`. Caveat: Firecracker maps guest
memory `MAP_NORESERVE`, so pool exhaustion is SIGBUS — size with margin. `init_on_free=1`.

### 2.4 Around the VMM

Firecracker's seccomp makes post-escape pivoting genuinely hard, with two limits worth stating:
seccomp **cannot follow pointers**, so `KVM_SET_USER_MEMORY_REGION`'s struct is unchecked; and it
gates *new* syscalls, not the fds the VMM already holds (`/dev/kvm`, the disk, the API socket).
Those fds are the real residual surface.

- **Per-VM uid/gid**, plus `kernel.yama.ptrace_scope >= 1` — at 0, *"a process can `PTRACE_ATTACH`
  to any other process running under the same uid"* — and `/proc` with `hidepid=2`.
- **Per-VM netns.** This is the only thing that closes abstract unix sockets: *"socket permissions
  have no meaning for abstract sockets"*, so uid separation does not contain them. (Landlock ABI v6
  adds `SCOPE_ABSTRACT_UNIX_SOCKET`, but Firecracker has no Landlock — netns is the substitute.)
- **cgroup v2:** `memory.high` *below* `memory.max` (high *"never invokes the OOM killer"*),
  `memory.oom.group=1` so a killed vCPU thread does not wedge the VMM, `pids.max`, `cpu.max` (not
  `cpu.weight`, which is proportional only). Known gap: `io.max` allows *"temporary bursts"* and
  attributes writeback to root on filesystems without cgroup-writeback support.
- `user.max_user_namespaces=0` — neither VMM needs userns, and it is a documented escalation
  multiplier (CVE-2022-0185, CVE-2024-1086, where that sysctl *is* the vendor mitigation).
- Host sysctls: `unprivileged_bpf_disabled=1`, `bpf_jit_harden=2`, `dmesg_restrict=1`,
  `kptr_restrict=2`, `perf_event_paranoid=3`, `vm.unprivileged_userfaultfd=0` (removes the
  stall-a-kernel-copy primitive), `kexec_load_disabled=1`, `sysrq=0`.
- Block modules with `install <mod> /bin/false`, **not `blacklist`** — blacklist only ignores
  aliases, and the module still loads by name. Block the whole `vhost_*` set: a Firecracker-only
  host never issues a vhost ioctl, so it is pure surface.
- **No second software layer.** gVisor cannot host us (*"Usage of KVM from within the sandbox is not
  supported"*), has its own escape record, and names our residual risks as its own non-goals. A
  container around the VMM is a repackaging of the primitives the jailer already applies — that is
  precisely what Kata is. Layers whose failure mode is "host kernel LPE" do not multiply.

### 2.5 Shell transport

**vsock + a minimal in-guest agent, with zero guest networking.** This is the single most valuable
device-level fact in the whole design: with `vhost_vsock` loaded, guest virtqueue bytes reach
`virtio_transport_recv_pkt()` **inside the host kernel**, and
`net/vmw_vsock/virtio_transport_common.c` alone carries ~17 CVEs (CVE-2024-50264 UAF,
CVE-2023-52842 uninit-value directly in the receive path, CVE-2026-23069, CVE-2026-53132), with 3-4
more in `drivers/vhost/vsock.c`. Firecracker deletes that entire parser from the path by
implementing virtio-vsock in VMM userspace, mediating AF_UNIX to AF_VSOCK. The host-initiated
handshake is auditable in one line: `CONNECT <port>\n` -> `OK <port>\n`.

This is also the converged industry choice, not a local invention: Kata's Hybrid VSOCK, where *"the
host side of the VSOCK is a Unix socket, and the host kernel does not need VSOCK support"*; E2B's
`envd`; and Nitro Enclaves as the reference extreme — *"no external network connectivity, no
persistent storage, and no interactive access"*, with vsock *"the only channel of communication"*
[vendor].

Rejected: **sshd in the guest**, which forces virtio-net onto every VM purely to carry a terminal
(fly.io does this coherently, because their product *is* network-attached VMs; ours is not — a shell
does not need the guest to have an IP). **Serial**, per §2.2.

**Terminal escapes are a transport-independent hazard.** Guest output is attacker-controlled and an
operator's terminal is an interpreter: OSC 52 writes the clipboard, so an attacker-chosen command
runs on the operator's next paste (CVE-2026-48725 in Warp; GHSA-fwjx-9p69-h25h). Sanitize or
allow-list escape sequences at the host broker; render in a browser xterm.js with clipboard and
report sequences disabled; **never `cat` guest output into a staff tmux.**

---

## 3. The filesystem

### 3.1 Base layer

Content-addressed chunks in the blob store, per-chunk digests rooted in **one signed manifest
digest**. Served to the guest as a read-only virtio-blk device under **dm-verity** with a
host-supplied, signed root hash (`root_hash_sig_key_desc` validates a PKCS#7 signature at device
creation).

dm-verity is the reason the base goes behind a *block* device rather than a file protocol: it
verifies *"the integrity of the device on a **per-block** basis"*, *"on-demand during disk access"*,
and it is **indifferent to where the bytes came from**. A device backed by a daemon pulling chunks
from remote storage is verified exactly as local NVMe is. A corrupt, stale, substituted or
attacker-chosen chunk produces EIO or a panic per the configured mode — **not a compromise**.
Integrity and lazy fetch compose with zero interaction.

Do **not** use `check_at_most_once`: it caches a verification verdict, which is exactly wrong
multi-tenant.

### 3.2 Why not file-level verification alone

fs-verity is narrower than people assume. Its own docs: *"Changes to metadata such as owner, mode,
timestamps, and xattrs are still allowed, since these are not measured by fs-verity"*, and verity
files *"can also still be renamed, deleted, and linked to."* So over a content store it protects
**the bytes of each object** but not **which object a name resolves to** — an attacker who can
rename objects can serve a validly-protected *wrong file*.

composefs exists to close exactly that gap, by chaining two levels: per-file digests in
`trusted.overlay.metacopy` with `verity=require`, under a whole-image fs-verity digest passed as a
mount option. One host-supplied root digest then transitively covers the namespace *and* every
file's contents. Two details worth keeping even though we use the block path:

- composefs avoids `metacopy=on` entirely by using overlayfs **data-only lower layers** —
  *"Instead of explicitly enabling metacopy=on it is sufficient to specify at least one data-only
  layer to enable redirection"* — so the "do not use metacopy with untrusted layers" warning does
  not bite a host-constructed mount.
- **Never `userxattr`.** It moves overlayfs to the `user.overlay.*` namespace, and `user.*` xattrs
  are owner-writable — a guest that can write any part of the tree could forge redirect and digest
  xattrs. The integrity properties depend on `trusted.*`, i.e. on the mount being set up by
  something the guest is not.

If we ever expose the base at file granularity, the lazy materialiser must order its work
**write-to-temp -> enable fs-verity -> compare digest -> atomic rename into the CAS**. Making an
object visible before verity is enabled leaves a window where a `verity=require` check passes
against a file nobody verified.

### 3.3 Lazy fetch: file-backed virtio-blk over a host daemon, NOT vhost-user

This resolves a real conflict between two streams. The filesystem research proposed
**vhost-user-blk**, on the strength of Firecracker's docs blessing backends that implement
*"intelligent readahead or network-based data fetching"*. The hardening research refuses vhost-user,
citing QEMU: *"There is not considered to be security boundary between QEMU and the vhost-user &
vfio-user backends"*. And independently, **Firecracker does not support snapshotting for microVMs
with vhost-user devices.**

**Resolution: Lambda does not use vhost-user either.** Its shape is a host-side FUSE agent behind
plain **file-backed virtio-blk** — the daemon materialises 512 KiB chunks into a file the VMM reads
normally. That settles all three objections at once:

- The backend is first-party and jailed, so it is *inside* the TCB; the QEMU warning is about a VMM
  trusting a foreign backend, which is not our situation. The boundary that matters is
  guest <-> (VMM + backend).
- **Snapshot support is preserved.**
- The host page cache still works. vhost-user explicitly forfeits it, and its docs warn *"Page
  faults to a shared memory mapping take significantly longer (up to 24% in our testing)"* [vendor].
- A **block** protocol hands the guest no names at all — categorically unlike virtio-fs, whose
  escapes are semantic (§2.2).

**What is verified and what is not.** The vhost-user/snapshot exclusion is confirmed verbatim
(§7.1.1). What is **not** verified from a primary Firecracker doc is that a *block-device node* is
accepted as `path_on_host`, nor how a network-backed drive behaves across snapshot save/restore;
`versioning.md` says only that on restore block devices *"must be available, their names match their
original names ... and they are accessible to the Firecracker process"*. A file on a host FUSE mount
is an ordinary path and should satisfy `path_on_host`, but **the snapshot interaction is untested.**
This is the highest-value spike in the design — the only route to snapshots that does not abandon
network-fetched base layers. Note that §7.2 concludes we should not want snapshots in v1 anyway, so
the spike is not on the critical path.

Revisit vhost-user only if measured throughput is inadequate, and then knowingly trade away
snapshots, the backend-side read-only flag, and the rate limiter (§6.4).

Firecracker's `io_engine` should be `Async` (io_uring) where the host kernel allows it — [vendor]
1.5-3x read efficiency, up to 30x IOPS on NVMe, at ~110 ms added device-creation latency. Note
`Async` is a developer preview and returns HTTP 400 on hosts below 5.10.51.

### 3.4 Write path: split by size, declared not discovered

**overlayfs `copy_up` is whole-file**, and that is pathological here: a 1-byte write to a 5 GB lazy
file copies 5 GB *and* forces a full materialisation of a file the guest barely touched. Two costs,
one syscall. `metacopy=on` only defers *metadata* operations — the data copy-up still happens on the
first write open — so it is not the mitigation.

Therefore:

| Class | Placement | Cost of a 1-byte write |
|---|---|---|
| Eager, small (`/bin`, `/usr/lib`, config, project tree) | overlayfs upper on the per-session device | whole file, but the file is small and already local |
| Lazy, large (model weights, datasets, archives) | **never** an overlayfs lower; block CoW at 64 KiB (`dm-thin` min, `nbdkit-cow-filter` default) | one 64 KiB chunk, and only that chunk is materialised |
| Base with no legitimate writer (`/usr/lib`, `/bin`) | `write: deny` | EROFS |

`nbdkit-cow-filter` already implements per-session overlay semantics off the shelf — 64 KiB blocks,
`cow-on-read` to populate, and *"anything written is thrown away as soon as nbdkit exits"*.

Session commit walks the dirty chunks into a compacted OCI layer. nanobox already has that
algorithm: `web/native/installer.js:510` maps one change event to tar entries,
`installer.js:523 journalCompact` keeps one record per touched path, and the load-bearing property
is recorded at `installer.js:522` — *"journals concatenated in order ARE a valid combined layer
(later records win)"*. This is strictly better than snapshotting a block device when the result
should be shareable and diffable.

### 3.5 Per-path policy

A **generated per-VM JSON artifact**, in the shape nanobox already generates: `tools/genspec-vm.mjs`
lines 31-34 turn a persist/state list into OCI bind mounts, emitting `config-vm.json` and
`config-persist.json` — two variants that differ only in process environment, which already proves
the shape works. Extend each entry to:

```json
{"path": "usr/lib", "materialise": "eager", "write": "deny"}
```

Generated, never hand-edited, **never guest-readable**.

Write admission is enforced host-side as an injected predicate returning EROFS, which nanobox also
already does: `web/sandbox-worker.js:99` supplies `writable(path)`, `web/wasifs.js:114` derives it
over the **canonical** path from the tree root, and ~14 WASI mutators check it
(`wasifs.js:223,227,255,262,324,332,340,348,358,368,383,388`). The guest holds no capability to
widen it. Note that checking the *canonical* path is the same rule the integrity analysis reaches
from the other direction in §1.

### 3.6 The eager set: record it, never hand-maintain it

Three systems built independently — eStargz, Nydus-with-NRI-optimizer, DADI/overlaybd — converged on
the same answer: **run the image once under instrumentation and record the access set, then ship the
recording as part of the image artifact.** eStargz profiles *"all file accesses during the
execution"*; Nydus's optimizer *"joins container mount namespace and starts fanotify server"* and
emits a CSV fed back via `--prefetch-patterns`; DADI records a block-level trace with
`ctr record-trace`. The one hand-maintained design in the survey, SOCI's `--prefetch-file`, is still
marked experimental, and its README concedes *"load order based on your specific workload"* is
unimplemented.

**Prefer the DADI/Nydus encoding (a separate artifact or top layer) over the eStargz encoding (byte
ordering)**, because re-recording then does not require rewriting base layers — which matters a lot
when the base is content-addressed and shared across every tenant.

And record **only the eager/lazy boundary**, not a per-file priority order. Lambda credits its
prefetch effect to **the guest kernel's own read-ahead**, not a designed eager list, and that
generalises under exactly two conditions, both of which we control:

1. **The layout must be access-order coherent.** Readahead is a prediction that the next-needed byte
   is the next byte; it pays only when the layout already encodes the access order. Lambda gets this
   by flattening the image to a single ext4 at create time by *"a deterministic flattening process
   which applies each tarball in order"*.
2. **The fetch unit must be large relative to the read unit.** At 512 KiB a chunk already *is*
   several readaheads of lookahead.

Where it fails is a working set scattered thinly across a large image — there readahead is read
*amplification*, fetching 512 KiB to serve 4 KiB at remote latency. That is the case eStargz
addresses, and it addresses it by changing the layout.

So the rule, rather than a list: **lay the eager set out contiguously and let readahead fetch it;
give each lazy large file its own contiguous extent range and let readahead stream it; never try to
predict *which* lazy file.** The only thing that must be recorded is the boundary — a far smaller
and more stable artifact than a priority list, and exactly what an eStargz landmark is.

---

## 4. Blob storage and index

### 4.1 Split metadata from content

This is the dominant design for this problem shape, and the named production users are not marginal:
Apple CloudKit on the FDB Record Layer (*"billions of independent databases"*, [vendor]); Snowflake,
FDB since 2014 for catalog, sessions, ACLs, transaction state, lock queues and micro-partition
mapping, with data in object storage; Tigris, an S3-compatible store where *"data blocks are written
to block storage separately before metadata transactions commit"*; DeepSeek 3FS, *"stateless
metadata services backed by a transactional key-value store (e.g., FoundationDB)"*; Google Colossus,
*"Curators store file system metadata in ... BigTable"*, which *"allowed Colossus to scale up by
over 100x over the largest GFS clusters"*.

**Index (FoundationDB):** which digests compose which user's filesystem, per-session delta pointers,
chunk-to-blob maps, refcounts, GC state, leases, per-account quotas. Small, hot, read-heavy, and it
genuinely needs multi-key strict serializability so a session's view of its layers can never be half
updated. FDB gives *"global, ACID transactions with strict serializability"* and heals itself —
*"If a server containing one of the copies is lost, FoundationDB will automatically heal, finding a
new location for the lost copy"* — with the Data Distributor reassigning ranges on storage-server
failure. Deployment: `triple` wants 5+ machines (`double` works on 3-4). At our index size, Postgres
is an honest alternative; the reason to pick FDB is the strict-serializability guarantee and the
deterministic-simulation test record (*"roughly one trillion CPU-hours of simulation"*, [vendor]).

### 4.2 Content: Garage, or Ceph at 4+ hosts

**Garage** (3 nodes, 3 zones, RF=3) is the only free self-hostable store whose documentation promises
healing with **no operator in the loop**: *"Scrubs are automatically scheduled by Garage to run every
25-35 days"*, verifying every block's hash, and *"a corrupt block will be restored from another node
that holds a valid copy"*; metadata anti-entropy runs hourly over Merkle trees; node removal
rebalances automatically. One Rust binary, one TOML. Objects under `INLINE_THRESHOLD = 3072` bytes
live in the metadata table.

Costs, stated plainly: AGPL-3.0; **no erasure coding, ever** (*"we limit ourselves to duplication"*
is a declared non-goal), so RF=3 means 3x raw; performance is also a declared non-goal; the default
LMDB backend is *"prone to database corruption after an unclean shutdown"* and **both
`metadata_fsync` and `data_fsync` default to false** — change them; no TLS without a proxy; ~1-3 FTE
upstream and the only documented production deployment is the authors' own at ~500 GB [vendor]. Put
real backups behind it.

**Ceph RGW** is the better choice at 4+ hosts, and has the most rigorous healing engineering in the
field: BlueStore *"checksums all metadata and all data written to disk"* and verifies on read, light
scrub daily and deep scrub weekly, and an OSD is marked `out` after `mon_osd_down_out_interval` 600 s
which re-weights CRUSH and backfills. Turn on `osd_scrub_auto_repair` (off by default).

Two traps worth internalising:

- **Three hosts is not a self-healing Ceph cluster.** With `failure-domain=host`, 3 hosts at
  `size=3` tolerates a failure but after a permanent host loss CRUSH has only two legal hosts; PGs
  sit `active+undersized+degraded` **indefinitely** and never backfill. Four hosts buys the *right to
  heal*, not capacity. A Ceph docs maintainer states it directly: *"When using 3x replication it is
  thus advantageous to have at least 4 hosts."*
- **`mon_osd_backfillfull_ratio = 0.90` stops the healing you deployed Ceph for**, and
  `full_ratio = 0.95` stops writes cluster-wide. Keep fill <= 70%.

Also rejected: Swift (*"the replicator doesn't maintain desired levels of replication when other
failures, such as entire node failures, occur"*; rings are rebuilt **manually**; 5-zone floor);
SeaweedFS (best small-file engine in the field, but its own wiki says *"If any replica is missing,
there is no automatic repair"* and the background scrubber is an Enterprise feature, against a 2026
record of vacuum/EC data-loss issues and no CI suite); RustFS (right licence, wrong maturity — most
open issues are in the heal/scanner path, including an open acknowledged-version data-loss report);
Riak CS (archived 2026-08-13); GlusterFS (dormant; commercial EOL 2024-12-31); gateways (Zenko,
versitygw — *"completely stateless"*, so they heal nothing).

### 4.3 Small files are not our problem, because layers are the unit

Every small-object pathology in the survey — Ceph's 4 KiB allocation floor baked per-OSD at creation,
RGW needing 4% of the fast device for RocksDB, MinIO's 1.6 billion inodes for 6.8M objects — applies
to one-object-per-file. **Store one blob per layer.** An OCI layer is already a packed, compressed,
content-addressed tar, so object count drops by orders of magnitude and the store only ever sees
multi-MB immutable writes. Random *file* reads come back via the seekable index (§3.6), kept in FDB.
The prize is Harter et al., FAST '16: image download is **76% of container startup time but only
6.4% of the fetched data is actually needed** [paper].

### 4.4 Cross-tenant blast radius

The failure mode to design against is the **combination of a writable shared cache and name-based
lookup**. Any path where a guest-influenced *string* selects an entry in shared mutable storage is
where cross-tenant corruption lives.

Keep the cache **content-hash-keyed, host-owned, immutable-once-written**. A guest can then at worst
*request* an object; storing a wrong object under a right key requires finding a collision, not
winning a race. Lambda goes further and is worth copying: SHA256 of each chunk deterministically
derives an AES-CTR key (convergent encryption, so identical chunks dedup), with **a varying salt** to
deliberately prevent dedup across salt domains and cap the blast radius of a corrupted chunk; and the
per-function manifest is encrypted under a per-customer KMS key released *"only ... to the workers
that that particular customer's functions are placed on."*

**The confused-deputy trap, which content addressing alone does NOT close.** "Answer by digest,
never by name" defeats path traversal, but a digest is still guest-supplied *data*, and digests are
**global across tenants** in a content-addressed store. A guest that learns any digest — from a
public image, a prior job, a side channel — can ask for another tenant's chunk out of the shared
cache. So the host must enforce `digest IN manifest(vm_id)` on **every** chunk request.

Better: make that check redundant. Lambda derives each chunk's key *from the manifest*, so an
unauthorized digest is **useless** even if the membership check is buggy — a worker cannot name a
chunk it has no manifest for, because the chunk key lives in the manifest. **Copy the structure, not
just the check.** A related constraint from the same design: do **not** compress before encrypting,
or you create a compression side channel; only all-zero chunks may be elided. That is easy to violate
later while "optimising".

With that, the remaining question is authorization ("can a tenant make the host fetch an object it
shouldn't"), not integrity — which is §6's problem, not this layer's.

---

## 5. What transfers from nanobox, and what does not

| Transfers | Where | Note |
|---|---|---|
| Per-VM policy as a generated config | `tools/genspec-vm.mjs:31-34` -> `config-vm.json` / `config-persist.json` | Two variants already prove the shape |
| Write admission as a host-side predicate returning EROFS | `web/sandbox-worker.js:99` + ~14 points in `web/wasifs.js` | Checked on the **canonical** path, `wasifs.js:114` |
| Session writes as a compactable OCI layer with whiteouts | `installer.js:510`, `:523` | The right durable representation of a session |
| The lazy materialisation seam | `web/wasifs.js:69-71` `fileData()` thunk | Per-inode, already load-bearing |
| Digest-keyed cache, parallel fetch, ordered apply | `web/oci.js:96-122` | The right fetch discipline for the host chunk cache |

Does **not** transfer: the 9p transport (Firecracker has none, and `cache=loose` is what forced the
quiet-period write detection at `wasifs.js:90-99` plus the qid/inode fix); whole-file copy-up
(`wasifs.js:116 ensureCap`) which must become chunked; **trusting the guest's write-back timing**
(`docs/sandbox.md` records that closing the tab right after a write can lose it — a hostile guest
will *exploit* a lossy write path, not merely suffer it); and **range-fetch-without-verification**
(`installer.js:206-239` records `fileSha256Verified: false` because a slice cannot be hashed against
a whole-file checksum — exactly the gap a per-chunk Merkle scheme closes).

Correction to a premise worth recording: **nanobox has no overlayfs and no guest-side overlay at
all.** `/run/rootfs` is a plain bind mount of the 9p-served bundle
(`work/c2w-src/cmd/init/main.go:262`, with the TODO still at `:255`). All layering happens above the
guest, in JavaScript, before boot — which is a *better* starting point for this design than an
overlay would have been, because the layer model, write policy and integrity checks are already
host-side artifacts rather than guest-visible kernel features.

---

## 6. Identity and authorization

### 6.1 Email can never be the identity key

This is normative, not advice. OIDC Core §5.7: *"an Issuer MAY re-use an `email` Claim Value across
different End-Users at different points in time ... Therefore, other Claims such as `email`,
`phone_number`, `preferred_username`, and `name` **MUST NOT** be used as unique identifiers for the
End-User."*

**The stable key is the pair `(iss, sub)`.** Same section: *"The `sub` (subject) and `iss` (issuer)
Claims from the ID Token, used together, are the only Claims that an RP can rely upon as a stable
identifier for the End-User ... the only guaranteed unique identifier for a given End-User is the
combination of the `iss` Claim and the `sub` Claim."* `sub` is case-sensitive and at most 255 ASCII
characters, so store it as a case-sensitive `VARCHAR(255)`.

Mint our **own** opaque internal subject (ULID/UUIDv7), never derived from any IdP value, with an
`identity_link` table carrying a UNIQUE constraint on `(iss, sub)`.

| IdP | The stable key |
|---|---|
| Google | `(iss, sub)`. Google's own docs: *"you shouldn't use the email field in the ID token as a unique identifier for a user. Always use the `sub` field."* |
| Microsoft Entra | `(tid, oid)`, or `sub` alone (Entra `sub` is pairwise per app) |
| GitHub (OAuth, **not** OIDC) | the numeric user `id` — *"takes their durable user ID instead of their login, which can change over time"*. We invent an `iss` convention. |
| SAML enterprise | `(IdP EntityID, NameID Format=persistent)` — **unconfirmed**, see Unconfirmed |
| Passkey / WebAuthn | the credential ID, attached to an **already-existing** internal subject |
| Email magic link | another IdP with weak assurance; proves mailbox control *at that moment only* |

**Why this matters more here than in a typical app:** in our product, an account-linking bug hands
the attacker a root shell with their own keys already in it.

Four hazards, each sourced:

1. **`email_verified` is past tense.** OIDC Core §5.1: the OP took steps to ensure control *"at the
   time the verification was performed"*. It says nothing about now, and `true` from IdP A does not
   mean what `true` from IdP B means.
2. **Address reuse by a different human is a supported admin operation.** Google Workspace: *"Twenty
   days after a user's account is deleted, their email address is removed ... However, you can
   reassign the address to another managed user before that 20-day period ends."* The `sub` does not
   follow the address. Microsoft states the same hazard: *"an employee is given an email address that
   matches that of a previous, no longer present employee. Your application mustn't use
   human-readable data to identify a user."*
3. **Attacker-controlled email (the nOAuth class).** Microsoft on `email`: *"This value isn't
   guaranteed to be correct and is mutable over time. **Never use it for authorization**"*; and
   *"These claims aren't unique and can be controllable by tenant administrators or sometimes
   users."* The mitigating claim `xms_edov` is only meaningful for tenant-verified domains, and
   *"Facebook and SAML/WS-Fed accounts **do not** have verified domains."*
4. **Pre-emptive account takeover.** Attacker registers `victim@corp.com` by magic link before the
   victim arrives; the victim later signs in via Google; naive email matching links them into the
   attacker's pre-seeded account.

**The rule, from OWASP:** *"Identify the federated identity using the combination of `iss` (issuer)
and `sub` (subject), not `sub` alone"*, and *"Do not automatically link accounts solely because their
`email`, `preferred_username`, or other profile attributes match."* Linking requires an authenticated
session on the target account **plus re-authentication**.

Two further structural items: register a **`sector_identifier_uri`** on day one, because without it a
pairwise `sub`'s sector is the host of our `redirect_uri` (OIDC Core §8.1) and changing hostname
silently re-keys every user; and implement the **RFC 9207 `iss` response parameter with
stored-issuer comparison** (RFC 9700 §4.4.2.1) from the first day there are two IdPs — mix-up is the
bug that lets IdP A's code be redeemed at IdP B.

### 6.2 The v1 auth stack

| RFC | What it buys *this* system |
|---|---|
| **7636** PKCE, `S256` | Browser terminal and the CLI's loopback redirect both safe against code interception. RFC 9700 §2.1.1: *"Public clients MUST use PKCE"*, and servers *"MUST support PKCE"*. Never `plain`. |
| **8628** Device Authorization Grant | The only sane CLI login on a box with no browser — the common case for a *shell* product. |
| **9068** JWT access tokens (`at+jwt`) | Offline validation at the gateway, so attach needs no round trip to the AS. |
| **7662** Introspection | Revocation that lands at the moment that matters (session open), which a self-contained JWT cannot give. |

Build: the browser terminal on Authorization Code + PKCE S256; the CLI on the device grant; 5-15
minute access tokens with `aud` = the shell gateway only; introspection **at session-open**, not per
keystroke; ID token validation per OIDC Core §3.1.3.7 (exact `iss`, `aud` contains our `client_id`,
signature, `exp`, nonce).

**Two things that are easy to get wrong and are security-critical:**

- **Reject any token whose `typ` is not `at+jwt`.** RFC 9068 §5 is explicit that resource servers
  *"have no way of knowing what key should be used to validate JWT access tokens in particular, they
  have to accept signatures performed with any of the keys published in AS metadata ... consequently,
  an attacker just needs to compromise any key among the ones published."* Accepting an ID token as
  an access token is the classic route by which a "sign in with Google" ID token becomes a shell
  session. All seven of `iss, exp, aud, sub, client_id, iat, jti` are REQUIRED (§2.2).
- **The device flow needs rate limiting designed in.** RFC 8628 §5.1's worked example is ~34.5 bits
  of user-code entropy with only **5 attempts allowed**; §3.5 requires that on `slow_down` *"the
  interval MUST be increased by 5 seconds"*; and §5.4 covers remote phishing and recommends telling
  the user they are authorizing a device and having them confirm they possess it.

Also: RFC 9700 puts two grants out of bounds — the resource owner password credentials grant *"MUST
NOT be used"* (§2.4), and clients *"SHOULD NOT use the implicit grant"* (§2.1.2).

**Add later, in order:** passkeys as a second factor then a primary browser credential; DPoP once a
token can reach more than one audience; SAML; SSH-via-gateway.

### 6.3 Why not sender-constrained tokens, and why not SSH, in v1

**Sender-constraining (DPoP / mTLS) for end users: defer.** RFC 9700 §2.2.1 is a SHOULD, and the
threat — *"unanticipated token leakage"* — is already narrow with 5-15 minute single-audience tokens
introspected at attach. Decisively, RFC 9449 §11.4 states DPoP does **not** help against malicious
code *in* the client, and a browser terminal is a DOM full of attacker-influenced bytes, so XSS there
defeats it. It also needs a `jti` replay store (§11.1) and server-issued nonces (§11.2). mTLS instead
costs a client-certificate lifecycle and leaves the proxy-to-app metadata handoff out of scope
(§8705 §6.5). **Do** use mTLS for service-to-service in v1 — machine clients have a cert lifecycle
anyway and we control both ends.

**Passkeys are a browser-session primitive, not the auth system.** A WebAuthn assertion is a
signature over a server challenge, scoped to one RP ID, with a key *"expected to never be exposed to
any other party"* — so there is **nothing transferable** to a CLI, an SSH client or a service hop.
It must be exchanged for an OAuth token at the gateway. What it does buy is phishing resistance by
construction (the credential cannot be exercised against the wrong origin), no shared secret in our
database, cloned-authenticator detection via the signature counter, the UV/UP distinction (require
user *verification* for destructive control-plane calls), and BE/BS flags to detect synced vs
device-bound credentials. What it does **not** buy is any account recovery: the spec stops at
server-side decommissioning. A synced passkey's real assurance ceiling is the sync vendor's recovery
flow — for a product handing out root shells, require >= 2 credentials, or a passkey plus one
recovery IdP link. Cite **WebAuthn Level 3**, a W3C Recommendation dated 2026-08-25, not Level 2.

**SSH: not in v1, and `sshd`-in-guest never.** The decisive argument is one row of the table:

| | sshd in guest | sshd host-side proxy | websocket + vsock agent |
|---|---|---|---|
| Where authn happens | **inside the hostile guest** | on host, then re-proxy | on host, in the control plane |
| Reuses the OAuth token | no — needs a cert exchange | no | **yes, directly** |
| Revocation granularity | cert TTL | cert TTL | per-request introspection |
| Session audit | tunnelled, opaque | partial | full, in one place |
| Inbound ports per host | 22 open | 22 open | 443 to the gateway only |
| Renewal of a long session | **unsupported** | unsupported | token refresh, no reconnect |

`sshd` in the guest makes the guest's own process the arbiter of who gets in — the exact inversion of
this design. A host-side SSH proxy fixes that but is then *a websocket gateway with an extra
protocol, an extra CA to protect, and a worse audit log*. Three supporting facts: Smallstep documents
SSH **user certificate renewal as unsupported for every provisioner**, so a long interactive session
forces either long-lived certs or a reconnect; its OIDC provisioner puts `email` in the certificate,
the exact claim §6.1 forbids for authorization; and AWS SSM — the best-documented websocket
equivalent, giving *"secure node management without the need to open inbound ports, maintain bastion
hosts, or manage SSH keys"* — documents that session logging does **not** cover port-forwarding or
SSH sessions because they are tunnelled encrypted. **Adding SSH costs us our audit log.**

So: the PTY lives behind the in-guest agent over vsock; the gateway holds TLS, validates the token,
resolves identity to `vm_id`, and only then opens the vsock. **The in-guest agent is a data mover,
never an authorization point.** Offer gateway-proxied SSH later for `scp` and port-forwarding, with
the audit gap understood and accepted explicitly.

### 6.4 From authenticated subject to "attach to THIS user's VM"

The invariant: **the guest never names anything.** Every identifier that selects a resource is
produced host-side from the token.

```
client ──TLS──> gateway
  1. validate JWT: typ == at+jwt, exact iss, aud == gateway, signature, exp   [RFC 9068 §4]
  2. introspect  (session-open only)                                         [RFC 7662]
  3. (iss, sub) ──unique index──> internal_subject_id                        [OIDC §5.7]
  4. (internal_subject_id, slot) ──> vm_id        <- host DB, authoritative
  5. vm_id ──> placement record ──> host, vsock CID
  6. host opens vsock to the in-guest agent; PTY bytes flow
```

- **Step 4 is a lookup, never a parameter.** No API accepts a client-supplied `vm_id`. Admin tooling
  that must is a different endpoint, a different scope, and a UV-required credential.
- The per-path policy artifact is resolved host-side and never mapped into the guest, so the guest
  cannot even enumerate what it is permitted to touch.
- Design the key as `(subject, slot)` **now**, so "more than one VM per user later" is additive.
- The attach ticket should be **single-use and audience-scoped** (`aud` = gateway) so a leaked ticket
  cannot be replayed and cannot be presented to the control plane itself. That is the cheap version of
  sender-constraining, applied where it actually matters.

**Per-tenant key hierarchy**, generalising Lambda:

| Layer | Key | Scope | Where it lives |
|---|---|---|---|
| Root | KMS CMK, HSM-backed | service | KMS; **never on a shell host** |
| Per-tenant | tenant CMK | one tenant | KMS; released **only** to hosts currently running that tenant's VM |
| Manifest | AES-GCM under tenant CMK; **key table encrypted, whole document authenticated** | one VM's base + its policy artifact | decrypted in the blob daemon's memory, per VM |
| Chunk | `SHA256(plaintext ‖ salt)`, AES-CTR, zero IV | global, dedup-able | **nowhere** — derived, reachable only via a manifest |
| CoW volume | per-VM data key, envelope-encrypted under tenant CMK | one VM | wrapped in the VM record; unwrapped at attach |
| Token signing | AS signing keys | service | **never on a shell host** |

The manifest trick is worth copying exactly: encrypting only the key table while authenticating the
whole document lets **garbage collection read the chunk list without ever seeing chunk keys**.

**Blast radius of a compromised host** — the second column is the interesting one:

| Gets | Does NOT get |
|---|---|
| RAM, vCPU state, CoW volumes and unwrapped data keys of tenants **currently placed on it** | Any other tenant's manifest, hence any other tenant's chunk keys |
| Those tenants' decrypted manifests and policy artifacts | Plaintext of the global chunk corpus |
| The ability to serve wrong-but-authenticated data to *its own* guests | The ability to mint tokens (AS signing keys are not on hosts) |
| | Undetectable tampering: chunks are MAC-verified against the manifest, and the base is under dm-verity with a host-supplied root hash |
| | Tenants whose VMs are elsewhere — the point of placement-scoped key release |

Salt rotation is the blast-radius dial and is explicitly *"an operational concern, and is not needed
for the security of the deduplication scheme"*: vary it in time, with chunk popularity, or by
placement, trading dedup efficiency against blast radius.

**Quotas are an authorization concern, and with vhost-user the enforcement point moves.** Firecracker
normally provides per-device two-bucket token-bucket rate limiting (ops/s and bandwidth), but
*"[f]or vhost-user devices, customers should implement rate limiting on the side of the vhost-user
backend that they provide"* — and *"there is no way to configure a read-only vhost-user drive on
Firecracker's side."* Since §3.3 rejects vhost-user, **we keep both**, which is a third independent
reason for that decision. Inherit the principle from NSDI'20 regardless: *"we do not trust the guest
to implement its own limits."* Remaining enforcement: dm-thin size cap **and** pool-fullness
watermark for CoW capacity; cgroup v2 `io.max` for CoW IOPS; a per-tenant bucket on remote blob
fetches (the one that costs money); sessions-per-subject at the control plane.

---

## 7. Control plane

### 7.1 Snapshots: four findings, and they compound

**7.1.1 vhost-user and snapshotting are mutually exclusive — confirmed verbatim.**
`docs/api_requests/block-vhost-user.md`: *"At the moment, snapshotting is not supported for microVMs
that have vhost-user devices configured. An attempt to take a snapshot of such a microVM will
fail."* Note the good part: **the API call fails**, it does not silently produce a bad snapshot. And
it is per-*microVM*, not per-device — one vhost-user device poisons the whole VM, so "snapshot with
only the non-vhost-user devices" **is not an option that exists**.

**7.1.2 Snapshots are pinned to an exact host CPU model.** *"Snapshots must be resumed on an software
and hardware configuration which is identical to what they were generated on"*, and
*"Snapshots are not compatible across CPU architectures and even across CPU models of the same
architecture."* This **kills snapshot-based mobility**: the fleet would have to be partitioned by
exact CPU model, and a snapshot becomes an anti-affinity constraint rather than a mobility tool —
in direct conflict with "one VM per user, must survive host death".

**7.1.3 Multi-resume of one snapshot is declared insecure upstream, so a snapshot is not a backup.**
*"When snapshots are used in a such a manner that a given guest's state is resumed from more than
once, guest information assumed to be unique may in fact not be ... Without a strong mechanism that
enables users to guarantee that unique things stay unique across snapshot restores, we consider
resuming execution from the same state more than once insecure."* VMGenID fixes **only** the kernel
PRNG; *"State other than the guest kernel entropy pool, such as unique identifiers, cached random
numbers, cryptographic tokens, etc **will** still be replicated."* So one snapshot, one resume — a
rollback feature must be built on the CoW volume.

**7.1.4 Snapshot files have no cryptographic integrity.** *"It only verifies integrity using a 64-bit
CRC value embedded in the vm state file, but this is only a partial measure to protect against
accidental corruption."* A snapshot is a vCPU/device state blob that Firecracker will load and run —
in a hostile multi-tenant setting that makes the snapshot store a code-execution-adjacent asset we
must encrypt and MAC ourselves.

### 7.2 Verdict: no memory suspend in v1

Persist the CoW volume and cold-boot. The reasoning, in order of weight:

1. **Snapshots attack the wrong term.** Boot-to-init is already **<125 ms** [paper]. The dominant
   remaining latency is chunk faults, which snapshots do not remove — cache warming does, and it is
   strictly simpler.
2. **They would cost the mobility we need more** (7.1.2), and that constraint fights volume locality
   directly. Making the CoW volume the only durable artifact is what makes §7.4 clean.
3. **They are single-use** (7.1.3), so they cannot double as backup or rollback — pay the storage,
   get one feature.
4. **They add a crypto surface we don't have** (7.1.4).
5. **Storage is RAM-sized per idle user.** A 512 MiB VM is a 512 MiB memory file per suspended user;
   the CoW delta is typically far smaller.
6. Restore is slow on cgroups v1 anyway: *"We strongly recommend to deploy snapshots on cgroups V2
   enabled hosts."*

Also rejected: **CRIU inside the guest**, which needs a privileged in-guest agent — i.e. trusting a
hostile guest to produce a checkpoint the host later restores. It also does not save the thing that
costs us (kernel boot) and inherits every 7.1.3 uniqueness hazard without VMGenID's help. And
**Pause/Resume**, because a paused microVM *"has neither its vCPUs nor its device models running"*
but frees no RAM, so it is not a suspend state.

**What this obliges us to build instead, and it is the real work: a resumable *session*, not a
resumable VM.** Users will accept losing a connection; they will not accept losing a three-hour
build. So persist what matters at the filesystem layer — a multiplexer started by the guest agent so
scrollback and running processes survive a *client* disconnect, and `IDLE -> STOPPED` only after
confirming no foreground job. This reframes suspend from a VMM feature into a product feature, which
is cheaper and more portable.

**Two hazards to inherit even without snapshots.** Every cold boot starts from a byte-identical
content-addressed base, which is the *same bug shape* as a cloned snapshot. Mitigations, from
`random-for-clones.md`: attach `virtio-rng`; rely on `CONFIG_RANDOM_TRUST_CPU` (guest >= 4.19);
**delete `/var/lib/systemd/random-seed` from the base image** — a seed file baked into a shared base
is exactly the cloned-entropy bug; and note `/proc/sys/kernel/random/boot_id` *"is identical across
clones unless you bind-mount fresh data over it"*. Userspace libraries keeping their own entropy
pools have *"no generic solution under the current programming model."* Separately, the agent protocol
needs a **resumable, sequence-numbered stream** regardless of suspend path: vsock connections are
closed across a snapshot while listen sockets survive, and *"[b]oth network and vsock packet loss can
be expected."*

### 7.3 State machine for one user's VM

```
 (first login) ──> PROVISIONING ──> ALLOCATED ──> STARTING ──> RUNNING <──attach/detach
                        │                                        │
                   volume, policy,                        (idle timer)
                   base digest, root hash                        v
                                                               IDLE
                                                                 v
                        RECLAIMED <── STOPPED  <─────────────────┘
                             │     (process gone, CoW volume kept
                             v      — this IS the suspend state)
                        DESTROYED
```

| Transition | Cost | Why |
|---|---|---|
| ALLOCATED -> RUNNING | **fast** — boot-to-init <125 ms [paper] | Firecracker's core competence |
| RUNNING attach/detach | **ms** | vsock connect + token validation; no VM work |
| IDLE -> STOPPED | fast | fsync the CoW volume, kill the process |
| STOPPED -> RUNNING, same host | **fast** — cold boot, warm L1 chunk cache | the common resume |
| STOPPED -> RUNNING, **new** host | **slow** — cold chunk cache + volume re-attach | §7.4 |
| PROVISIONING | **seconds** | volume creation, policy rendering, first manifest fetch |

**Reclaim-after-abandonment is a first-class state, not a cron job**, because it is the one
control-plane operation that destroys user data. Ladder, each step an audited event: 7 d idle ->
STOPPED; 30 d -> CoW volume to cold object storage (cheap, still restorable); 180 d -> notify and
start a deletion clock; then RECLAIMED. Most audit, least automation-without-notice.

### 7.4 Placement, and what happens when a host dies

Because the CoW volume is the only durable state, **placement is a storage decision wearing a compute
costume.** Rank hosts by:

1. **Can this host attach the user's CoW volume?** Hard constraint. Network-attached (Ceph/RBD,
   NVMe-oF) means "same failure domain as the volume"; host-local means "the one host", and there is
   no mobility — a decision to make deliberately, not by default.
2. **Chunk-cache affinity.** Returning to a host that already holds this user's base chunks is worth
   real latency: L1 hit **<100 µs** vs L2 **~2.75 ms** vs origin **36 ms** median [paper]. Soft, high
   weight.
3. **Capacity:** free RAM, CPU headroom, and **dm-thin pool free space** — not just configured size.
4. **Tenant isolation:** one tenant per host process, and with SMT off, place by physical core.

Note what is *absent* because of §7.2: **CPU-model affinity**, which snapshots would make mandatory
and which fights constraint 1 directly. Avoiding it is one of the main dividends of not snapshotting.

**Host death:** detect by heartbeat loss -> **fence the old host's access to the volume** -> re-run
placement under constraint 1 -> re-attach -> cold boot -> the user's next attach succeeds. Fencing is
a **precondition, not best effort**: a partitioned-but-alive host writing to the same thin volume is
corruption. Last-write loss is bounded by our fsync discipline, which is now a product parameter.

### 7.5 API surface, service-to-service authn, audit

All host-side; none of it reachable from a guest.

| Operation | Note |
|---|---|
| `POST /vms` | idempotent per `(internal_subject, slot)` |
| `POST /vms/{id}/attach` | returns a single-use, audience-scoped session ticket |
| `POST /vms/{id}/stop`, `DELETE /vms/{id}` | destructive -> require a UV-verified credential |
| `GET /vms/{id}` | state, placement, quota counters |
| `POST /vms/{id}/policy` | re-render the policy artifact; **never accepts guest input** |
| internal: `placement.assign`, `volume.attach/detach/fence`, `keys.release(tenant, host)` | the privileged core |

`keys.release` is the Lambda-shaped chokepoint — the only path by which a tenant key reaches a host —
so its authorization logic deserves disproportionate review. Note also that Firecracker's own API is
a unix socket inside the jail, so whatever renders jailer arguments is **part of the TCB** (*"[t]he
jailer treats all its inputs as trusted"*).

Service-to-service: mTLS with SPIFFE-style workload identity, short-lived leaf certs, **no ambient
network trust**. This is where RFC 8705 certificate binding is clearly worth it — machine clients
have a cert lifecycle anyway, and the §6.5 TLS-termination gap does not apply when we control both
ends.

Audit: append-only, external to the hosts, hash-chained. Every entry carries the internal subject,
the `(iss, sub)` actually used, `client_id`, the token's `jti` (REQUIRED by RFC 9068 §2.2, so it is
the natural correlation key), `auth_time`/`amr`/`acr` where present, `vm_id`, host, decision, reason.
Log every `keys.release`, every fence, every placement change, every reclaim step. Target the SSM
shape — API calls to an immutable trail, session content to separate bounded storage, events on
session start/stop — and avoid the SSM caveat by not adding a transport that makes session content
opaque to our own audit.

---

## 8. Operations

### 8.1 What breaks first, and the metric that detects it

| # | What breaks | **The metric** | Threshold |
|---|---|---|---|
| 1 | **dm-thin pool exhaustion.** Thin provisioning is overcommitment; one `dd` can do this to every co-tenant. A full *metadata* pool can make the pool unrecoverable. | `dm_thin_pool_data_used_ratio` **and** `..._metadata_used_ratio` | page at 75%, stop new placements at 85%. **Metadata is the one people forget** — the data graph looks fine. |
| 2 | **Chunk-cache miss storm** after a deploy or cache flush. The steady state is exactly why the cold case is violent: from an empty cache, downstream traffic could be up to **500x** normal [paper]. | `chunk_fetch_origin_fraction` | normal ~0.06% [paper]; alert at 1%, and **load-shed before the origin does** |
| 3 | **Placement fragmentation.** One persistent VM per user, pinned by volume locality, is bin-packing with immovable objects. | `placeable_hosts_for_new_vm / total_hosts`, p99 `time_to_placement` | investigate below 0.3 |
| 4 | **Cold-start latency on migrated resumes** — the tail users actually report. | `time_to_prompt` **split by `same_host` vs `migrated`** | the curves diverging is the signal; an aggregate hides it |
| 5 | **Idle VM accumulation.** Humans abandon shells. | `vms_by_state{IDLE} / RUNNING`, `reclaim_ladder_backlog` | ratio > 3 means the ladder is not running |
| 6 | **Blob-store bill.** A per-tenant fetch budget is the only thing between us and a guest reading its base in a loop. | `origin_bytes_per_tenant_per_hour`, `ratelimit_rejections` | **a zero rejection count means the limiter is not engaged** |
| 7 | **KMS throttling on `keys.release`** — every cold start is a decrypt, and cold starts are bursty. | `kms_decrypt_latency_p99`, `kms_throttle_count` | cache the unwrapped tenant key per host for the VM's lifetime, never longer |
| 8 | **Host-kernel boot regression.** Documented Linux 6.1 regressions in `KVM_CREATE_VM` from cgroup rw-semaphore behaviour and the `kvm-nx-lpage-recovery` thread; mitigations `favordynmods` or `kvm.nx_huge_pages=never`. | `firecracker_create_to_boot_ms` p99, **by host kernel version** | a step change after a kernel rollout |

#1 and #2 are the ones **invisible until catastrophic**, so both need synthetic drills: a pool-fill
test, and a **cold-cache load test at maximum concurrency** — which is exactly what the Lambda team
runs.

### 8.2 Cold-start budget

Components, all cited; the totals are our arithmetic over them and are a budget to measure against,
not a prediction.

| Phase | Figure | Tag |
|---|---|---|
| Firecracker VMM fork -> guest init fork | **<125 ms** | [paper, NSDI'20] |
| Boot p99 at 50 / 100 concurrent | 146 ms / 153 ms | [paper] |
| Creation rate | 150 microVMs/s/host; docs now say **5 per host core per second** | [paper] / [vendor] |
| Memory overhead per VMM | **~3 MB** non-shared, constant regardless of VM size (QEMU ~131 MB) | [paper] |
| Chunk fetch, L1 hit | **<100 µs** | [paper] |
| Chunk fetch, L2 (AZ cache) hit | **~2.75 ms** agent-measured; client median 550 µs, p99.9 3.7 ms | [paper] |
| Chunk fetch, origin | median **36 ms**, p99.9 175 ms | [paper] |
| Tier distribution | L1 67%, L2 32%, origin **0.06%**; end-to-end hit rate >99.8% | [paper] |
| Chunk size | **512 KiB** | [paper] |
| Startup working set | **6.4%** of image data needed at startup | [paper] |
| Dedup | ~80% of new uploads produce **zero** unique chunks; of the rest, median 2.5% unique | [paper] |
| Manifest overhead | <3 MiB for a 16 GiB image = **0.02%** | [paper] |
| AZ-cache erasure code | **4-of-5**: 25% storage overhead, 25% request-rate increase, for tail latency | [paper] |
| Snapshot create/restore | **no published figures** — doc explicitly silent | — |

| | Same host, warm L1 | New host, cold L1 / warm L2 |
|---|---|---|
| Control plane (authn, introspect, lookup, placement) | 10-30 ms | 10-30 ms |
| Volume attach / fence | ~0 | 50-500 ms (**unconfirmed**, backend-specific) |
| KMS unwrap | 0 (cached) | 10-50 ms (**unconfirmed**) |
| Boot to init | ~125 ms [paper] | ~125 ms [paper] |
| Base-image chunk faults during boot | mostly L1, <100 µs each | mostly L2, ~2.75 ms each — **this term dominates** |
| Guest userspace to prompt | **unconfirmed** | **unconfirmed** |
| **Rough total** | **~200-400 ms** | **~1-3 s** |

Three readings:

1. **The migrated path is 5-10x the same-host path, and the whole difference is chunk faults.** That
   makes cache affinity (§7.4 constraint 2) a latency *feature*, and metric #4's split mandatory.
2. **Snapshots would attack the wrong term** — they remove boot and userspace init but leave the
   chunk-fault term, while adding every cost in §7.1.
3. **Pooling is the lever Lambda actually pulled**, and the arithmetic is published: *"at 125 ms
   creation time, one pooled MicroVM is required for every 8 creations per second."* Our equivalent is
   a small pool of pre-booted unclaimed VMs on the generic base, bound to a user at attach — which
   §7.2 permits with no snapshot, turning a cold start into a volume attach. For v2, if
   `time_to_prompt` is the complaint.

### 8.3 Three things NOT to build in v1

1. **Snapshot/resume suspend.** Unavailable with the base layer as designed (§7.1.1), and even after
   the upstream TODO lands it pins each user to one CPU model, forbids multi-resume, needs us to build
   crypto over a CRC-64 format, and costs RAM-sized storage per idle user. Build the §7.2 session
   persistence instead.
2. **SSH and the CA behind it.** `sshd`-in-guest is architecturally disqualified; host-side `sshd` is
   a websocket gateway with an extra protocol, an extra CA, and a worse audit log (§6.3).
3. **Sender-constrained tokens for end users** (§6.3). Do use mTLS service-to-service.

*Also deferred:* SAML federation; multiple VMs per user (but key as `(subject, slot)` now so it is
additive); cross-region volume mobility; diff snapshots, which are *"in developer preview"*.

---
## Unconfirmed, flagged rather than filled in

- **No citable SMT-off performance number exists** in any kernel or vendor doc (the MDS doc says only
  *"significant"*; benchmark sites block automated fetches). Budget ~2x core loss and **measure on our
  hardware**.
- No publicly demonstrated full guest-to-host RCE for Firecracker or Cloud Hypervisor — both
  advisories stop at *"could lead to"*. Separately, `virtio-queue` (rust-vmm), the hottest
  attacker-facing parser in the stack, has **zero advisories in any database**. Read that as absent
  reporting, not absent bugs; Firecracker's 2 GHSAs in 7 years is partly a reporting artifact, since
  no bug-bounty research targets it the way Pwn2Own targets VMware.
- Behaviour of a *missing* (as opposed to corrupt) composefs redirect target.
- nbdkit `cache` filter knobs; NBD kernel-client timeout semantics; FUSE-as-lowerdir caveats.
- Whether Lambda deliberately orders chunks by expected access (the paper does not claim it).
- QEMU per-device CVE counts are keyword matches on vendor bug summaries, so +/- a few per class.
- No sweep of Black Hat / DEF CON / Project Zero archives for undisclosed escape demos.
- Nitro and Intel TDX-module host-impact claims were not independently verified; the NCC Group report
  is a design review of API claims, not a hypervisor pentest.
- No credible FTE figure for operating Ceph exists; the user survey last published in 2022 with 127
  responses. Anyone quoting one is quoting folklore.
- **Whether Firecracker accepts a block-device node as `path_on_host`, and how a network-backed drive
  behaves across snapshot save/restore.** This is the one spike that would reopen snapshots (§3.3).
- Firecracker snapshot create/restore latency: **no published figures**; the doc is explicit that it
  "depends on the memory size, vCPU count and emulated devices count". The incidental 3 ms -> 8.5 ms
  aarch64 number in `prod-host-setup.md` is a host-kernel-cmdline regression, not a general cost.
- `snapshot-support.md` is silent on balloon and entropy-device snapshot support; only the vhost-user
  exclusion was confirmed, and from `block-vhost-user.md`.
- **The stable SAML subject key.** `(IdP EntityID, NameID Format=persistent)` is a recommendation,
  not a cited claim — confirm against OASIS SAML 2.0 Core before implementing.
- `PROTOCOL.certkeys` could not be fetched, so the SSH certificate wire format (`serial`, `key id`,
  validity, critical-options vs extensions) is unconfirmed; the field list cited is from
  `ssh-keygen(1)`.
- Default SSH certificate lifetimes and OIDC-claim-to-principal mapping for Teleport, Smallstep and
  Netflix BLESS (the last is archived and unmaintained).
- **Confirmation-of-file attack on convergent encryption.** The Lambda paper does not discuss it; an
  attacker who guesses a plaintext can confirm its presence by deriving the key and testing whether
  the chunk name exists. Whether our salt mitigates it depends on salt secrecy and scope. Worth its
  own review.
- The ATC'23 KMS grant mechanism has no protocol detail published, and the paper has no explicit
  threat-model section.
- Whether GitHub permits a released username to be reclaimed by someone else. Key on the numeric
  `id` regardless.
- WebAuthn §7 RP-ID validation steps were not read directly, nor the exact wording on whether an RP
  may *require* device-bound credentials via BE/BS.
- Firecracker's current seccomp allowlist size: the "24 syscalls and 30 ioctls" figure is from
  NSDI'20 (2020) and is very likely stale.
- **The composed cold-start totals in §8.2 are our arithmetic**, and the volume-attach, KMS-unwrap
  and guest-userspace-to-prompt terms are estimates, not sourced. Measure them.
- The "6.4% of image data needed at startup" figure is for Lambda's container workloads, not an
  interactive Linux shell. Our working set is unmeasured.
