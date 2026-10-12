// ARCHIVING A CANDIDATE: the derivation from the session log, and the optimistic overlay on top of it.
//
// The archive is a pair of events in the proposal's own log (`slide-archived` / `slide-restored`),
// so it survives the sidebar closing and Sasha can read it. Everything here is pure; the order
// follows candidate-archive.ts.

import assert from "node:assert/strict";
import test from "node:test";
import {
  archiveEventBodyOf,
  archivedSlidesOf,
  pendingAfterLog,
  splitCandidates,
  type PendingArchive,
} from "./candidate-archive.ts";
import { sessionEventsOf, type SessionEvent } from "./session-log.ts";

const PROPOSAL = "p_1791115140000_a1b2c3";
const BASE_MS = 1791115140000;

// --- the log is the record ------------------------------------------------------

test("an archived slide is derived from the log, with the time it was archived", () => {
  const events = log([archived({ slideIndex: 2, minute: 1 })]);
  assert.deepEqual(archivedSlidesOf({ events, pending: [] }), [
    { slideIndex: 2, archivedAtMillis: BASE_MS + 60_000 },
  ]);
});

// Parametric over the LAST event per slide: the same two events in the other order flip the answer.
for (const row of [
  { name: "archived then restored is working again", order: ["archive", "restore"], archived: [] },
  { name: "restored then archived is archived", order: ["restore", "archive"], archived: [3] },
  { name: "archived twice keeps the NEWER time", order: ["archive", "archive"], archived: [3] },
] as const) {
  test(`the latest event per slide wins: ${row.name}`, () => {
    const events = log(
      row.order.map((step, minute) =>
        step === "archive" ? archived({ slideIndex: 3, minute: minute + 1 }) : restored({ slideIndex: 3, minute: minute + 1 }),
      ),
    );
    const derived = archivedSlidesOf({ events, pending: [] });
    assert.deepEqual(
      derived.map((slide) => slide.slideIndex),
      row.archived,
    );
    if (row.archived.length > 0) assert.equal(derived[0]?.archivedAtMillis, BASE_MS + 2 * 60_000);
  });
}

test("one slide's events never touch another slide", () => {
  const events = log([archived({ slideIndex: 1, minute: 1 }), restored({ slideIndex: 2, minute: 2 })]);
  assert.deepEqual(
    archivedSlidesOf({ events, pending: [] }).map((slide) => slide.slideIndex),
    [1],
  );
});

test("the archived list is ordered most recently archived FIRST", () => {
  const events = log([
    archived({ slideIndex: 1, minute: 1 }),
    archived({ slideIndex: 4, minute: 3 }),
    archived({ slideIndex: 2, minute: 2 }),
  ]);
  assert.deepEqual(
    archivedSlidesOf({ events, pending: [] }).map((slide) => slide.slideIndex),
    [4, 2, 1],
  );
});

test("an unknown kind and the other kinds do not archive anything", () => {
  const events = log([
    { name: `${BASE_MS}-aaaaaa-slide-teleported.json`, body: { kind: "slide-teleported", slideIndex: 1 } },
    { name: `${BASE_MS + 1}-aaaaab-slide-inserted.json`, body: { kind: "slide-inserted", slideIndex: 1 } },
  ]);
  assert.deepEqual(archivedSlidesOf({ events, pending: [] }), []);
});

// --- the optimistic overlay -----------------------------------------------------

test("a pending archive takes effect before its event is in the log", () => {
  const pending: readonly PendingArchive[] = [pendingOf({ slideIndex: 2, archived: true, minute: 5, fileId: null })];
  assert.deepEqual(archivedSlidesOf({ events: [], pending }), [
    { slideIndex: 2, archivedAtMillis: BASE_MS + 5 * 60_000 },
  ]);
});

