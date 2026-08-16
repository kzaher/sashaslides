# Why typing into codex is laggy (2026-08-16)

Measured on `build/eh-nb` (JIT `2:2000`) with `harness/run.mjs` and, for the browser half, on
`web/vm.html?engine=opt&image=codex&jit=2:2000` in the shared Chrome. Raw data, scripts and logs live
under `work/prof/typing/` (listed at the end). Guest instruction counts are exact and reproducible;
wall times come from a shared 8-core box and wobble by about 15 %.

## Executive summary

1. **The console/input path is not the problem.** From the byte being queued on the host to the
   engine actually reading it: **0.13-3.4 ms, 0 guest instructions** (median 0.15 ms while the guest
   is idle). The virtio-console rx timer re-arms at 10 ms of *guest* time, but the guest is halted
   while idle and Bochs jumps its clock, so 10 ms of guest time costs ~0.15 ms of wall time.
2. **A keystroke is a full-screen ratatui re-render.** On the sign-in menu a cursor key costs
   **1.8-2.6 M guest instructions (10-23 ms wall)**; on the composer screen a printable character
   costs **40.7 M instructions (159-196 ms)** (main's measurement). The same key in `/bin/sh` costs
   **70,002 instructions / 2.0 ms**. So codex is 34x-580x more expensive per key than the tty path
   itself, and 84 % (sign-in) to 57 % (composer) of that is codex's own user code.
3. **In the browser, key -> first `xterm.write` is 9.8-14.7 ms (median 13.2 ms, n=6)** on the sign-in
   screen: the browser adds essentially nothing on top of the guest work. The worker's WASI layer
   costs 5.5 % of a core in `poll_oneoff` and 1.6 % in `fd_write`.
4. **The real reason it feels laggy is that the guest is pinned.** codex animates continuously: a
   full frame every **14.55 ms of wall time**, 2.34 M instructions each, i.e. **68.7 frames/s and
   ~75 % of the emulated CPU, forever**. In the browser this is already running *before* the first
   keystroke (2 s idle baseline: 258 `xterm.write`s, 66 KB, **307 M guest instructions = 154 MIPS =
   100 % of the emulated CPU**). Every key therefore queues behind an in-flight frame, and the
   browser main thread parses 130 terminal writes per second.
5. **The animation runs 5.5x too fast because guest time runs 5.5x faster than wall time.**
   `bochsrc` declares `cpu: ips=40000000` while the engine really executes 155-220 M instructions/s,
   and `NANOBOX_DETERMINISTIC` deliberately disables Bochs' `sync=slowdown` throttle
   (`iodev/slowdown_timer.cc`: "the guest may run faster than real time") so nothing pulls the guest
   clock back. codex asks for a frame every **80.0 ms of guest time** (12.5 guest-fps) and gets
   68.7 fps of wall time. Raising `ips` is a change to a *constant*, so determinism is preserved.
6. **Two guest-side hot spots dominate the render**, both re-done from scratch every frame:
   ratatui's layout/paint/diff (`Buffer::set_style`, `WordWrapper::next_line`,
   `Graphemes::next`, `diff_buffers`) and, on the composer screen,
   `codex_tui::terminal_hyperlinks::*` re-parsing every URL on screen with the `url` crate
   (`url::parser::Parser::parse_path`/`parse_host`/`check_url_code_point`, ~20 % of user time).
7. Ranked fixes in section 5: (1) `cpu: ips=` ~200 M [-80 % of the standing guest CPU, 5.5x less
   redraw traffic], paired with (2) a shorter virtio-console rx re-arm in `bochs/bochs/wasm.cc`
   (needed *because of* (1)); then browser-side write coalescing. The JIT is already at **94 %**
   coverage on this path, so `docs/hotpaths-codex.md`'s JIT levers buy little here.

## 1. Method

Additive options were added to `harness/run.mjs` (nothing existing changed):

| option | what it does |
|---|---|
| `--after-expect "TEXT@MS"` | type TEXT, MS ms after `--expect` fires; `--expect` then does **not** stop the run. TEXT may be empty (`'@200'`) - a pure marker. |
| `--stop-after-expect MS` | finish MS ms after `--expect` fired (a deterministic window, unlike the absolute `--timeout`) |
| `--io-log FILE` | JSONL of every console/stdin event stamped with wall time **and** the guest's own clock: `key` (harness queued the bytes), `poll` (the engine's rx timer looked at stdin), `in` (the engine read them), `out` (the guest wrote to the console), each with `icount`/`ticks`/`rip` |
| `--pages-mark PREFIX` | with `--pages`: dump the page profile at every scripted keystroke, as `PREFIX.<n>` - so one keystroke is isolated by diffing two marks in the **same** run |
| `summary.statsEnd` | the JIT counters at exit, so a window is `statsEnd - dumps[expect].stats` |

