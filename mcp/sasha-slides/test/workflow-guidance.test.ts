/**
 * The guidance that ships with the connector, asserted over real MCP connections.
 *
 *   cd mcp/sasha-slides && npx tsx --test test/workflow-guidance.test.ts
 *
 * Three kinds of assertion, and the distinctions matter:
 *
 *  - **Delivery.** `instructions` and the `prompts` capability must actually appear in the
 *    `initialize` result and answer `prompts/list` / `prompts/get`. Asserted through a real
 *    `Client`, so the SDK's own negotiation is what is measured rather than a field on an
 *    options object.
 *  - **No drift.** The instructions are `.claude/skills/sasha-slides/SKILL.md` minus its
 *    frontmatter, and nothing else. Asserted both as an exact equality against the file and
 *    as the presence of distinctive lines from it, so a future "small edit" in TypeScript
 *    fails here.
 *  - **Degradation.** A deployment whose skill markdown is missing must still start and still
 *    serve usable rules. Asserted against a real `server.ts --stdio` subprocess pointed at a
 *    path that does not exist, because that is the case the whole feature exists for.
 *
 * What it cannot assert is whether a *particular* client puts the instructions in its system
 * prompt - that is a property of the client, and it is measured against the real one in
 * `e2e/connector-guidance-probe.ts`.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { after, before, describe, test } from "node:test";
import { createSashaSlidesServer } from "../server";
import {
  CLAUDE_CODE_INSTRUCTIONS_BUDGET,
  FALLBACK_WORKFLOW_INSTRUCTIONS,
  fitInstructions,
  loadWorkflowInstructions,
  SECTION_PRIORITY,
  skillPathCandidates,
  SKILL_RELATIVE_PATH,
  splitSkillSections,
  stripSkillFrontmatter,
} from "../workflow-instructions";
import {
  newDeckPrompt,
  reviseFromFeedbackPrompt,
  secondWavePrompt,
  WORKFLOW_PROMPT_NAMES,
} from "../workflow-prompts";

/** `mcp/sasha-slides/test` → the repository root. */
const REPO_ROOT = resolve(__dirname, "..", "..", "..");

