import type { ReactElement } from "react";
import type { BuildPreviewProperties } from "../../contracts/presenter.ts";
import { initialBuildPreviewState } from "../presenter-reducer.ts";
import { currentBuildOf } from "../presenter-state.ts";
import { PreviewRun } from "./transition-preview.tsx";

export function BuildPreview(properties: BuildPreviewProperties): ReactElement {
  return <PreviewRun key={properties.generation} properties={properties} initialState={initialBuildPreviewState} label="Build preview" buildOf={currentBuildOf} />;
}
