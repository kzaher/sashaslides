// MINTING IDS INSIDE ONE REDUCE. Ids come from `EditorState.idSeed` (contracts/ids.ts `mintId`),
// never from a random call, so replaying the event log reproduces every id. A single event can need
// many ids (pasting a group mints one per element), so a reduce step takes a minter over the state's
// seed, mints in a fixed order, and stores the minter's final seed back into the state. The minter
// is a local value created and dropped inside one pure reduce, never shared.

import { mintId, type IdSeed, type MintedIdByKind, type ObjectIdKind } from "../../contracts/index.ts";

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