Plus two new files: `harness/profwindow.mjs` (self time of a `.cpuprofile` restricted to a time
window, split into engine / JIT'd-code / JS) and `test/typing-browser.mjs` (CDP: boots the page,
wraps `xterm.write`, sends keys, samples `window.nanobox.stats.io`; installs nothing permanently).
`tools/guest-symbolize.mjs` turns the profiles into function names - see `docs/guest-symbols.md`.

Typical run (ESC is written as the JSON escape ``):

```
node harness/run.mjs build/eh-nb/out.wasm --oci http://localhost:8093/c2w/images/codex/ \
  --spec web/images/codex/config.json --oci-cache work/oci-cache --cmd /usr/local/bin/codex \
  --expect "Press enter to continue" --after-expect '@200' --after-expect '[B@300' \
  --after-expect '@800' --stop-after-expect 1600 --pages p.txt --pages-mark p --io-log io.jsonl \
  --quiet --no-hash --jit 2:2000
```

The keystroke used here is a cursor key on the sign-in menu (the only interactive screen reachable
offline); it moves the selection and forces a full ratatui re-render.

## 2. The latency budget of one keystroke

Browser, `engine=opt`, JIT 2:2000, codex 0.147.0 on the sign-in screen. "wall" is what the user feels.

| stage | wall | guest instructions | evidence |
|---|---|---|---|
| browser input: xterm key -> pty -> worker -> engine stdin | **< 1 ms** (not separately observable) | - | browser end-to-end 13.2 ms vs harness guest-only 10-23 ms |
| engine notices the byte (virtio-console rx timer, 10 ms of *guest* time) | **0.13-0.25 ms** idle, up to **3.4 ms** while the guest is busy | 0 (guest halted) | `--io-log`: `key` -> `in` |
| guest kernel: tty/termios, wake the reader, deliver the bytes | **~0.4 ms** | ~70 k | the entire `/bin/sh` echo costs 70,002 instructions / 2.0-3.7 ms |
| **codex user code: ratatui reflow + paint + diff -> 504-byte update** | **10-23 ms** (sign-in) / **159-196 ms** (composer) | **1.82-2.58 M** / **40.7 M** | `--io-log` `in` -> first `out`, n=5 |
| browser output: `fd_write` -> SAB -> page -> `xterm.write` + render | 0.13 ms per write in the worker | - | `stats.io`: 254 writes / 32.2 ms over 2 s |
| **total** | **~13 ms median (9.8-14.7) on sign-in, plus queueing behind the in-flight frame** | ~2.3 M | `test/typing-browser.mjs` |

Engine overhead sits *inside* the codex row: **155-160 MIPS = 6.3 ns per guest instruction**. Over
the redraw loop the CPU profile (`harness/profwindow.mjs --last 5.5`) splits as

| category | share of 5.5 s |
|---|---|
| JIT'd trace code | **63.5 %** |
| engine (interpreter handlers, `cpu_loop`, decode, TLB) | 32.7 % |
| host JS (WASI shim, harness) | 3.7 % |
| GC | 0.1 % |

On this workload the JIT is doing its job: over a 2.8 s / 5-keystroke window the level-3 counters
give **47.4 M of 50.3 M trace executions inside JIT'd code (94 %)** (`links` 43.05 M + `loopbacks`
3.32 M + `jitTraces` 1.09 M), with only `linkFail[4]` = 0.91 M "next trace not compiled". What
remains is `linkFail[2]` = **12.62 M cross-page fetch-window refills (29 % of all links)**,
`linkFail[7]` = 1.34 M handler steps and `slow` = 0.91 M slow-path memory helpers.

## 3. The standing cost: a 68.7 fps redraw of a screen that is not changing

From `--io-log` over 6 s after one keystroke (396 frames):

| | value |
|---|---|
| frame period, wall | **14.55 ms -> 68.7 fps** |
| frame period, guest time | **80.0 ms -> 12.5 fps** (what codex asked for) |
| instructions per frame | **2.34 M** (58 ms of guest time) |
| guest CPU busy | **73-76 %** (instructions per tick over the window) |
| bytes per frame | 504 + 8 (a synchronized update, `?2026h` ... `?2026l`) |

In the browser the same loop runs **before the first keystroke**: over a 2 s idle baseline, 258
`xterm.write`s (66 KB) and 307 M guest instructions (100 % of the emulated CPU). In the harness
codex goes idle after ~200 ms (1.7 % guest CPU) and the loop starts at the first key - either way,
from the first interaction the machine is pinned.

The mismatch between the two frame rates is the whole story: `work/pack-out-nb/pack/bochsrc` says
`cpu: ips=40000000`, the engine really runs at 155-220 MIPS, and `iodev/slowdown_timer.cc` under
`NANOBOX_DETERMINISTIC` never sleeps. Every guest timer, including codex's frame timer, therefore
fires **5.5x too often in wall-clock terms**.

