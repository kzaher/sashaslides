// SERIALISABLE VALUES, typed. Transition parameters, clipboard payloads and protocol messages carry
// author-chosen data the engine never interprets; typing it as `SerialisableValue` instead of
// `unknown` keeps it serialisable by construction (it crosses postMessage, the clipboard and the
// shared document), and naming it after what it guarantees avoids the acronym.

export type SerialisablePrimitive = string | number | boolean | null;
export type SerialisableValue = SerialisablePrimitive | readonly SerialisableValue[] | SerialisableObject;
export type SerialisableObject = Readonly<{ [key: string]: SerialisableValue }>;
