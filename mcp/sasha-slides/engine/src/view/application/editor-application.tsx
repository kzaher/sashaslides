// THE MODULE'S `EditorApplication` (contracts/editor-system.ts `EditorApplicationProperties`): the
// editor shell with the real services. The state module's pure selectors (`clipboardContentFor`,
// `arrangeThreads`) arrive in the properties from the composition root; the presenter's components
// are imported here, at the one place the view composes another module. All of them are handed to
// the shell as services -- the components never import them, so the chrome harness and the tests
// can run the same shell on fakes.

import { useMemo, type ReactElement } from "react";
import type { EditorApplicationProperties } from "../../contracts/editor-system.ts";
import { BuildPreview, Presentation, TransitionPreview } from "../../presenter/index.ts";
import { primaryModifierOf, readImageFile, richTextFromMarkup } from "./browser-services.ts";
import type { EditorServices } from "./editor-services.tsx";
import { EditorShell } from "./editor-shell.tsx";

export function EditorApplication(properties: EditorApplicationProperties): ReactElement {
  const services = useMemo<EditorServices>(
    () => ({
      system: properties.system,
      browser: properties.browser,
      assetStore: properties.assetStore,
      assetAddress: (assetId) => properties.assetStore.addressFor(assetId),
      presenterDependencies: properties.presenterDependencies,
      clipboardContentFor: properties.clipboardContentFor,
      arrangeThreads: properties.arrangeThreads,
      Presentation,
      TransitionPreview,
      BuildPreview,
      primaryModifier: typeof window === "undefined" ? "control" : primaryModifierOf(window),
      richTextFrom: richTextFromMarkup,
      readImageFile,
      measurePointerMoves: false,
      host: properties.host,
      now: properties.presenterDependencies.now,
    }),
    [properties.system, properties.browser, properties.assetStore, properties.presenterDependencies, properties.clipboardContentFor, properties.arrangeThreads, properties.host],
  );
  return <EditorShell services={services} />;
}