## 4. Where the instructions go (symbolized)

`tools/guest-symbolize.mjs`; load base from the `/proc/*/maps` captured in the same run, symbols from
`codex.debug` (see `docs/guest-symbols.md`).

### 4.1 Sign-in screen, 500 ms window containing one cursor key (82.3 M instructions)

```
#    count    share  link addr        symbol
     7542411    9.17%  0xb21c2b0       ratatui_core::buffer::buffer::Buffer::set_style
     7031355    8.55%  0xb21b1b0       <ratatui_widgets::reflow::WordWrapper<O,I> as ratatui_widgets::reflow::LineComposer>::next_line
     4651960    5.66%  0xb21a570       <unicode_segmentation::grapheme::Graphemes as core::iter::traits::iterator::Iterator>::next
     3697015    4.49%  0xa5d3000       codex_tui::custom_terminal::diff_buffers
     2765967    3.36%  0xb222990       <&ratatui_widgets::block::Block as ratatui_core::widgets::widget::Widget>::render
     2757951    3.35%  0xa6e5360       <&codex_tui::onboarding::onboarding_screen::OnboardingScreen as ratatui::widgets::widget_ref::WidgetRef>::render_ref
     2461898    2.99%  0xb219380       <str as ratatui_core::buffer::cell_width::CellWidth>::cell_width
     2173036    2.64%  0xb21cbb0       ratatui_widgets::paragraph::render_line
     2149330    2.61%  0xb21cde0       ratatui_widgets::paragraph::Paragraph::line_count
     1937716    2.36%  0xffffffff9551a000  [kernel page]
     1815520    2.21%  0xa6e5b80       <codex_app_server_protocol::..::RawResponseItemCompletedNotification as core::clone::Clone>::clone
     1759400    2.14%  0xffffffff95505000  [kernel page]
     1457910    1.77%  0xb21ca30       ratatui_widgets::reflow::trim_offset
     1404754    1.71%  0xffffffff95a01000  [kernel page]
     1403269    1.71%  0xb2167d0       <ratatui_core::buffer::diff::BufferDiff as core::iter::traits::iterator::Iterator>::next
     1361640    1.66%  0xa6e48d0       <codex_app_server_protocol::..::ThreadSettingsUpdatedNotification as core::clone::Clone>::clone
     1272977    1.55%  0xb215dc0       <&ratatui_core::text::span::Span as ratatui_core::widgets::widget::Widget>::render
      978494    1.19%  0xb222740       <ratatui_widgets::clear::Clear as ratatui_core::widgets::widget::Widget>::render
      947607    1.15%  0xb211600       <ratatui_core::style::color::Color as core::fmt::Debug>::fmt
      853200    1.04%  0xb218f20       <ratatui_core::text::line::Line as core::fmt::Debug>::fmt
# kernel 15.7% / user 84.3%; top 20 = 61.3%
```

It is a **full-frame re-render**, not an incremental one: the whole widget tree is laid out (reflow,
grapheme segmentation, width measurement), painted into a fresh `Buffer` (`Buffer::set_style` alone
is 9 %), and only then diffed against the previous buffer (`diff_buffers`, `BufferDiff::next`) to
produce 504 bytes. `Color`/`Line`'s `Debug::fmt` plus `bitflags::parser::to_writer` and musl's
`printf_core` (~2.9 % together) show formatting on the render path.

### 4.2 Composer screen, one printable character (main's profile, `work/prof/pg/key.3` -> `key.4`)

```
#    count    share  link addr        symbol
    16587969   24.39%  0xffffffff9541d000  [kernel page]
     5053920    7.43%  0xa9c6cd0       codex_tui::terminal_hyperlinks::remap_wrapped_line
     4157978    6.11%  0xbc72a60       url::parser::Parser::parse_path
     3531690    5.19%  0xffffffff95a00000  [kernel page]
     2720927    4.00%  0xb219380       <str as ratatui_core::buffer::cell_width::CellWidth>::cell_width
     2197962    3.23%  0xa9c7bd0       codex_tui::terminal_hyperlinks::mark_buffer_hyperlinks
     1988333    2.92%  0xbc72020       url::parser::Parser::parse_host
     1403135    2.06%  0xbc707b0       url::parser::check_url_code_point
     1247413    1.83%  0xbc70b10       url::parser::starts_with_windows_drive_letter_segment
     1213800    1.78%  0xa9c7980       codex_tui::terminal_hyperlinks::sanitized_destination
     1210499    1.78%  0xffffffff9586a000  [kernel page]
     1114047    1.64%  0xffffffff95424000  [kernel page]
     1105817    1.63%  0xbc726b0       url::parser::Parser::parse_path::push_pending
      942970    1.39%  0xb218f20       <ratatui_core::text::line::Line as core::fmt::Debug>::fmt
      939680    1.38%  0xbc73b90       url::parser::Parser::parse_query
      886795    1.30%  0xbc6ffc0       url::Url::set_query
# kernel 43.3% / user 56.7%; top 16 = 68.1%
```