describe("the instructions are the skill file, and cannot drift from it", () => {
  test("stripSkillFrontmatter removes the YAML block and nothing else", () => {
    const body = stripSkillFrontmatter(skillMarkdown());
    assert.ok(!body.startsWith("---"), "the frontmatter fence is gone");
    assert.ok(!body.includes("user_invocable"), "the skill metadata is gone");
    assert.ok(body.startsWith("# sasha-slides"), "the document starts at its own heading");
    // Everything after the frontmatter survives verbatim, down to the last line. The expected
    // last line is read from the file rather than hard-coded: this is a test of
    // `stripSkillFrontmatter`, and editing the skill's prose must not fail it. Drift is
    // guarded by the verbatim-rules, every-tool-named and byte-equality tests below.
    const lastLineOfFile = skillMarkdown().trimEnd().split("\n").at(-1) ?? "";
    assert.ok(body.endsWith(lastLineOfFile), `body should end with: ${lastLineOfFile}`);
  });

  test("markdown with no frontmatter is passed through untouched", () => {
    assert.equal(stripSkillFrontmatter("# Heading\n\nbody\n"), "# Heading\n\nbody");
  });

  test("with no budget, what the server loads is byte-for-byte the skill body", () => {
    const loaded = loadWorkflowInstructions({
      skillPaths: [join(REPO_ROOT, SKILL_RELATIVE_PATH)],
      readTextFile: (path) => readFileSync(path, "utf8"),
      budget: 0,
    });
    assert.equal(loaded.source, "skill-file");
    assert.equal(loaded.text, stripSkillFrontmatter(skillMarkdown()));
    assert.deepEqual(loaded.omittedHeadings, []);
  });

  test("every section of the skill is explicitly ranked, so a new one cannot fall off silently", () => {
    for (const section of splitSkillSections(stripSkillFrontmatter(skillMarkdown()))) {
      assert.ok(
        SECTION_PRIORITY.some((prefix) => section.heading.startsWith(prefix)),
        `${section.heading} is not in SECTION_PRIORITY - rank it before adding it to the skill`,
      );
    }
  });

  test("the distinctive rules of the skill reach the client verbatim", async () => {
    const served = await servedInstructions();
    // One line per surviving section of the skill. If a section is re-authored in TypeScript,
    // or the server starts serving a summary, these stop matching.
    for (const line of [
      "Slide HTML travels by FILE PATH and is never read into context",
      "Four candidates must cost the same context as one",
      "Four is a good default; one is not a choice and six",
      "Candidate 1 is the first path you passed",
      "Never stage a second proposal while the first is unanswered",
    ]) {
      assert.ok(served.includes(line), `served instructions contain: ${line}`);
    }
  });

  test("the two-wave framing is never contradicted: one proposal outstanding at a time", async () => {
    const served = await servedInstructions();
    assert.ok(
      served.includes("Never stage a second proposal while the first is unanswered"),
      "the skill's rule survives the budget, because it is ranked above the sections that do not",
    );
    assert.ok(
      !/stage (?:them|a second proposal) (?:alongside|while)/i.test(served) ||
        served.includes("Never stage a second proposal while the first is unanswered"),
      "nothing served tells the agent to stage two proposals at once",
    );
  });

  test("it fits the budget the client actually keeps, and says it was abridged", async () => {
    const served = await servedInstructions();
    assert.ok(
      served.length <= CLAUDE_CODE_INSTRUCTIONS_BUDGET,
      `instructions are ${String(served.length)} characters, budget is ${String(CLAUDE_CODE_INSTRUCTIONS_BUDGET)}`,
    );
    // Measured in e2e/connector-guidance-probe.ts: Claude Code 2.1.285 cuts at exactly 2048
    // and appends its own truncation marker, so an unmarked abridgement would leave the model
    // believing it had the whole guide.
    assert.match(served, /Abridged to this client's 2048-char limit; \d+ later section\(s\)/);
  });
});

describe("fitting the skill into the client's budget", () => {
  const body = () => stripSkillFrontmatter(skillMarkdown());

  test("a budget of 0 means no limit and no notice", () => {
    const fitted = fitInstructions({ body: body(), budget: 0 });
    assert.equal(fitted.text, body());
    assert.deepEqual(fitted.omittedHeadings, []);
  });

  test("sections are dropped whole, lowest priority first, never cut mid-sentence", () => {
    const fitted = fitInstructions({ body: body(), budget: CLAUDE_CODE_INSTRUCTIONS_BUDGET });
    const keptHeadings = splitSkillSections(fitted.text).map((section) => section.heading);
    // The repo-local sections, which a connector-only user cannot act on, go first.
    assert.ok(fitted.omittedHeadings.some((heading) => heading.startsWith("## Harness")));
    assert.ok(fitted.omittedHeadings.some((heading) => heading.startsWith("## Connecting the connector")));
    // The invariants stay. "## Never" used to be here; its prohibitions were folded into the
    // steps they govern so they apply at the point of use and stop competing for the budget,
    // and the sibling test still pins each one verbatim. "## The loop" takes its place,
    // because the procedure is the thing a connector-only client cannot work out for itself.
    for (const prefix of ["# sasha-slides", "## The one rule that matters", "## Slides are 1-based", "## The loop"]) {
      assert.ok(keptHeadings.some((heading) => heading.startsWith(prefix)), `${prefix} survives`);
    }
    // Everything above the abridgement notice is the skill's own bytes, section by section.
    const withoutNotice = fitted.text.slice(0, fitted.text.lastIndexOf("\n\n(Abridged"));
    for (const section of splitSkillSections(withoutNotice)) {
      assert.ok(body().includes(section.text), `${section.heading} is served verbatim, not summarised`);
    }
  });

  test("a generous budget keeps everything and still adds no notice", () => {
    const fitted = fitInstructions({ body: body(), budget: 100_000 });
    assert.equal(fitted.text, body());
    assert.deepEqual(fitted.omittedHeadings, []);
  });

  test("a budget too small for even one section degrades to the fallback rather than to nonsense", () => {
    const fitted = fitInstructions({ body: body(), budget: 80 });
    assert.ok(fitted.text.length <= 80);
    assert.ok(FALLBACK_WORKFLOW_INSTRUCTIONS.startsWith(fitted.text));
    assert.equal(fitted.omittedHeadings.length, splitSkillSections(body()).length);
  });

  test("splitSkillSections keys the leading block by the document title", () => {
    const sections = splitSkillSections("# Title\n\nintro\n\n## One\n\na\n\n## Two\n\nb");
    assert.deepEqual(sections.map((section) => section.heading), ["# Title", "## One", "## Two"]);
  });
});

describe("a missing skill file degrades instead of breaking", () => {
  test("loadWorkflowInstructions falls back when no candidate path can be read", () => {
    const tried: string[] = [];
    const loaded = loadWorkflowInstructions({
      skillPaths: ["/nowhere/a/SKILL.md", "/nowhere/b/SKILL.md"],
      readTextFile: (path) => {
        tried.push(path);
        throw new Error("ENOENT");
      },
      budget: CLAUDE_CODE_INSTRUCTIONS_BUDGET,
    });
    assert.deepEqual(tried, ["/nowhere/a/SKILL.md", "/nowhere/b/SKILL.md"]);
    assert.equal(loaded.source, "fallback");
    assert.equal(loaded.text, FALLBACK_WORKFLOW_INSTRUCTIONS);
    assert.ok(loaded.detail.includes("/nowhere/a/SKILL.md"), "the banner names every path tried");
  });

  test("a file holding only frontmatter is treated as unreadable, not as empty instructions", () => {
    const loaded = loadWorkflowInstructions({
      skillPaths: ["/only/frontmatter/SKILL.md"],
      readTextFile: () => "---\nname: sasha-slides\n---\n",
      budget: CLAUDE_CODE_INSTRUCTIONS_BUDGET,
    });
    assert.equal(loaded.source, "fallback");
  });

  test("the fallback still carries the rules whose violation costs the user money", () => {
    const text = FALLBACK_WORKFLOW_INSTRUCTIONS.toLowerCase();
    for (const rule of ["file path", "never read into context", "1-based", "await_pick", "one proposal"]) {
      assert.ok(text.includes(rule.toLowerCase()), `the fallback states: ${rule}`);
    }
  });

  test("the candidate paths are the server's own checkout first, then the working directory", () => {
    assert.deepEqual(
      skillPathCandidates({ moduleDir: "/srv/app/mcp/sasha-slides", cwd: "/var/run/here", override: null }),
      [join("/srv/app", SKILL_RELATIVE_PATH), join("/var/run/here", SKILL_RELATIVE_PATH)],
    );
  });

  test("an override replaces the search rather than extending it, and is resolved against cwd", () => {
    assert.deepEqual(
      skillPathCandidates({ moduleDir: "/srv/app/mcp/sasha-slides", cwd: "/var/run/here", override: "guide.md" }),
      ["/var/run/here/guide.md"],
    );
  });
});

describe("a real server.ts --stdio subprocess", () => {
  test("hands a connecting client the skill body, fitted to the default budget", async () => {
    const connected = await connectToSubprocess({ skillFile: null, budget: null });
    try {
      assert.equal(
        connected.client.getInstructions(),
        fitInstructions({ body: stripSkillFrontmatter(skillMarkdown()), budget: CLAUDE_CODE_INSTRUCTIONS_BUDGET }).text,
      );
    } finally {
      await connected.close();
    }
  });

  test("--instructions-budget 0 serves the whole skill, for a client with no limit", async () => {
    const connected = await connectToSubprocess({ skillFile: null, budget: 0 });
    try {
      assert.equal(connected.client.getInstructions(), stripSkillFrontmatter(skillMarkdown()));
    } finally {
      await connected.close();
    }
  });

  test("starts, serves tools, and returns the fallback when the skill file is absent", async () => {
    const connected = await connectToSubprocess({ skillFile: "/nonexistent/SKILL.md", budget: null });
    try {
      assert.equal(connected.client.getInstructions(), FALLBACK_WORKFLOW_INSTRUCTIONS);
      const tools = await connected.client.listTools();
      assert.equal(tools.tools.length, 12, "the whole tool surface is still served");
      const prompts = await connected.client.listPrompts();
      assert.deepEqual(prompts.prompts.map((prompt) => prompt.name), [...WORKFLOW_PROMPT_NAMES]);
    } finally {
      await connected.close();
    }
  });
});

describe("the initialize result", () => {
  const connection = openConnection();
  before(() => connection.open());
  after(() => connection.close());

  test("carries the instructions it was given, verbatim", () => {
    assert.equal(connection.client().getInstructions(), TEST_INSTRUCTIONS);
  });

  test("declares the prompts capability, which is what makes slash commands appear", () => {
    const capabilities = connection.client().getServerCapabilities() ?? {};
    assert.ok(capabilities.prompts !== undefined, "prompts capability is declared");
    assert.ok(capabilities.tools !== undefined, "tools capability is still declared");
  });
});

describe("prompts/list", () => {
  const connection = openConnection();
  before(() => connection.open());
  after(() => connection.close());

  test("offers exactly the documented entry points, each with a title and a description", async () => {
    const listed = await connection.client().listPrompts();
    assert.deepEqual(
      listed.prompts.map((prompt) => prompt.name),
      [...WORKFLOW_PROMPT_NAMES],
    );
    for (const prompt of listed.prompts) {
      assert.ok((prompt.title ?? "").length > 0, `${prompt.name} has a title`);
      assert.ok((prompt.description ?? "").length > 0, `${prompt.name} has a description`);
    }
  });

  test("declares exactly one required argument each, and no optional ones", async () => {
    // Measured, not stylistic: Claude Code 2.1.285 binds slash-command words positionally to
    // the declared arguments and drops the rest, so a second declared argument fills itself
    // with the second word of the user's sentence. See `workflow-prompts.ts`.
    const listed = await connection.client().listPrompts();
    const declared = new Map(
      listed.prompts.map((prompt) => [prompt.name, (prompt.arguments ?? []).map((argument) => argument.name)]),
    );
    assert.deepEqual(declared.get("new_deck"), ["request"]);
    assert.deepEqual(declared.get("revise_from_feedback"), ["presentationId"]);
    assert.deepEqual(declared.get("second_wave"), ["proposalId"]);
    for (const prompt of listed.prompts) {
      assert.deepEqual(
        (prompt.arguments ?? []).map((argument) => argument.required),
        [true],
        `${prompt.name} declares exactly one argument, and it is required`,
      );
    }
  });

  test("describes every argument, because the user sees these in the slash-command UI", async () => {
    const listed = await connection.client().listPrompts();
    for (const prompt of listed.prompts) {
      for (const argument of prompt.arguments ?? []) {
        assert.ok((argument.description ?? "").length > 0, `${prompt.name}.${argument.name} is described`);
      }
    }
  });
});

describe("prompts/get", () => {
  const connection = openConnection();
  before(() => connection.open());
  after(() => connection.close());

  test("new_deck returns a single user turn that carries the request through", async () => {
    const got = await connection
      .client()
      .getPrompt({ name: "new_deck", arguments: { request: "our Q3 retention numbers" } });
    assert.equal(got.messages.length, 1);
    assert.equal(got.messages[0]?.role, "user");
    const text = textOf(got);
    assert.ok(text.includes("our Q3 retention numbers"));
    assert.ok(text.includes("propose_slides"), "names the tool the agent must call");
    assert.ok(text.includes("await_pick"), "and the one it must wait on");
  });

  test("new_deck survives a client that binds only the first word", async () => {
    // The template has to still read correctly when `request` is one word, and has to point
    // the agent at the raw text the client kept alongside it.
    const text = textOf(await connection.client().getPrompt({ name: "new_deck", arguments: { request: "our" } }));
    assert.ok(text.startsWith("Make candidate slides for: our"));
    assert.ok(text.includes("my full request is in the message this arrived with"));
  });

  test("revise_from_feedback walks the comment channel in order", async () => {
    const text = textOf(
      await connection.client().getPrompt({ name: "revise_from_feedback", arguments: { presentationId: "deck-9" } }),
    );
    assert.ok(text.includes("deck-9"));
    for (const tool of [
      "read_feedback",
      "propose_slides",
      "await_pick",
      "reply_feedback",
      "resolve_feedback",
      "await_feedback",
    ]) {
      assert.ok(text.includes(tool), `names ${tool}`);
    }
  });

  test("second_wave stays within today's protocol: a new proposal, after the first is answered", async () => {
    const text = textOf(
      await connection.client().getPrompt({ name: "second_wave", arguments: { proposalId: "p_1_aaa111" } }),
    );
    assert.ok(text.includes("p_1_aaa111"));
    assert.ok(text.includes("NEW proposal"));
    assert.ok(text.includes("Wave one is answered"), "it never tells the agent to stage two at once");
    assert.ok(text.includes("1-based"));
  });

  test("a missing required argument is an error, not an empty template", async () => {
    await assert.rejects(() => connection.client().getPrompt({ name: "new_deck", arguments: {} }));
  });
});

describe("the prompt builders", () => {
  test("are pure: the same arguments give the same text", () => {
    const options = { request: "onboarding" } as const;
    assert.equal(textOf(newDeckPrompt(options)), textOf(newDeckPrompt(options)));
  });

  test("each carry a description naming what the turn is for", () => {
    assert.match(newDeckPrompt({ request: "pricing" }).description ?? "", /pricing/);
    assert.match(reviseFromFeedbackPrompt({ presentationId: "deck-1" }).description ?? "", /deck-1/);
    assert.match(secondWavePrompt({ proposalId: "p_1_a" }).description ?? "", /p_1_a/);
  });

  test("produce user turns only - a prompt is words the user is submitting, never words the model said", () => {
    const every = [
      newDeckPrompt({ request: "x" }),
      reviseFromFeedbackPrompt({ presentationId: "d" }),
      secondWavePrompt({ proposalId: "p" }),
    ];
    for (const result of every) {
      for (const message of result.messages) assert.equal(message.role, "user");
    }
  });
});

describe("the served instructions stay true to the tool surface", () => {
  const connection = openConnection();
  before(() => connection.open());
  after(() => connection.close());

  test("the skill names every registered tool, so the source of truth covers the whole surface", async () => {
    const registered = (await connection.client().listTools()).tools.map((tool) => tool.name);
    const body = stripSkillFrontmatter(skillMarkdown());
    for (const name of registered) {
      assert.ok(body.includes(name), `the skill mentions ${name}`);
    }
  });

  test("nothing tool-shaped is served that is not a registered tool", async () => {
    // The abridged instructions do not mention every tool - the budget drops the sections
    // that walk the loop - but anything they DO name must exist, because a name in the system
    // prompt is a name the model will try to call.
    const registered = (await connection.client().listTools()).tools.map((tool) => tool.name);
    const served = await servedInstructions();
    const mentioned: readonly string[] = served.match(/\b[a-z][a-z_]*_[a-z_]+\b/g) ?? [];
    assert.ok(mentioned.length > 0, "the served instructions name at least one tool");
    for (const word of new Set(mentioned)) {
      assert.ok(registered.includes(word), `${word} looks like a tool but is not registered`);
    }
  });
});

/** The instructions the in-memory connections serve: a sentinel, so delivery is unambiguous. */
const TEST_INSTRUCTIONS = "test instructions: delivery is what this connection asserts";

function skillMarkdown(): string {
  return readFileSync(join(REPO_ROOT, SKILL_RELATIVE_PATH), "utf8");
}

/**
 * What a client is really handed by a real subprocess, which is the claim worth asserting.
 * Memoised: spawning `npx tsx` costs a couple of seconds and the answer cannot change within
 * one run, so every assertion below shares one subprocess.
 */
function servedInstructions(): Promise<string> {
  servedOnce ??= (async () => {
    const connected = await connectToSubprocess({ skillFile: null, budget: null });
    try {
      return connected.client.getInstructions() ?? "";
    } finally {
      await connected.close();
    }
  })();
  return servedOnce;
}

let servedOnce: Promise<string> | null = null;

/**
 * A real `server.ts --stdio` child, connected over stdio - the transport Claude Code uses for
 * a local MCP server. `cwd` is the repository root so the relative `--skill-file` default and
 * the `npx tsx` resolution both behave as they do in a real `claude mcp add`.
 */
async function connectToSubprocess(
  options: Readonly<{ skillFile: string | null; budget: number | null }>,
): Promise<Readonly<{ client: Client; close: () => Promise<void> }>> {
  const args = ["tsx", join(REPO_ROOT, "mcp/sasha-slides/server.ts"), "--stdio"];
  if (options.skillFile !== null) args.push("--skill-file", options.skillFile);
  if (options.budget !== null) args.push("--instructions-budget", String(options.budget));
  const transport = new StdioClientTransport({
    command: "npx",
    args,
    cwd: REPO_ROOT,
    stderr: "ignore",
  });
  const client = new Client({ name: "workflow-guidance-test", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);
  return { client, close: () => client.close() };
}

/**
 * One connected `Client`/`McpServer` pair per `describe`, opened in `before` and closed in
 * `after`. The resolvers refuse: every assertion on these is about negotiation and templates,
 * so wiring a Drive would only add a way for the test to fail for an unrelated reason.
 */
function openConnection(): Readonly<{
  open: () => Promise<void>;
  close: () => Promise<void>;
  client: () => Client;
}> {
  let connected: Readonly<{ client: Client; close: () => Promise<void> }> | null = null;
  return {
    open: async () => {
      const client = new Client({ name: "workflow-guidance-test", version: "1.0.0" }, { capabilities: {} });
      const server = createSashaSlidesServer({
        resolveEnvironment: () => Promise.resolve({ kind: "auth-failed", message: "test: no Drive" }),
        resolveFeedbackEnvironment: () => Promise.resolve({ kind: "auth-failed", message: "test: no comments" }),
        instructions: TEST_INSTRUCTIONS,
      });
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      await server.connect(serverSide);
      await client.connect(clientSide);
      connected = {
        client,
        close: async () => {
          await client.close();
          await server.close();
        },
      };
    },
    close: async () => {
      if (connected === null) return;
      await connected.close();
      connected = null;
    },
    client: () => {
      if (connected === null) throw new Error("the connection is not open");
      return connected.client;
    },
  };
}

function textOf(result: Readonly<{ messages: readonly Readonly<{ content: unknown }>[] }>): string {
  return result.messages
    .map((message) => {
      const { content } = message;
      if (typeof content !== "object" || content === null) return "";
      if (!("type" in content) || content.type !== "text") return "";
      return "text" in content && typeof content.text === "string" ? content.text : "";
    })
    .join("\n");
}
