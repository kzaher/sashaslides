// ONE CANDIDATE DOCUMENT BEING FETCHED, as every state tree holds it: the slides window's frames,
// Ask Sasha's revised slides and its thumbnails all have the same four answers, so it is one union.

export type HtmlLoad =
  | Readonly<{ kind: "unrequested" }>
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "loaded"; html: string }>
  | Readonly<{ kind: "failed"; message: string }>;
