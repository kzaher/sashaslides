/**
 * Google's OAuth endpoints and the scopes the connector asks for, defined once.
 *
 * Dependency-free on purpose: the OAuth metadata, the comment bot, the deck accounts and the
 * Slides interchange need these strings without `google-auth.ts`'s googleapis client.
 */

export const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
export const GOOGLE_CONSENT_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";

export const SLIDES_SCOPE = "https://www.googleapis.com/auth/presentations";
/** Per file, granted by choosing the file in the Google Picker or creating it. Non-sensitive. */
export const DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file";
/** Restricted; never requested, but a grant that already holds it can do what `drive.file` does. */
export const FULL_DRIVE_SCOPE = "https://www.googleapis.com/auth/drive";

/**
 * Either scope lets the server create and read its own staging files. `drive.file` is
 * non-sensitive and is what a published connector should ask for; full `drive` is a
 * restricted scope needing app verification plus a security assessment when a server
 * transmits the data. We accept whichever the user granted.
 */
export const DRIVE_SCOPES = [FULL_DRIVE_SCOPE, DRIVE_FILE_SCOPE] as const;
