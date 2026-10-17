/**
 * The `/comments/allow` page's only script: it opens the Google Picker preset to ONE deck, so
 * the person can grant Sasha `drive.file` access to it with one click (`comment-access-page.ts`
 * explains why a picker, and why only that deck).
 *
 * The server renders everything the picker needs on one `[data-picker]` element: the person's
 * access token (`data-token`), the picker's API key (`data-key`), the OAuth client's project
 * number (`data-app`, which ties the grant to Sasha's app), the deck (`data-deck`) and Google's
 * loader (`data-loader`). The picker opens by itself once Google's loader is ready, so a person
 * sent here from the deck's "Ask Sasha" sidebar (or by their assistant) has the deck already
 * preselected and needs one click. Some browsers refuse to show it without a user gesture; then
 * the "Choose the deck" button is the way in, and it also reopens the picker after a cancel.
 *
 * Not React (the TypeScript skill's default for UI): there is no state to render, only one
 * button and one status line on server-rendered markup. Bundled by `browser-scripts/build.ts` into
 * `../picker-script.generated.ts`, which the page serves at `/comments/allow/picker.js`.
 *
 * Google's `gapi` and `google.picker` globals have no types in this repository, so the few
 * members used are declared below and read through one narrowing function each.
 */

type PickerDocument = Readonly<{ id?: string }>;
type PickerAnswer = Readonly<{ action?: string; docs?: readonly PickerDocument[] }>;

type PickerView = Readonly<{
  setFileIds(fileIds: string): PickerView;
  setMode(mode: string): PickerView;
}>;

type Picker = Readonly<{ setVisible(visible: boolean): void }>;

type PickerBuilder = Readonly<{
  addView(view: PickerView): PickerBuilder;
  setOAuthToken(token: string): PickerBuilder;
  setDeveloperKey(key: string): PickerBuilder;
  setAppId(appId: string): PickerBuilder;
  setTitle(title: string): PickerBuilder;
  setCallback(callback: (answer: PickerAnswer) => void): PickerBuilder;
  build(): Picker;
}>;

type PickerNamespace = Readonly<{
  DocsView: new (viewId: string) => PickerView;
  PickerBuilder: new () => PickerBuilder;
  ViewId: Readonly<{ PRESENTATIONS: string }>;
  DocsViewMode: Readonly<{ LIST: string }>;
  Action: Readonly<{ PICKED: string; CANCEL: string }>;
}>;

type GoogleApiLoader = Readonly<{
  load(name: string, options: Readonly<{ callback: () => void; onerror: () => void }>): void;
}>;

type Settings = Readonly<{ token: string; key: string; app: string; deck: string; loader: string }>;

const container = document.querySelector<HTMLElement>("[data-picker]");
if (container !== null) start(container);

function start(root: HTMLElement): void {
  const button = root.querySelector<HTMLButtonElement>("button[data-open]");
  const status = root.querySelector<HTMLElement>("[data-status]");
  const settings = readSettings(root);
  if (button === null || status === null) return;
  if (settings === null) {
    say({ status, text: "This page is missing what Google's picker needs. Open the link from your assistant again." });
    return;
  }
  const script = document.createElement("script");
  script.src = settings.loader;
  script.async = true;
  script.addEventListener("error", () => say({ status, text: "Google's file picker did not load. Check your connection and reload the page." }));
  script.addEventListener("load", () => {
    const loader = googleApiLoader();
    if (loader === null) {
      say({ status, text: "Google's file picker did not load. Reload the page." });
      return;
    }
    loader.load("picker", {
      callback: () => {
        button.disabled = false;
        button.addEventListener("click", () => openPicker({ settings, status }));
        try {
          openPicker({ settings, status });
        } catch {
          say({ status, text: "Press \u201cChoose the deck\u201d to open Google\u2019s file picker." });
        }
      },
      onerror: () => say({ status, text: "Google's file picker did not load. Reload the page." }),
    });
  });
  document.head.appendChild(script);
}

function openPicker(options: Readonly<{ settings: Settings; status: HTMLElement }>): void {
  const { settings, status } = options;
  const picker = pickerNamespace();
  if (picker === null) {
    say({ status, text: "Google's file picker did not load. Reload the page." });
    return;
  }
  const view = new picker.DocsView(picker.ViewId.PRESENTATIONS).setFileIds(settings.deck).setMode(picker.DocsViewMode.LIST);
  new picker.PickerBuilder()
    .addView(view)
    .setOAuthToken(settings.token)
    .setDeveloperKey(settings.key)
    .setAppId(settings.app)
    .setTitle("Choose the deck Sasha may comment on")
    .setCallback((answer) => {
      if (answer.action === picker.Action.PICKED) {
        const chosen = (answer.docs ?? []).some((document) => document.id === settings.deck);
        say({
          status,
          text: chosen
            ? "Done. Go back to your deck: Sasha can read and answer its comments now. If your assistant sent you this link, tell it it is done."
            : "That was a different file. Press the button and choose the deck from the link.",
          done: chosen,
        });
        return;
      }
      if (answer.action === picker.Action.CANCEL) say({ status, text: "Nothing was chosen. Press the button to try again." });
    })
    .build()
    .setVisible(true);
  say({ status, text: "Choose the deck in Google's window, then press Select." });
}

function say(options: Readonly<{ status: HTMLElement; text: string; done?: boolean }>): void {
  options.status.textContent = options.text;
  options.status.classList.toggle("done", options.done === true);
  options.status.classList.toggle("muted", options.done !== true);
}

function readSettings(root: HTMLElement): Settings | null {
  const { token, key, app, deck, loader } = root.dataset;
  if (token === undefined || key === undefined || app === undefined || deck === undefined || loader === undefined) return null;
  return { token, key, app, deck, loader };
}

/** `window.gapi`, once Google's loader script ran; null before (or if it is not what we expect). */
function googleApiLoader(): GoogleApiLoader | null {
  const candidate: unknown = Reflect.get(window, "gapi");
  if (typeof candidate !== "object" || candidate === null || typeof Reflect.get(candidate, "load") !== "function") return null;
  // The guard above checked the one member used; its shape is Google's documented gapi.load.
  return candidate as GoogleApiLoader;
}

/** `window.google.picker`, once `gapi.load("picker")` finished; null before. */
function pickerNamespace(): PickerNamespace | null {
  const google: unknown = Reflect.get(window, "google");
  if (typeof google !== "object" || google === null) return null;
  const picker: unknown = Reflect.get(google, "picker");
  if (typeof picker !== "object" || picker === null || typeof Reflect.get(picker, "PickerBuilder") !== "function") return null;
  // The guard above checked the builder; the rest is Google's documented google.picker namespace.
  return picker as PickerNamespace;
}
