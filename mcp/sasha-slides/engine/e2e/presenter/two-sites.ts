// THE TWO SITES the presenter needs in a browser: the editor (here, the scenario page) on
// 127.0.0.1 and the runner on localhost -- different sites, so Chrome's site isolation runs the
// sandboxed runner in another process (transition-protocol.ts header). Both are static servers
// over a built directory; the runner's responses carry its content security policy as a header,
// as production will. Ports are chosen by the system and released when the scope ends.

import { serveDirectory } from "../../serve-directory.ts";

export type TwoSites = AsyncDisposable &
  Readonly<{
    editorAddress: string;
    runnerAddress: string;
  }>;

export async function serveTwoSites(
  options: Readonly<{ editorDirectory: string; runnerDirectory: string; runnerContentSecurityPolicy: string }>,
): Promise<TwoSites> {
  const editor = await serveDirectory({ directory: options.editorDirectory, host: "127.0.0.1" });
  const runner = await serveDirectory({ directory: options.runnerDirectory, host: "::", headers: () => ({ "content-security-policy": options.runnerContentSecurityPolicy }) });
  return {
    editorAddress: `http://127.0.0.1:${editor.port}`,
    runnerAddress: `http://localhost:${runner.port}`,
    async [Symbol.asyncDispose]() {
      await Promise.all([editor[Symbol.asyncDispose](), runner[Symbol.asyncDispose]()]);
    },
  };
}
