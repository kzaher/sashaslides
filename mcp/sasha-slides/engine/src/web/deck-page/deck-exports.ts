// FILE > EXPORT TO GOOGLE SLIDES, from the deck page (SPEC.md 21.12, 21.13): the server writes the
// presentation with the person's own Google grant, or -- inside the add-on, when the server has no
// grant -- answers `runInAddon`, and the add-on's shell runs the export with its own authorization.
// Either way the person learns how it went from a notice on the page.

import { assertNever } from "../../contracts/assert-never.ts";
import type { GoogleSlidesExportRequest, GoogleSlidesExportReport } from "../../contracts/deck-api.ts";
import { problemOf, type DeckClient } from "../api/deck-api-client.ts";
import type { ShellRelay } from "../embedded/shell-relay.ts";

export type PageNotice = Readonly<{
  tone: "information" | "warning" | "error";
  message: string;
  link: Readonly<{ label: string; address: string }> | null;
}>;

export type ExportRunner = Readonly<{ exportTo: (target: GoogleSlidesExportRequest["target"]) => Promise<void> }>;

export function createExportRunner(options: Readonly<{ deck: DeckClient; shell: ShellRelay | null; notify: (notice: PageNotice) => void }>): ExportRunner {
  return {
    exportTo: async (target) => {
      options.notify({ tone: "information", message: "Exporting to Google Slides...", link: null });
      const result = await options.deck.exportToGoogleSlides({ target });
      switch (result.kind) {
        case "ok":
          await afterAnswer({ ...options, answer: result.body });
          return;
        case "failed":
          options.notify({
            tone: "error",
            message: result.error.message,
            link: result.error.connectAddress === null ? null : { label: "Connect Google Slides", address: result.error.connectAddress },
          });
          return;
        case "unreachable":
          options.notify({ tone: "error", message: problemOf(result) ?? "The export failed.", link: null });
          return;
        default:
          assertNever(result);
      }
    },
  };
}

async function afterAnswer(options: Readonly<{
  shell: ShellRelay | null;
  notify: (notice: PageNotice) => void;
  answer: Readonly<{ kind: "exported"; report: GoogleSlidesExportReport }> | Readonly<{ kind: "runInAddon"; exportId: string }>;
}>): Promise<void> {
  const answer = options.answer;
  switch (answer.kind) {
    case "exported":
      options.notify(exportedNotice(answer.report));
      return;
    case "runInAddon": {
      if (options.shell === null) {
        options.notify({ tone: "error", message: "This export has to run from the Google Slides add-on. Open the deck from the add-on's menu and export there.", link: null });
        return;
      }
      try {
        const finished = await options.shell.runExport(answer.exportId);
        options.notify(addonExportNotice(finished));
      } catch {
        options.notify({ tone: "error", message: "The add-on did not finish the export. Try again from File > Export.", link: null });
      }
      return;
    }
    default:
      assertNever(answer);
  }
}

function addonExportNotice(finished: Readonly<{ outcome: "applied" | "failed"; message: string }>): PageNotice {
  switch (finished.outcome) {
    case "applied":
      return { tone: "information", message: "Exported to this presentation.", link: null };
    case "failed":
      return { tone: "error", message: `The export failed: ${finished.message}`, link: null };
    default:
      return assertNever(finished.outcome);
  }
}

function exportedNotice(report: GoogleSlidesExportReport): PageNotice {
  const losses = report.losses.length === 0 ? "" : ` ${report.losses.length} ${report.losses.length === 1 ? "thing" : "things"} Google Slides cannot show were simplified.`;
  return {
    tone: "information",
    message: `Exported ${report.slideCount} ${report.slideCount === 1 ? "slide" : "slides"} to Google Slides.${losses}`,
    link: { label: "Open in Google Slides", address: report.presentationAddress },
  };
}