test("a pending restore overrides an archive the log already holds", () => {
  const events = log([archived({ slideIndex: 2, minute: 1 })]);
  const pending = [pendingOf({ slideIndex: 2, archived: false, minute: 5, fileId: null })];
  assert.deepEqual(archivedSlidesOf({ events, pending }), []);
});

// Parametric over whether the log has caught up with the write.
for (const row of [
  { name: "a written entry whose file is in the log is dropped", fileId: "drive_written", inLog: true, kept: 0 },
  { name: "a written entry the log has not caught up with stays", fileId: "drive_written", inLog: false, kept: 1 },
  { name: "an entry still being written always stays", fileId: null, inLog: true, kept: 1 },
] as const) {
  test(`pendingAfterLog: ${row.name}`, () => {
    const pending = [pendingOf({ slideIndex: 2, archived: true, minute: 5, fileId: row.fileId })];
    const events = row.inLog
      ? log([archived({ slideIndex: 2, minute: 5 })], { fileIdOf: () => "drive_written" })
      : log([archived({ slideIndex: 1, minute: 1 })]);
    assert.equal(pendingAfterLog({ pending, events }).length, row.kept);
  });
}

// --- the two lists --------------------------------------------------------------

test("splitCandidates keeps the manifest order for Working and archive order for Archived", () => {
  const slides = [1, 2, 3, 4].map((slideIndex) => ({ slideIndex }));
  const lists = splitCandidates({
    slides,
    archived: [
      { slideIndex: 3, archivedAtMillis: 20 },
      { slideIndex: 1, archivedAtMillis: 10 },
      // Not in the manifest any more: never invents a row.
      { slideIndex: 9, archivedAtMillis: 30 },
    ],
  });
  assert.deepEqual(
    lists.working.map((slide) => slide.slideIndex),
    [2, 4],
  );
  assert.deepEqual(
    lists.archived.map((entry) => [entry.slide.slideIndex, entry.archivedAtMillis]),
    [
      [3, 20],
      [1, 10],
    ],
  );
});

test("the body to write is the matching kind, carrying the slide index", () => {
  assert.deepEqual(archiveEventBodyOf({ slideIndex: 2, archived: true }), { kind: "slide-archived", slideIndex: 2 });
  assert.deepEqual(archiveEventBodyOf({ slideIndex: 2, archived: false }), { kind: "slide-restored", slideIndex: 2 });
});

// --- helpers --------------------------------------------------------------------

type LogLine = Readonly<{ name: string; body: Readonly<Record<string, unknown>> }>;

function archived({ slideIndex, minute }: { slideIndex: number; minute: number }): LogLine {
  return line({ kind: "slide-archived", slideIndex, minute });
}

function restored({ slideIndex, minute }: { slideIndex: number; minute: number }): LogLine {
  return line({ kind: "slide-restored", slideIndex, minute });
}

function line({ kind, slideIndex, minute }: { kind: string; slideIndex: number; minute: number }): LogLine {
  const suffix = `a${String(minute).padStart(5, "0")}`;
  return { name: `${BASE_MS + minute * 60_000}-${suffix}-${kind}.json`, body: { kind, slideIndex } };
}

function log(
  lines: readonly LogLine[],
  options: Readonly<{ fileIdOf: (name: string) => string }> = { fileIdOf: (name) => `drive_${name}` },
): readonly SessionEvent[] {
  return sessionEventsOf({
    files: lines.map((entry) => ({
      proposalId: PROPOSAL,
      fileId: options.fileIdOf(entry.name),
      name: entry.name,
      text: JSON.stringify({ protocolVersion: 1, at: "2026-10-04T12:00:00.000Z", ...entry.body }),
    })),
  });
}

function pendingOf({
  slideIndex,
  archived: isArchived,
  minute,
  fileId,
}: {
  slideIndex: number;
  archived: boolean;
  minute: number;
  fileId: string | null;
}): PendingArchive {
  return { proposalId: PROPOSAL, slideIndex, archived: isArchived, atMillis: BASE_MS + minute * 60_000, fileId };
}