`codex_tui::terminal_hyperlinks::mark_buffer_hyperlinks` + `remap_wrapped_line` +
`sanitized_destination` re-scan the rendered buffer and **re-parse every URL on screen with the
`url` crate on every frame** (`url::parser::*` plus `__intscan` / `__libc_realloc` /
`aligned_alloc`): about 20 % of all instructions per keystroke. That is the single largest
*avoidable* user-side item, and it is codex's own code (memoizing per unchanged line would remove it).

Exactness check: the hottest sign-in page was re-profiled with `--focus` (per offset), which
attributes **92.7 %** of it to `Buffer::set_style` - the page-level split is a good estimate, but use
`--focus` when one number matters.

### 4.2b Exact accounting of one keystroke (`--focus`, 25 pages, 85.9 % attributed)

The §4.2 table is the *page-proportional* estimate and it mis-attributes badly on shared pages. Below
is the **exact** per-offset accounting of one keystroke, from `--focus` histograms diffed between two
`--pages-mark` marks 10 ms before and 220 ms after the key, in the same run
(`work/prof/typing/pf-*-focus.{1,3}`, 25 separate runs, one focused page each).

State: `--cmd /usr/local/bin/codex`, Enter at the welcome screen, then a printable `x` on the
**"Finish signing in via your browser" screen**, which shows a **472-character OAuth URL** wrapped
over 6 lines. Terminal geometry **80 x 25** (max CUP row 25 / col 76; `console_get_size()` in
`wasm.cc` reports 80x25). Note this is *not* the composer - the composer needs a completed sign-in.

* window total **41,360,396** instructions, of which **kernel 3,447,663 = 8.3 %**, user 91.7 %;
* the keystroke proper (engine `fd_read` -> last byte of the frame) is **41,212,997 instructions /
  208 ms**; the rest is the ~20 M instr/s idle loop leaking into the 230 ms window;
* **exactly ONE frame is emitted** for the keystroke: one `?2026h` ... `?2026l` synchronized update,
  **408 bytes**, produced 199 ms after the byte was read. codex does **two internal render passes**
  per emitted frame (`mark_url_hyperlink` is entered twice), but the terminal sees one update.

| instructions | % | calls | instr/call | function |
|---:|---:|---:|---:|---|
| 7,903,108 | 19.11 | (see note) | - | `__libc_realloc` |
| 7,000,400 | 16.93 | 1,892 | 3,700 | `<url::parser::Parser::parse_query::QueryPartIter as Iterator>::next` |
| 4,972,176 | 12.02 | 946 | 5,256 | `url::parser::Parser::parse_query` |
| 4,223,462 | 10.21 | 946 | 4,465 | `codex_tui::terminal_hyperlinks::sanitized_destination` |
| 2,976,193 | 7.20 | 30 | 99,206 | `alloc::raw_vec::RawVecInner<A>::finish_grow` |
| 1,262,207 | 3.05 | 2,644 | 477 | `bcmp` |
| 795,275 | 1.92 | 2,863 | 278 | `core::fmt::Formatter::pad` |
| 680,415 | 1.65 | 3,813 | 178 | `malloc` |
| 557,996 | 1.35 | 3,871 | 144 | `free` |
| 555,871 | 1.34 | 2,488 | 223 | **kernel** timekeeping page (`rdtscp` reader 1,260 + `ktime_get_mono_fast_ns` 1,228) |
| 490,974 | 1.19 | 946 | 519 | `url::parser::Parser::after_double_slash` |
| 480,568 | 1.16 | 946 | 508 | `url::parser::Parser::parse_host` |
| 440,836 | 1.07 | 946 | 466 | `url::parser::Parser::parse_path` |
| 430,252 | 1.04 | 8 | 53,782 | `ratatui_core::buffer::buffer::Buffer::set_style` |
| 427,888 | 1.03 | - | - | `__libc_free` |
| 403,002 | 0.97 | 1,804 | 223 | `memcmp` |
| 395,648 | 0.96 | 1,530 | 259 | `<unicode_segmentation::grapheme::Graphemes as Iterator>::next` |
| 346,368 | 0.84 | 2 | 173,184 | `codex_tui::terminal_hyperlinks::mark_url_hyperlink` |
| 306,318 | 0.74 | 1,892 | 162 | `url::parser::Parser::parse_path::push_pending` |
| 209,066 | 0.51 | 946 | 221 | `percent_encoding::PercentDecode::if_any` |
| 169,706 | 0.41 | 3,273 | 52 | `memcpy` |
| 141,264 | 0.34 | 38 | 3,718 | `<ratatui_widgets::reflow::WordWrapper<O,I> as LineComposer>::next_line` |
| 139,093 | 0.34 | 947 | 147 | `memset` |
| 108,070 | 0.26 | 34 | 3,179 | `ratatui_widgets::paragraph::render_line` |
| 105,529 | 0.26 | 1 | 105,529 | `codex_tui::custom_terminal::diff_buffers` |
| 96,259 | 0.23 | **229 syscalls** | 420 | **kernel** `entry_SYSCALL_64` page |
| 92,708 | 0.22 | 946 | 98 | `codex_tui::terminal_hyperlinks::web_destination` |
| 78,308 | 0.19 | 1,556 | 50 | `<str as ratatui_core::buffer::cell_width::CellWidth>::cell_width` |
| 68,112 | 0.16 | 946 | 72 | `url::parser::Parser::with_query_and_fragment` |
| 52,030 | 0.13 | 946 | 55 | `url::parser::Parser::parse_path_start` |
| 45,334 | 0.11 | 6 | 7,556 | `alloc::raw_vec::RawVecInner<A>::reserve::do_reserve_and_handle` |
| 39,648 | 0.10 | 944 | 42 | `codex_tui::terminal_hyperlinks::osc8_hyperlink` |
| 36,160 | 0.09 | 953 | 38 | `<String as core::fmt::Write>::write_str` (2 sites) |
| 18,920 | 0.05 | 946 | 20 | `url::parser::Parser::parse_query_and_fragment` |

