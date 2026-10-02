/**
 * The playground's OpenAPI-spec import test (docs/web-ui.md, Structure).
 *
 * Playground-owned (listed in .playground-files). Scans every .ts/.tsx/.js/.jsx/.mjs file under `web/src`, `web/e2e`
 * and `web/test` (this file excluded) for an import, dynamic import or require of any `openapi.json`, and fails unless
 * the specifier resolves to `web/src/api/openapi.json`. It also fails while `web/openapi.json` exists.
 * The template defines no path alias for src, so only relative specifiers are accepted.
 */
import { describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = join(here, "..");
const SELF = fileURLToPath(import.meta.url);

const SCAN_DIRS = ["src", "e2e", "test"];
const SKIP_DIRS = new Set(["node_modules", "dist", "generated"]);
const SOURCE_RE = /\.(ts|tsx|js|jsx|mjs)$/;

/** `from "x"`, `import "x"`, `import("x")`, `require("x")` where x names an openapi.json (an optional ?query is allowed). */
const SPEC_IMPORT_RE =
  /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)(["'`])([^"'`\n]*openapi\.json)(?:\?[^"'`\n]*)?\1/g;

export interface Violation {
  file: string;
  line: number;
  specifier: string;
}

function walk(dir: string, self: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (!SKIP_DIRS.has(name)) walk(p, self, out);
    } else if (SOURCE_RE.test(name) && p !== self) {
      out.push(p);
    }
  }
}

/** The specifier the importing file should use for src/api/openapi.json. */
export function expectedSpecifier(webRoot: string, file: string): string {
  const rel = relative(dirname(file), join(webRoot, "src", "api", "openapi.json"))
    .split(sep)
    .join("/");
  return rel.startsWith(".") ? rel : `./${rel}`;
}

/** Every openapi.json import under webRoot that does not resolve to src/api/openapi.json. */
export function findSpecViolations(webRoot: string, self = ""): Violation[] {
  const target = resolve(webRoot, "src", "api", "openapi.json");
  const files: string[] = [];
  for (const d of SCAN_DIRS) if (existsSync(join(webRoot, d))) walk(join(webRoot, d), self, files);
  const hits: Violation[] = [];
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(SPEC_IMPORT_RE)) {
      const index = m.index ?? 0;
      const lineStart = src.lastIndexOf("\n", index - 1) + 1;
      if (/^\s*(\/\/|\*|\/\*)/.test(src.slice(lineStart, index + 1))) continue;
      const specifier = m[2] ?? "";
      const ok = specifier.startsWith(".") && resolve(dirname(f), specifier) === target;
      if (!ok)
        hits.push({
          file: relative(webRoot, f).split(sep).join("/"),
          line: src.slice(0, index).split("\n").length,
          specifier,
        });
    }
  }
  return hits;
}

export function describeViolation(webRoot: string, v: Violation): string {
  const want = expectedSpecifier(webRoot, join(webRoot, v.file));
  return (
    `web/${v.file}:${v.line} imports the OpenAPI spec as "${v.specifier}". Use \`import spec from "${want}"\`. ` +
    `Why: the dev server proxy sends /openapi.json requests to the Go server, so a module import must resolve to src/api/openapi.json. ` +
    `\`npm run gen:api\` writes src/api/openapi.json; see docs/web-ui.md`
  );
}

export function legacySpecProblem(webRoot: string): string | null {
  if (!existsSync(join(webRoot, "openapi.json"))) return null;
  return (
    `web/openapi.json still exists. Delete it and import the spec as \`import spec from "../api/openapi.json"\` (relative to the importing file). ` +
    `Why: the dev server proxy sends /openapi.json requests to the Go server, so a module import must resolve to src/api/openapi.json. ` +
    `\`npm run gen:api\` writes src/api/openapi.json; see docs/web-ui.md`
  );
}

describe("the OpenAPI spec is imported from src/api/openapi.json (spec-import convention)", () => {
  it("imports no openapi.json except src/api/openapi.json", () => {
    const hits = findSpecViolations(WEB_ROOT, SELF);
    expect(
      hits.map((h) => describeViolation(WEB_ROOT, h)),
      "spec-import convention",
    ).toEqual([]);
  });

  it("has no web/openapi.json", () => {
    expect(legacySpecProblem(WEB_ROOT) ?? "").toBe("");
  });
});

