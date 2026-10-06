/**
 * The playground's server-call test (server calls go only through the hooks @teb-ooo/web builds from
 * `src/api/schema.d.ts`, never through fetch).
 *
 * Playground-owned (listed in .playground-files). Through the TypeScript parser it fails on a call of `fetch(...)`
 * (also `window.fetch`, `globalThis.fetch`, `self.fetch`), `new XMLHttpRequest(...)` and any call on `axios`, in every
 * .ts/.tsx/.js/.jsx/.mjs file under `web/src` (the hooks' own wrapper included). Not scanned: `web/e2e` (end-to-end tests may
 * fetch), test files (`*.test.*`, `*.spec.*`), and generated files (`schema.d.ts`, `routeTree.gen.ts`, `.d.ts` under
 * `src/api/`, files that say "generated" or "DO NOT EDIT" at the top). Comments and strings never match.
 *
 * Escape for a route that is not in the OpenAPI spec (for example a proxy to another service): the comment
 * `// playground:allow-fetch <reason>` on the same line as the call or the line above it. The reason is mandatory: a marker
 * without one fails the test, so every raw call carries its justification.
 *
 * To fix a failure: add or change the operation in the Go API, run `npm run gen:api`, and call it with the generated hook
 * (`api.useQuery("get", "/api/items")`, `api.useMutation("post", "/api/items")`).
 */
import { describe, expect, it } from "vitest";
import ts from "typescript";
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
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = join(here, "..");
const DOC = "see docs/web-ui.md";
const MARKER = "playground:allow-fetch";

const SCAN_DIRS = ["src"];
const SKIP_DIRS = new Set(["node_modules", "dist", "generated"]);
const SOURCE_RE = /\.(ts|tsx|js|jsx|mjs)$/;
const TEST_RE = /\.(test|spec)\.[a-z]+$/;
const GLOBALS = new Set(["window", "globalThis", "self"]);

export interface RawCall {
  file: string;
  line: number;
  what: string;
  /** "" = not excused; "no-reason" = marker without a reason */
  marker: "" | "no-reason";
}

function isGenerated(webRoot: string, file: string, src: string): boolean {
  const rel = relative(webRoot, file).split(sep).join("/");
  if (rel.endsWith("/schema.d.ts") || rel.endsWith("/routeTree.gen.ts")) return true;
  if (rel.startsWith("src/api/") && rel.endsWith(".d.ts")) return true;
  return /generated|do not edit/i.test(src.split("\n", 5).join("\n"));
}

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (!SKIP_DIRS.has(name) && name !== "__tests__") walk(p, out);
    } else if (SOURCE_RE.test(name) && !TEST_RE.test(name)) {
      out.push(p);
    }
  }
}

/** The marker on a line: undefined = none, "" = no reason, otherwise the reason. Only inside a comment. */
function markerOn(line: string | undefined): string | undefined {
  if (line === undefined) return undefined;
  const m = new RegExp(`(?://|/\\*)[^\\n]*?${MARKER}\\b(.*)$`).exec(line);
  if (!m) return undefined;
  return (m[1] ?? "")
    .replace(/\*\/.*$/, "")
    .replace(/[}\s]+$/, "")
    .trim();
}

function callName(n: ts.CallExpression | ts.NewExpression): string | null {
  const e = n.expression;
  if (ts.isNewExpression(n)) return ts.isIdentifier(e) && e.text === "XMLHttpRequest" ? "new XMLHttpRequest" : null;
  if (ts.isIdentifier(e)) return e.text === "fetch" ? "fetch(...)" : e.text === "axios" ? "axios(...)" : null;
  if (ts.isPropertyAccessExpression(e)) {
    if (ts.isIdentifier(e.expression) && GLOBALS.has(e.expression.text) && e.name.text === "fetch")
      return `${e.expression.text}.fetch(...)`;
    let root: ts.Expression = e;
    while (ts.isPropertyAccessExpression(root) || ts.isCallExpression(root)) root = root.expression;
    if (ts.isIdentifier(root) && root.text === "axios") return "axios call";
  }
  return null;
}

