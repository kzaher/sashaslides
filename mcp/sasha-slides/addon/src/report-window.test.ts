import assert from "node:assert/strict";
import test from "node:test";
import { createReportWindow, type PopupOpener } from "./report-window.ts";
import type { PickerWindowApi } from "./drive-api.ts";

/**
 * Slides hosts exactly ONE modeless dialog (measured against the deployed add-on, 2026-10-04),
 * so opening the report evicted the Candidate slides window the user was reporting on. These
 * pin the two things that made the replacement work at all.
 */

function apiReturning(url: string | null): PickerWindowApi {
  return {
    openPicker: async () => ({ kind: "ok", value: { opened: true } }),
    openDefectReport: async () => ({ kind: "ok", value: { opened: true } }),
    reportWindowUrl: async () => ({ kind: "ok", value: url }),
  };
}

function recordingOpener(result: unknown): PopupOpener & { calls: () => readonly string[] } {
  const calls: string[] = [];
  return {
    open: (url, target, features) => {
      calls.push(`${url} | ${target} | ${features}`);
      return result;
    },
    calls: () => calls,
  };
}

test("with a web app deployed, the report opens in a window of its own", async () => {
  const opener = recordingOpener({});
  const made = createReportWindow({ api: () => apiReturning("https://script.google.com/macros/s/AKfy/exec"), opener });
  await made.learn();
  assert.equal(made.open(), true);
  assert.match(opener.calls()[0] ?? "", /^https:\/\/script\.google\.com\/macros\/s\/AKfy\/exec \| sasha-defect-report \| popup=yes/);
});

test("with no deployment there is no window, and the caller is told so rather than left guessing", async () => {
  const opener = recordingOpener({});
  const made = createReportWindow({ api: () => apiReturning(null), opener });
  await made.learn();
  assert.equal(made.open(), false);
  assert.deepEqual(opener.calls(), [], "nothing is opened, so nothing is blocked either");
});

/** A popup blocker returns null. That is not a failure to report; it is the dialog's cue. */
test("a blocked popup falls back rather than losing the report", async () => {
  const opener = recordingOpener(null);
  const made = createReportWindow({ api: () => apiReturning("https://script.google.com/macros/s/AKfy/exec"), opener });
  await made.learn();
  assert.equal(made.open(), false);
});

/**
 * THE RULE THAT IS EASY TO BREAK: open() must not await anything, because an await ends the
 * trusted user gesture and the browser blocks the popup. So `learn` is where the asking happens,
 * and open() before it has simply nothing to open.
 */
test("open() before learn() opens nothing instead of asking the server mid-click", () => {
  const opener = recordingOpener({});
  const made = createReportWindow({ api: () => apiReturning("https://script.google.com/macros/s/AKfy/exec"), opener });
  assert.equal(made.open(), false);
  assert.deepEqual(opener.calls(), []);
});