describe("the spec-import checker", () => {
  function tree(files: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), "spec-import-"));
    for (const [rel, body] of Object.entries(files)) {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), body);
    }
    return root;
  }
  const run = (files: Record<string, string>) => {
    const root = tree(files);
    try {
      return { root, hits: findSpecViolations(root), legacy: legacySpecProblem(root) };
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };

  it("accepts the relative forms that resolve to src/api/openapi.json", () => {
    const { hits, legacy } = run({
      "src/api/openapi.json": "{}",
      "src/routes/index.tsx": 'import spec from "../api/openapi.json";\n',
      "src/routes/deep/page.tsx": 'import spec from "../../api/openapi.json" with { type: "json" };\n',
      "src/main.tsx": "import spec from './api/openapi.json';\n",
      "src/api/index.ts": 'import spec from "./openapi.json";\n',
      "src/lazy.ts": 'const s = await import("./api/openapi.json");\n',
      "e2e/smoke.spec.ts": 'import spec from "../src/api/openapi.json";\n',
      "test/x.test.ts": 'const s = require("../src/api/openapi.json");\n',
      "src/note.ts": '// import spec from "../../openapi.json" is the old form\n',
    });
    expect(hits).toEqual([]);
    expect(legacy).toBeNull();
  });

  it("rejects ../../openapi.json (web/openapi.json) with file and line", () => {
    const { hits } = run({ "src/routes/new.tsx": 'import a from "x";\nimport spec from "../../openapi.json";\n' });
    expect(hits).toEqual([{ file: "src/routes/new.tsx", line: 2, specifier: "../../openapi.json" }]);
  });

  it("rejects ../openapi.json that points at web/openapi.json from a file in web/test or web/e2e", () => {
    const { hits } = run({
      "test/a.test.ts": 'import s from "../openapi.json";\n',
      "e2e/b.spec.ts": 'import s from "../openapi.json";\n',
    });
    expect(hits.map((h) => h.file).sort()).toEqual(["e2e/b.spec.ts", "test/a.test.ts"]);
  });

  it("rejects a wrong relative path, a bare or absolute specifier, and a dynamic import or require", () => {
    const { hits } = run({
      "src/a.ts": 'import s from "../openapi.json";\n',
      "src/b.ts": 'import s from "/openapi.json";\n',
      "src/c.ts": '\nconst s = await import("../../openapi.json");\n',
      "src/d.js": 'const s = require("../../openapi.json");\n',
    });
    expect(hits.map((h) => `${h.file}:${h.line}`).sort()).toEqual([
      "src/a.ts:1",
      "src/b.ts:1",
      "src/c.ts:2",
      "src/d.js:1",
    ]);
  });

  it("rejects a file in web/e2e", () => {
    const { hits } = run({ "e2e/smoke.spec.ts": 'import spec from "../openapi.json";\n' });
    expect(hits).toEqual([{ file: "e2e/smoke.spec.ts", line: 1, specifier: "../openapi.json" }]);
  });

  it("fails while web/openapi.json exists", () => {
    const { legacy } = run({ "openapi.json": "{}" });
    expect(legacy).toContain("web/openapi.json still exists");
    expect(legacy).toContain("see docs/web-ui.md");
  });

  it("tells the importing file what to write, why, and how to regenerate", () => {
    const msg = describeViolation("/w", { file: "src/routes/deep/x.tsx", line: 4, specifier: "../../openapi.json" });
    expect(msg).toContain("web/src/routes/deep/x.tsx:4");
    expect(msg).toContain('import spec from "../../api/openapi.json"');
    expect(msg).toContain("proxy sends /openapi.json requests to the Go server");
    expect(msg).toContain("npm run gen:api");
    expect(msg.endsWith("see docs/web-ui.md")).toBe(true);
    expect(expectedSpecifier("/w", "/w/src/main.tsx")).toBe("./api/openapi.json");
  });
});
