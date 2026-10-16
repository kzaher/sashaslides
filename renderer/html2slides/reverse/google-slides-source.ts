/**
 * READ-ONLY access to Google Slides for the reverse round trip: the full `presentations.get`
 * answer the Sasha importer consumes, Google's own thumbnail of each slide, and a bearer token for
 * the picture addresses the import fetches.
 *
 * WHY THE DEVELOPER TOKEN AND NOT THE BROKERED GRANT: this is a measuring harness run from the
 * devcontainer, the same position as record-rendering-lib.ts and export-thumbs-lib.ts, which build
 * an OAuth client from .auth/google_oauth.json + .auth/tokens.json. Nothing here writes to a
 * presentation; the only presentation the pipeline creates is the forward upload, done by
 * convert-pptx.ts.
 *
 * The .pptx export (Drive `files.export`, also a read) carries the gradient stops the Slides
 * interface leaves out; the token's Drive scope reaches it.
 *
 * QUOTA. Thumbnails count against "expensive read requests per minute" (measured about 67 per
 * minute before Google answers 429), so requests are spaced at least THUMBNAIL_SPACING_MILLISECONDS
 * apart and a 429 backs off exponentially. A presentation read is a cheap read and is not spaced.
 *
 * An expired refresh token (`invalid_grant`, the OAuth client is in Testing mode, 7 days) is
 * reported with the re-consent command and never retried: re-consenting needs a person.
 */
import { google, type slides_v1 } from "googleapis";
import { readFileSync } from "node:fs";
import { PPTX_MEDIA_TYPE } from "../../../mcp/sasha-slides/google-slides/slides-client.ts";

export type GoogleSlidesSource = Readonly<{
  /** The whole `presentations.get` answer, as untrusted JSON for `parsePresentation`. */
  readPresentation(presentationId: string): Promise<unknown>;
  /** Google's LARGE PNG thumbnail of one page (1600 wide). */
  downloadThumbnail(options: Readonly<{ presentationId: string; pageObjectId: string }>): Promise<Uint8Array>;
  /** A current access token, for picture addresses Google serves only to the grant. */
  accessToken(): Promise<string>;
  /**
   * The presentation as Drive exports it (.pptx, a read): the importer takes gradient stops from it,
   * which `presentations.get` answers as an empty fill (import-pptx-supplement.ts).
   */
  exportPresentationPptx(presentationId: string): Promise<Uint8Array>;
}>;

export type GoogleSlidesSourceDependencies = Readonly<{
  credentialsPath: string;
  tokensPath: string;
  fetch: typeof fetch;
  /** Waits; injected so the pacing is testable and visible. */
  delay: (milliseconds: number) => Promise<void>;
  now: () => number;
  log: (line: string) => void;
}>;

/** Slightly under 67 per minute. */
export const THUMBNAIL_SPACING_MILLISECONDS = 950;
const MAXIMUM_ATTEMPTS = 6;
const FIRST_BACKOFF_MILLISECONDS = 5_000;
const LONGEST_BACKOFF_MILLISECONDS = 60_000;