/** Every raw server call under web/src that a valid marker does not excuse. */
export function findRawCalls(webRoot: string): RawCall[] {
  const files: string[] = [];
  for (const d of SCAN_DIRS) if (existsSync(join(webRoot, d))) walk(join(webRoot, d), files);
  const out: RawCall[] = [];
  for (const f of files.sort()) {
    const src = readFileSync(f, "utf8");
    if (isGenerated(webRoot, f, src)) continue;
    const kind = f.endsWith("x") ? ts.ScriptKind.TSX : f.endsWith(".ts") ? ts.ScriptKind.TS : ts.ScriptKind.JS;
    const sf = ts.createSourceFile(f, src, ts.ScriptTarget.Latest, true, kind);
    const lines = src.split("\n");
    const visit = (n: ts.Node): void => {
      if (ts.isCallExpression(n) || ts.isNewExpression(n)) {
        const what = callName(n);
        if (what) {
          const idx = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line;
          const reason = markerOn(lines[idx]) ?? markerOn(lines[idx - 1]);
          const file = relative(webRoot, f).split(sep).join("/");
          const dup = out.some((o) => o.file === file && o.line === idx + 1 && o.what === what);
          if (!dup && (reason === undefined || reason === "")) {
            out.push({
              file: relative(webRoot, f).split(sep).join("/"),
              line: idx + 1,
              what,
              marker: reason === "" ? "no-reason" : "",
            });
          }
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return out;
}

export function describeRawCall(c: RawCall): string {
  if (c.marker === "no-reason") {
    return `web/${c.file}:${c.line}: server-call convention (docs/web-ui.md, Structure): the marker \`// ${MARKER}\` has no reason. Write \`// ${MARKER} <why this call cannot be a generated hook>\`; ${DOC}`;
  }
  return (
    `web/${c.file}:${c.line}: server-call convention (docs/web-ui.md, Structure): ${c.what} is a raw server call; server calls go only through the hooks @teb-ooo/web builds from src/api/schema.d.ts. ` +
    `To fix: add the operation to the Go API, run \`npm run gen:api\` and use api.useQuery("get", "/api/...") or api.useMutation(...); ` +
    `if the call is outside the generated client (a route that is not in the OpenAPI spec), use \`platformFetch(url, init)\` and \`throwIfNotOk(res)\` from @teb-ooo/web (cookies, Accept JSON, X-Request-Id, an ApiError on failure) before reaching for the marker, and show errors with \`describeError(error)\` from the same package; only if neither fits put \`// ${MARKER} <reason>\` on that line or the line above; ${DOC}`
  );
}

describe("server calls go through the generated hooks (server-call convention)", () => {
  it("web/src makes no raw fetch, XMLHttpRequest or axios call", () => {
    const hits = findRawCalls(WEB_ROOT).map(describeRawCall);
    expect(hits, hits.join("\n")).toEqual([]);
  });
});

describe("the raw-call checker", () => {
  function run(files: Record<string, string>): RawCall[] {
    const dir = mkdtempSync(join(tmpdir(), "no-raw-fetch-"));
    try {
      for (const [name, body] of Object.entries(files)) {
        mkdirSync(dirname(join(dir, name)), { recursive: true });
        writeFileSync(join(dir, name), body);
      }
      return findRawCalls(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  const at = (hits: RawCall[]) => hits.map((h) => `${h.file}:${h.line}:${h.what}${h.marker ? ":" + h.marker : ""}`);

  it("accepts hooks, comments, strings, fetch as a property name and files it does not scan", () => {
    const hits = run({
      "src/a.tsx":
        'const { data } = api.useQuery("get", "/api/items");\n// fetch("/x") is banned\nconst s = "fetch(1)";\nconst o = { fetch: 1 };\nconst r = obj.fetch(1);\n',
      "e2e/smoke.spec.ts": 'await fetch("/healthz");\n',
      "src/a.test.tsx": 'await fetch("/x");\n',
      "src/api/schema.d.ts": "declare const x: ReturnType<typeof fetch>;\n",
      "src/routeTree.gen.ts": 'fetch("/x");\n',
    });
    expect(hits).toEqual([]);
  });

  it("rejects fetch, window.fetch, globalThis.fetch, new XMLHttpRequest and axios with file and line", () => {
    const hits = run({
      "src/a.ts": 'export const f = () => fetch("/api/x");\n',
      "src/b.tsx": '\nawait window.fetch("/x");\nawait globalThis.fetch("/y");\n',
      "src/c.ts": "const x = new XMLHttpRequest();\n",
      "src/d.ts": 'axios.get("/x");\naxios("/y");\naxios.create().post("/z");\n',
    });
    expect(at(hits)).toEqual([
      "src/a.ts:1:fetch(...)",
      "src/b.tsx:2:window.fetch(...)",
      "src/b.tsx:3:globalThis.fetch(...)",
      "src/c.ts:1:new XMLHttpRequest",
      "src/d.ts:1:axios call",
      "src/d.ts:2:axios(...)",
      "src/d.ts:3:axios call",
    ]);
    const msg = describeRawCall(hits[0]!);
    expect(msg).toContain("web/src/a.ts:1: server-call convention");
    expect(msg).toContain("npm run gen:api");
    expect(msg).toContain("playground:allow-fetch <reason>");
    expect(msg).toContain("platformFetch");
    expect(msg.endsWith("see docs/web-ui.md")).toBe(true);
  });

  it("accepts the marker with a reason on the same line or the line above", () => {
    const hits = run({
      "src/a.ts": 'const a = await fetch("/auth/x"); // playground:allow-fetch identity flow proxy, not in OpenAPI\n',
      "src/b.ts": '// playground:allow-fetch identity flow proxy, not in OpenAPI\nconst b = await fetch("/auth/y");\n',
      "src/c.tsx": '{/* playground:allow-fetch avatar upload to the id proxy */}\nconst c = await fetch("/auth/z");\n',
    });
    expect(hits).toEqual([]);
  });

  it("fails a marker without a reason, and a marker two lines away", () => {
    const hits = run({
      "src/a.ts": '// playground:allow-fetch\nconst a = await fetch("/x");\n',
      "src/b.ts": 'const b = await fetch("/x"); // playground:allow-fetch   \n',
      "src/c.ts": '// playground:allow-fetch far away\n\nconst c = await fetch("/x");\n',
      "src/d.ts": 'const marker = "playground:allow-fetch in a string";\nconst d = await fetch("/x");\n',
    });
    expect(at(hits)).toEqual([
      "src/a.ts:2:fetch(...):no-reason",
      "src/b.ts:1:fetch(...):no-reason",
      "src/c.ts:3:fetch(...)",
      "src/d.ts:2:fetch(...)",
    ]);
    expect(describeRawCall(hits[0]!)).toContain("has no reason");
    expect(describeRawCall(hits[0]!).endsWith("see docs/web-ui.md")).toBe(true);
  });
});
