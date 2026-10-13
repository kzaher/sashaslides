/**
 * The sign-in providers' own marks, inlined as SVG because the account portal's CSP allows no
 * images. Each follows its owner's sign-in button guidance: Google's four-colour "G" (Google
 * Identity branding guidelines), GitHub's Invertocat mark, and Apple's logo, the last two
 * drawn in the button's text colour.
 *
 * Apple's Human Interface Guidelines for Sign in with Apple also fix the button itself: black
 * with a white logo and title on a light page, white with a black logo on a dark one, never
 * another colour. `providerButtonClass` gives that button its own class for the portal's
 * stylesheet; the title, "Continue with Apple", is one of the titles Apple allows.
 *
 * A provider configured from a file (any other OpenID Connect issuer) gets no mark: we do not
 * guess at someone else's logo.
 */

const GOOGLE =
  `<svg class="mark" aria-hidden="true" focusable="false" viewBox="0 0 48 48">` +
  `<path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>` +
  `<path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>` +
  `<path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>` +
  `<path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>` +
  `</svg>`;

const GITHUB =
  `<svg class="mark" data-mark="github" aria-hidden="true" focusable="false" viewBox="0 0 16 16">` +
  `<path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/>` +
  `</svg>`;

const APPLE =
  `<svg class="mark" data-mark="apple" aria-hidden="true" focusable="false" viewBox="0 0 24 24">` +
  `<path fill="currentColor" d="M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701"/>` +
  `</svg>`;

const MARKS: ReadonlyMap<string, string> = new Map([
  ["google", GOOGLE],
  ["github", GITHUB],
  ["apple", APPLE],
]);

/** Providers whose guidelines dictate the button's own colours, by the class that styles it. */
const BUTTON_CLASSES: ReadonlyMap<string, string> = new Map([["apple", "button-apple"]]);

/** The provider's mark for its sign-in button, or "" for a provider without a known mark. */
export function providerMark(providerName: string): string {
  return MARKS.get(providerName) ?? "";
}

/** The extra class for the provider's sign-in button, or null when the portal's own style applies. */
export function providerButtonClass(providerName: string): string | null {
  return BUTTON_CLASSES.get(providerName) ?? null;
}
