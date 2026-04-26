// Flat-config ESLint for the whole repo. The single rule we strictly enforce
// is `@typescript-eslint/no-explicit-any: "error"` — TypeScript itself has
// no compiler flag that bans explicit `any` (noImplicitAny only catches the
// implicit case), so this is what guards us against type-erasure escape
// hatches like the pixelmatch-as-any bug that crashed wave-7b.
//
// build.ts (structured-prompting/build.ts) runs ESLint before esbuild and
// fails the build on any violation — so `: any`, `as any`, `<any>`, etc.
// can't ship without a deliberate eslint-disable comment.
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "node_modules/**",
      "dist/**",
      "**/dist/**",
      "structured-prompting/dist/**",
      ".claude/**",
      "**/*.d.ts",
      "renderer/node_modules/**",
      "structured-prompting/node_modules/**",
      // Test files are not bundled; they have legitimate `any` for
      // matcher injection. Lint them separately if/when needed.
      "**/*.test.ts",
    ],
  },
  ...tseslint.configs.recommended.map((c) => ({
    ...c,
    files: ["**/*.ts", "**/*.tsx"],
    // Disable every recommended rule by default — we only want the one rule
    // that bans explicit `any`. Adding more rules later is a matter of
    // un-overriding them here.
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
    },
  })),
);
