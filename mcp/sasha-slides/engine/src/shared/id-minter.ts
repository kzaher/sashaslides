// MINTING IDS IN A FIXED ORDER. Ids come from an `IdSeed` (contracts/ids.ts `mintId`), never from a
// random call, so replaying an event log or re-running a fixture reproduces every id. A minter is a
// local value over one seed: each `next` mints the next id of a kind and advances the seed, and
// `seed` reads the final seed so a caller can store it back (the editor's reduce step does, into
// `EditorState.idSeed`). Used by the editor's reduce steps, the blank deck seeding and the fixtures
// of the model, state and view tests. DOM-free so the model and deck tools can import it.

import { mintId, type IdSeed, type MintedIdByKind, type ObjectIdKind } from "../contracts/ids.ts";

export type IdMinter = Readonly<{
  next: <TKind extends ObjectIdKind>(kind: TKind) => MintedIdByKind[TKind];
  seed: () => IdSeed;
}>;

export function createIdMinter(seed: IdSeed): IdMinter {
  let current = seed;
  return {
    next: <TKind extends ObjectIdKind>(kind: TKind): MintedIdByKind[TKind] => {
      const minted = mintId({ seed: current, kind });
      current = minted.seed;
      return minted.id;
    },
    seed: () => current,
  };
}

/** A minter that starts at counter zero under a fixed session prefix, so a fixture's ids are the same on every run. */
export function createPrefixedIdMinter(sessionPrefix: string): IdMinter {
  return createIdMinter({ sessionPrefix, counter: 0 });
}