**The headline number: 946 full `Url::parse` calls per keystroke on a 472-character URL.** Every
per-parse function is called exactly 946 times (`sanitized_destination`, `parse_query`, `parse_host`,
`parse_path`, `after_double_slash`, `web_destination`, `percent-decode`), 944 for `osc8_hyperlink`;
`QueryPartIter::next` and `push_pending` are 1,892 = 2 x 946. `mark_url_hyperlink` runs twice per
keystroke, so it is **one URL parse per character of the URL, per render pass**
(2 x 472 = 944 ~ 946). Together the `url` + `terminal_hyperlinks` + percent-decoding work is
**~18.5 M instructions = 45 %** of the keystroke, and the allocator churn it causes
(`__libc_realloc` + `finish_grow` + `malloc`/`free` + `memcpy`/`memcmp`/`bcmp`/`memset`) is another
**~14.5 M = 35 %**. Ratatui's own layout/paint/diff is **under 3 %** on this screen.

**`Buffer::set_style` costs ~54,000 instructions per call** on an 80x25 screen (~27 instructions per
cell of the styled area, i.e. it is a whole-area sweep). On *this* screen it is called only 8 times,
so it is 1 %. On the **sign-in menu** screen (§4.1) the same function is entered **648 times** in a
9 s run at ~51,000 instructions per call - that is why it tops that profile. Its per-call cost is not
the anomaly; the number of whole-area re-styles per frame is.

Caveats on the `calls` column: it is the number of traces that *start* at the function's entry
address. That equals the call count for normally-called functions (verified: every per-URL-parse
function lands on exactly 946), but it **undercounts** when the callee is swallowed into a JIT region
or entered by a tail jump - `__libc_realloc` shows 3, `__libc_free` 1, so their instr/call is
meaningless while their instruction totals are exact.

### 4.2c Syscalls and the RDTSC question

* **229 syscalls per keystroke** (`entry_SYSCALL_64` entry-address trace count on kernel page
  `0xffffffff95a00000`), costing 96,259 instructions of entry/exit = 0.23 % of the keystroke.
  Splitting by `rax` is not reachable from `--focus`; it would need `--dbg` with register logging.
* **~2,488 TSC reads per keystroke**, not 260,000: `rdtscp` reader 1,260 executions +
  `ktime_get_mono_fast_ns` 1,228, together **555,871 instructions = 1.34 %** of the keystroke. The
  earlier 260 k estimate came from a window (`work/prof/pg/key.3` -> `key.4`) that spanned a whole
  inter-keystroke interval, so it was dominated by the **idle** loop, not by the keystroke: in that
  1.2 s window the same page is 19.7 %, in the 230 ms keystroke window it is 1.3 %.
  This is consistent with the level-3 dynamic counters over a 15 s run (RDTSC 48,170 + RDTSCP 41,563
  ~ 6 k/s, i.e. the idle loop). **Conclusion: an inline `RDTSC`/`RDTSCP` JIT template is not worth
  building** - the whole timekeeping path is 1.3 % of a keystroke and removing the handler-step
  overhead would recover well under 1 %. (Proposal 5 in section 5 is withdrawn on this evidence;
  `MOV CRn` at 229 syscalls x 2 is likewise small per keystroke, so proposal 4 is an idle/boot win,
  not a typing win.)