export function createGoogleSlidesSource(dependencies: GoogleSlidesSourceDependencies): GoogleSlidesSource {
  const client = oauthClientFrom(dependencies);
  const slides = google.slides({ version: "v1", auth: client });
  const drive = google.drive({ version: "v3", auth: client });
  let nextThumbnailAt = 0;

  const withRetries = async <TResult>(what: string, attempt: () => Promise<TResult>): Promise<TResult> => {
    let backoff = FIRST_BACKOFF_MILLISECONDS;
    for (let attemptNumber = 1; ; attemptNumber++) {
      try {
        return await attempt();
      } catch (cause) {
        if (isExpiredGrant(cause)) {
          throw new Error(`Google refused the developer token (invalid_grant: the 7 day refresh token expired). A person must re-run "npx tsx .auth/generate-token.ts"; this pipeline does not re-consent.`);
        }
        const status = statusOf(cause);
        const retryable = status === 429 || (status !== null && status >= 500);
        if (!retryable || attemptNumber >= MAXIMUM_ATTEMPTS) throw new Error(`${what} failed (HTTP ${status ?? "?"}): ${messageOf(cause)}`);
        dependencies.log(`  ${what}: HTTP ${status}, backing off ${Math.round(backoff / 1000)} s (attempt ${attemptNumber} of ${MAXIMUM_ATTEMPTS})`);
        await dependencies.delay(backoff);
        backoff = Math.min(LONGEST_BACKOFF_MILLISECONDS, backoff * 2);
      }
    }
  };

  return {
    readPresentation: async (presentationId) => {
      // No `fields`: the importer reads masters, layouts and every element property, exactly as
      // google-slides-interchange.ts asks for it (`fields: null`).
      const answer = await withRetries(`presentations.get ${presentationId}`, () => slides.presentations.get({ presentationId }));
      return answer.data;
    },
    downloadThumbnail: async ({ presentationId, pageObjectId }) => {
      const thumbnail = await withRetries(`thumbnail ${pageObjectId}`, async (): Promise<slides_v1.Schema$Thumbnail> => {
        const waitFor = nextThumbnailAt - dependencies.now();
        if (waitFor > 0) await dependencies.delay(waitFor);
        nextThumbnailAt = dependencies.now() + THUMBNAIL_SPACING_MILLISECONDS;
        const answer = await slides.presentations.pages.getThumbnail({
          presentationId,
          pageObjectId,
          "thumbnailProperties.mimeType": "PNG",
          "thumbnailProperties.thumbnailSize": "LARGE",
        });
        return answer.data;
      });
      const address = thumbnail.contentUrl;
      if (typeof address !== "string" || address.length === 0) throw new Error(`thumbnail ${pageObjectId}: Google answered without a contentUrl`);
      const response = await dependencies.fetch(address, { signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(`thumbnail ${pageObjectId}: downloading the PNG answered HTTP ${response.status}`);
      return new Uint8Array(await response.arrayBuffer());
    },
    exportPresentationPptx: async (presentationId) => {
      const answer = await withRetries(`files.export ${presentationId}`, () =>
        drive.files.export({ fileId: presentationId, mimeType: PPTX_MEDIA_TYPE }, { responseType: "arraybuffer" }),
      );
      // `responseType: "arraybuffer"` makes gaxios answer the body as an ArrayBuffer; the generated types say `unknown`.
      const body: unknown = answer.data;
      if (!(body instanceof ArrayBuffer)) throw new Error(`files.export ${presentationId}: Drive answered without the file's bytes`);
      return new Uint8Array(body);
    },
    accessToken: async () => {
      const answer = await withRetries("access token", () => client.getAccessToken());
      if (typeof answer.token !== "string") throw new Error("Google issued no access token for the developer grant");
      return answer.token;
    },
  };
}

type InstalledCredentials = Readonly<{ clientId: string; clientSecret: string }>;

function oauthClientFrom(dependencies: GoogleSlidesSourceDependencies): InstanceType<typeof google.auth.OAuth2> {
  const credentials = installedCredentialsOf(JSON.parse(readFileSync(dependencies.credentialsPath, "utf-8")));
  const client = new google.auth.OAuth2(credentials.clientId, credentials.clientSecret, "http://localhost");
  client.setCredentials(tokensOf(JSON.parse(readFileSync(dependencies.tokensPath, "utf-8"))));
  return client;
}

function installedCredentialsOf(raw: unknown): InstalledCredentials {
  const installed = fieldOf(raw, "installed");
  const clientId = fieldOf(installed, "client_id");
  const clientSecret = fieldOf(installed, "client_secret");
  if (typeof clientId !== "string" || typeof clientSecret !== "string") throw new Error("google_oauth.json has no installed.client_id / client_secret");
  return { clientId, clientSecret };
}

function tokensOf(raw: unknown): Readonly<{ refresh_token?: string; access_token?: string; expiry_date?: number }> {
  const refreshToken = fieldOf(raw, "refresh_token");
  const accessToken = fieldOf(raw, "access_token");
  const expiryDate = fieldOf(raw, "expiry_date");
  if (typeof refreshToken !== "string" && typeof accessToken !== "string") throw new Error("tokens.json holds neither a refresh nor an access token");
  return {
    ...(typeof refreshToken === "string" ? { refresh_token: refreshToken } : {}),
    ...(typeof accessToken === "string" ? { access_token: accessToken } : {}),
    ...(typeof expiryDate === "number" ? { expiry_date: expiryDate } : {}),
  };
}

function isExpiredGrant(cause: unknown): boolean {
  return messageOf(cause).includes("invalid_grant") || fieldOf(fieldOf(fieldOf(cause, "response"), "data"), "error") === "invalid_grant";
}

/** The HTTP status of a gaxios error (`status`, or the numeric `code`), else null. */
function statusOf(cause: unknown): number | null {
  const status = fieldOf(cause, "status") ?? fieldOf(fieldOf(cause, "response"), "status") ?? fieldOf(cause, "code");
  if (typeof status === "number") return status;
  if (typeof status === "string" && /^\d{3}$/.test(status)) return Number(status);
  return null;
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function fieldOf(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null || !(key in value)) return undefined;
  // The guard above proved `value` is a non-null object that has `key`; its value stays unknown.
  return (value as Readonly<Record<string, unknown>>)[key];
}

/** What one presentation's earlier online run left on disk (reverse-set.ts writes both files). */
export type PresentationRecording = Readonly<{ answerPath: string; pptxPath: string | null }>;

/**
 * The same source OFFLINE, over an earlier run's recordings: the cached `presentations.get` answer
 * and .pptx export. For when the developer token has expired (`invalid_grant`) and an importer fix
 * still has to be measured; thumbnails are already cached by reverse-set.ts, so asking for one
 * here means the cache is incomplete and fails loudly instead of measuring against nothing.
 */
export function createRecordedGoogleSlidesSource(recordings: ReadonlyMap<string, PresentationRecording>): GoogleSlidesSource {
  const recordingOf = (presentationId: string): PresentationRecording => {
    const recording = recordings.get(presentationId);
    if (recording === undefined) throw new Error(`offline: no recording of presentation ${presentationId}`);
    return recording;
  };
  return {
    readPresentation: async (presentationId) => JSON.parse(readFileSync(recordingOf(presentationId).answerPath, "utf-8")),
    downloadThumbnail: async ({ pageObjectId }) => {
      throw new Error(`offline: the thumbnail of ${pageObjectId} was never cached; run online once`);
    },
    exportPresentationPptx: async (presentationId) => {
      const pptxPath = recordingOf(presentationId).pptxPath;
      if (pptxPath === null) throw new Error(`offline: no .pptx export of ${presentationId} was recorded`);
      return new Uint8Array(readFileSync(pptxPath));
    },
    accessToken: async () => "offline",
  };
}
