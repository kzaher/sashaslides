// THE OPTIONS bug_solving creates its copy-on-write workspaces with.
//
// cow-workspace now requires its caller to name the backend (`provider`) and the base tree's ignore
// pre-filter (`baseIgnoreFilter`), where it used to default to overlayfs and `git check-ignore`. The
// bundle is built by esbuild, which does not type-check, so callers still passing the old
// `{ base, id, upperRoot }` compiled cleanly and threw "cow-workspace: provider must be 'overlayfs'
// or 'vhdx'" at run time. Measured 2026-10-16: the reverse run's final merge crashed that way right
// after all four clusters were rated good.
//
// bug_solving runs on Linux over this git repository, so: overlayfs, filtered by `git check-ignore`
// (the old default). Jail policy left unset is inherited from the ambient env the scaffolding sets.
import type { CowWorkspaceOptions, OverlayfsCowWorkspaceProviderOptions } from "../../../cow-workspace/cow-workspace.js";

export function overlayWorkspaceOptions(
  options: Readonly<{ base: string; id?: string } & Omit<OverlayfsCowWorkspaceProviderOptions, "type">>,
): CowWorkspaceOptions {
  const { base, id, ...provider } = options;
  return {
    base,
    ...(id === undefined ? {} : { id }),
    provider: { type: "overlayfs", ...provider },
    baseIgnoreFilter: "gitCheckIgnore",
  };
}