### 4.3 Kernel

Kernel attribution is **by page only**: the guest kernel (Linux 6.1.0, container2wasm's build) is
stripped, `/proc/kallsyms` does not exist in the guest (no `CONFIG_KALLSYMS`), and the `vmlinux`
recovered from `work/pack-out-nb/pack/boot.iso` has no `.symtab`. The KASLR slide for this snapshot
is **`0x14400000`** (recovered by content-anchoring two saved guest pages - see
`docs/guest-symbols.md` section 5), so:

| guest page | vmlinux link address | vmlinux file offset |
|---|---|---|
| `0xffffffff9541d000` | `0xffffffff8101d000` | `0x21d000` |
| `0xffffffff95424000` | `0xffffffff81024000` | `0x224000` |
| `0xffffffff95a00000` | `0xffffffff81600000` | `0x800000` |
| `0xffffffff9586a000` | `0xffffffff8146a000` | `0x66a000` |

Disassembling the saved guest page (`harness/run.mjs --save-phys <phys>:page.bin` where
`phys = guest VA - 0xffffffff86000000`, then
`objdump -D -b binary -m i386:x86-64 -M intel --adjust-vma=<guest VA> page.bin`) plus a `--focus`
histogram of the page is how the two big ones were identified. Both are unambiguous:

* **`0xffffffff9541d000` (24 % of a composer keystroke, the single hottest page in the system) is
  x86 timekeeping.** `--focus` puts the counts at `+0x5a4` (`rdtsc; shl rdx,32; or rax,rdx; ret` =
  out-of-line `rdtsc_ordered`), `+0x5b2` (the same with `rdtscp`) and, above all, `+0xdd5`
  (`rdtsc` + a seqcount-latch read of the `tk_fast_mono` timekeeper + `mul`/`shrd` scaling =
  `ktime_get_mono_fast_ns()` / `sched_clock()`), ~60 instructions per call. At 15.8 M instructions
  per keystroke that is roughly **260,000 clock reads per typed character**. The engine makes each
  one worse: `RDTSC` and `RDTSCP` are **JIT fallbacks** (15,322 dynamic handler steps in a 2.8 s
  window), so every one of them spills and reloads the whole register set out of the JIT'd trace.
* **`0xffffffff95a00000` (5.2 %) is `entry_SYSCALL_64`** (`swapgs`, the `pt_regs` push, register
  clearing, `sysret`) - and it is the **PTI** variant: it does
  `mov rsp,cr3; bts rsp,63; and rsp,~0x1800; mov cr3,rsp` on entry and the mirror on exit. Under
  emulation each `mov cr3` is a JIT fallback *and* a non-global TLB flush: `MOV_CR3Rq` 47,417 +
  `MOV_RqCR3` 39,994 handler steps in that window, plus `SWAPGS` 72,979 and `VERW_Ew` 26,756 (the
  MDS mitigation on every kernel exit).

`0xffffffff95424000` (1.6 %) is an MSR dispatch `switch` (`0x28e`-`0x293`); `0xffffffff9586a000`
shows up in the idle profile too. Names for everything else need the kernel rebuilt with
`CONFIG_KALLSYMS=y` (or its `System.map` kept next to the image): pass that file to
`guest-symbolize --kernel-map` and every kernel row gets a name.

## 5. Ranked fixes

| # | change (where) | expected gain | risk | effort |
|---|---|---|---|---|
| 1 | **Make guest time track real time: `cpu: ips=40000000` -> ~`200000000`** in the packed `bochsrc` (`vm-build/pack` -> `work/pack-out-nb/pack/bochsrc`, baked into the engine). Measured: guest time advances **5.5x faster than wall time**, so codex's 12.5-guest-fps animation renders at 68.7 wall-fps. At a matched `ips` the animation costs **~13 % of the emulated CPU instead of 75 %**, the terminal receives **5.5x fewer bytes**, and a keystroke stops queueing behind an in-flight frame. `ips` is a constant, so determinism is untouched - unlike re-enabling `sync=slowdown`, which `NANOBOX_DETERMINISTIC` disables precisely because it makes guest RAM a function of host speed. | **the big one**: ~60 % of the emulated CPU handed back; typing jitter largely gone | identity baselines must be **re-recorded** (every tick/instruction relation changes); guest timeouts, TCP and watchdogs all scale; gate with `test/identity.sh` with both engines moved together | S (one line) + a re-record |
| 2 | **Shorten the virtio-console rx re-arm while the CPU is actually running** (`bochs/bochs/wasm.cc`, `bx_virtio_console_ctrl_c::rx_timer_handler`). Today: 100 us after a hit, 10000 us when idle. 10 ms of guest time is ~0.15 ms of wall time while the guest is halted but ~1.8 ms while it runs flat out - and **after fix 1 it becomes a real 10 ms**, which would be a regression. Patch below. | -1 to -2 ms today; **required** so fix 1 does not make delivery worse | low; 4x more `select()`/`poll_oneoff` calls while the guest is busy (a poll costs ~0.036 ms in the browser, so ~+4 % of a core) | S |
| 3 | **Coalesce terminal writes in the page** (`web/vm.html`, `web/sandbox.html`): buffer the bytes coming out of the worker and hand xterm.js **one `write()` per `requestAnimationFrame`** instead of the current 130/s. codex already brackets each frame in a synchronized update, so a frame can be flushed as one parse. | main-thread parse/render work down ~5x | low (browser-side only, nothing guest-visible) | S |
| 4 | **Boot the guest with `pti=off mitigations=off` (kernel cmdline in `vm-build/`).** `entry_SYSCALL_64` is the PTI variant: two `mov cr3` per syscall, each a JIT fallback *and* a non-global TLB flush (47 k + 40 k handler steps per 2.8 s window), plus `VERW` on every exit (27 k). The guest is a single-tenant emulator with no untrusted neighbours, so the mitigations buy nothing here. | syscall entry/exit cost down substantially; ~5 % of a composer keystroke plus the TLB refills it causes | low (guest-visible: identity baseline moves) | S |
| 5 | **Give the JIT an inline template for `RDTSC`/`RDTSCP`** (and `SWAPGS`, `MOV CRn`). The hottest page in the system is `rdtsc`-based timekeeping (~260 k clock reads per composer keystroke) and every one of them currently leaves the JIT'd trace for a Bochs handler step with a full register spill/reload. | directly attacks the 24 % kernel page | low (a template, the identity gate covers it) | S-M |
| 6 | **Build the guest kernel with `CONFIG_KALLSYMS=y`, or keep its `System.map` in the image** (`vm-build/`). 43 % of a composer keystroke is kernel; two pages were identified by hand above, the rest are anonymous. | unblocks the rest of the kernel profile | none (debug only) | S |
| 7 | **Deliver input on write instead of on the timer**: let the host make the rx timer fire "now" (`activate_timer(id, 1, false)` plus `async_event`) when bytes are queued. In the browser the worker is blocked inside the engine, so this has to be a cheap shared-memory flag that `cpu_loop`'s async check tests - i.e. fix 2 done properly. | delivery latency to ~0 instead of "up to half the poll period" | medium (touches the async-event path) | M |
| 8 | **JIT, this path**: coverage is already **94 %**, so `docs/hotpaths-codex.md`'s iCache levers barely apply here. What is left is `linkFail[2]` = 12.6 M cross-page refills (29 % of links) -> that report's proposal 4 (successor cache carrying the target's fetch page), and `linkFail[7]` = 1.34 M handler steps. | -5 to -10 % of the render | low-medium | M |
| 9 | **Not worth it (measured)**: the browser input path (< 1 ms), `fd_write` (1.6 % of a core), the guest tty layer (70 k instructions, 3 % of a sign-in keystroke), `poll_oneoff` (5.5 % of a core). Guest-side changes to codex/ratatui are excluded by the identity requirement (but see 4.2: the hyperlink re-parse is a ~20 % item somebody should report upstream). | - | - | - |

### Patch proposed for `bochs/bochs/wasm.cc` (fix 2 - not applied; that file is not mine)

```diff
@@ bx_virtio_console_ctrl_c::rx_timer_handler @@
     if (ret > 0) {
       bx_pc_system.activate_timer(class_ptr->timer_id, 100, false); /* not continuous */
     } else {
-      bx_pc_system.activate_timer(class_ptr->timer_id, 10000/*10ms*/, false); /* not continuous */
+      // nanobox: this period is GUEST time. While the guest is halted Bochs jumps its clock to the
+      // next timer, so 10 ms of guest time costs ~0.15 ms of wall time and the guest sees the key
+      // immediately. While the guest is *running* (a TUI redrawing) 10 ms of guest time is real
+      // emulated work -- 1.8 ms of wall time today, and a full 10 ms once `cpu: ips=` is raised to
+      // the engine's true throughput. Poll 4x more often in that case; it is still 25x cheaper
+      // than the 100 us period used right after a hit.
+      // Measured: keystroke delivery 0.13-3.4 ms -> 0.13-0.9 ms.
+      const unsigned idle_period_us =
+        (BX_CPU(0)->activity_state == BX_ACTIVITY_STATE_ACTIVE) ? 2500 : 10000;
+      bx_pc_system.activate_timer(class_ptr->timer_id, idle_period_us, false); /* not continuous */
     }
 }
```

The host-channel branch above it (`got > 0 ? 100 : 2000`) is already at 2 ms and needs no change.
Verify with `node harness/run.mjs ... --after-expect 'x@300' --io-log io.jsonl` and compare the
`key` -> `in` deltas, then run `test/identity.sh` (the timer period is guest-visible, so the identity
baseline moves).

## Files

All under `work/prof/typing/`: `r1.sh ... r9.sh`, `rk-*.sh` (the runs), `io-codex-{1..8}.jsonl` and
`io-sh-{1,9}.jsonl` (I/O event logs), `pages-codex.*`, `pages7.*`, `pages9.*` (page profiles at each
keystroke mark), `focus8-f24b000.txt`, `focusK*.txt` (per-offset histograms), `tr7.txt` / `tr8.txt`
(transcripts carrying the `/proc/*/maps` capture), `key-anim.cpuprofile` (V8 profile of the redraw
loop), `kpage-*.bin` (guest kernel pages, for the KASLR slide and disassembly), `sym-key.txt` (the
symbolized top 20), `browser1.log` (`test/typing-browser.mjs`). Symbols in
`work/symbols/codex-symbols-x86_64-unknown-linux-musl/codex.debug`. Main's profiles in
`work/prof/pg/`.


## 6. What we changed, and what each change bought (measured)

`build/eh-ips` = `cpu: ips=40000000 -> 200000000` in `work/pack-out-nb/pack/bochsrc` + the rx re-arm
patch of §5.2 (both now folded into the production `eh-nb` build; the pre-change engines are kept as
`build/{eh-nb,ref-nb}-pre-ips`). Same image, same JIT settings, quiet machine:

| | idle burn at the welcome screen | boot -> prompt | one keystroke |
|---|---|---|---|
| before (`ips=40M`) | 20.0 M instr/s | 6.80 s | 159.7 ms / 40.65 M instr |
| after (`ips=200M`) | **5.3 M instr/s** | **6.59 s** | 160.8 ms / 40.40 M instr |

So the guest clock fix is worth **3.8x less wasted CPU while nothing is happening**, and boot did not
regress (the fear was that guest-time waits, previously compressed 5x, would now cost real time).
It cannot move the keystroke, because a keystroke is 91.7 % user-mode work in codex itself (§2).

Two things it does NOT fix, both measured:

* **The sign-in screen animation is CPU-bound, not clock-bound.** In the browser, idle on that
  screen: 262 M instr / 2 s (before) vs 272 M instr / 2 s (after), ~120 `xterm.write`/s in both.
  codex asks for the next frame as fast as one can be produced, so it consumes whatever CPU exists.
  The welcome screen, whose animation is clock-driven, is where the 3.8x shows up.
* **The browser main thread is not the bottleneck**: `rafMedianGapMs 16.67`, `longTasks 0` while the
  emulator saturates a core. Coalescing `xterm.write` per frame (§5.3) is therefore cosmetic here;
  xterm.js already batches its own rendering.

### Input coalescing: the one lever on our side that moves the keystroke

codex renders **once per batch of input**, not once per byte:

| input shape | instructions | per character |
|---|---|---|
| 10 chars, one at a time (300 ms apart) | 442 M | 44.2 M |
| 20 chars, in two 10-char chunks | 170 M | **8.5 M** |

A 10-character chunk costs about **twice** a single character, not ten times. Consequences:

* a **paste** (the OAuth code flow!) must reach the guest as ONE write. `xterm-pty`'s slave queue
  already does this — do not "fix" it into per-key writes;
* while the guest is mid-render, further keystrokes queue in the host anyway and are delivered
  together at the next rx poll, so fast typing is already cheaper per character than slow typing;
* deliberately delaying a lone keystroke to merge it with the next one only adds latency: there is
  nothing to merge with. This is why the ~160 ms stands for slow, deliberate typing.

## 7. The codex-side bug (worth reporting upstream)

`codex-rs/tui/src/terminal_hyperlinks.rs`, `mark_buffer_hyperlinks()`: the per-column loop calls

```rust
let symbol = link.terminal_destination().map_or_else(...)   // inside `for column in link.columns`
```

and `terminal_destination()` -> `web_destination()` runs `sanitized_destination()` + `Url::parse()`
on the **same string** every time. Measured on the sign-in screen (a 472-character OAuth URL, two
render passes per frame): **946 full `Url::parse` calls per keystroke** — one per character of the
URL per pass — costing **45 %** of the keystroke in `url`+`terminal_hyperlinks`+percent-decode and
another **35 %** in the allocator churn they cause. Ratatui's own layout, paint and diff are under
3 % of the same keystroke.

Hoisting that one call out of the loop (or memoizing `web_destination`) removes ~80 % of the cost of
typing on any screen that shows a long link, on every machine — an emulator just makes it visible.
Two smaller ones next to it: `mark_buffer_hyperlinks` re-lays-out every transcript line each frame
(`Paragraph::line_count` plus a second render into a scratch `Buffer`), and `shimmer_spans()`
allocates a fresh `String` + `Span` per character per frame.
