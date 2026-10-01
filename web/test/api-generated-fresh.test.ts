/**
 * The playground's generated-API freshness test (rule WEB-18).
 *
 * Playground-owned (listed in .playground-files). Runs the repo's own `node_modules/.bin/openapi-typescript` on
 * `src/api/openapi.json` into a temp file (no network) and requires it to equal the committed `src/api/schema.d.ts`
 * byte for byte. The Go test TestOpenAPISpecFresh checks openapi.json itself against the code. To fix a failure run
 * `npm run gen:api` and commit both files. Without node_modules/.bin/openapi-typescript the test is skipped, except
 * when CI=1 or PLAYGROUND_REQUIRE_DB is set, where it fails instead.
 */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = join(here, "..");
const HINT = "the generated file is stale: the API changed; run `npm run gen:api` and commit it; see docs/web-ui.md";

/** The first line at which two texts differ, for the failure message. */
export function firstDifference(committed: string, generated: string): string {
  const a = committed.split("\n");
  const b = generated.split("\n");
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) return `line ${i + 1}: committed ${JSON.stringify(a[i] ?? "<end of file>")}, generated ${JSON.stringify(b[i] ?? "<end of file>")}`;
  }
  return "no difference";
}

/** "" when src/api/schema.d.ts equals what `generate` (openapi-typescript on openapi.json) produces; otherwise the message. */
export function schemaProblem(webRoot: string, generate: (specPath: string, outPath: string) => void): string {
  const spec = join(webRoot, "src", "api", "openapi.json");
  const schema = join(webRoot, "src", "api", "schema.d.ts");
  if (!existsSync(spec)) return `web/src/api/openapi.json is missing: the generated file is missing; run \`npm run gen:api\` and commit it; see docs/web-ui.md`;
  if (!existsSync(schema)) return `web/src/api/schema.d.ts is missing: the generated file is missing; run \`npm run gen:api\` and commit it; see docs/web-ui.md`;
  const dir = mkdtempSync(join(tmpdir(), "api-fresh-"));
  try {
    const out = join(dir, "schema.d.ts");
    generate(spec, out);
    const generated = readFileSync(out, "utf8");
    const committed = readFileSync(schema, "utf8");
    if (generated === committed) return "";
    return `web/src/api/schema.d.ts differs from openapi-typescript's output for src/api/openapi.json (${firstDifference(committed, generated)}). ${HINT}`;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const bin = join(WEB_ROOT, "node_modules", ".bin", "openapi-typescript");
const required = process.env.CI === "1" || !!process.env.PLAYGROUND_REQUIRE_DB;

function runBin(spec: string, out: string): void {
  execFileSync(bin, [spec, "-o", out], { cwd: WEB_ROOT, stdio: "pipe" });
}

describe("src/api/schema.d.ts is fresh (WEB-18)", () => {
  if (!existsSync(bin) && !required) {
    it.skip("skipped: node_modules/.bin/openapi-typescript is missing (run npm ci); CI=1 or PLAYGROUND_REQUIRE_DB makes this a failure", () => {});
    return;
  }
  it("equals openapi-typescript's output for src/api/openapi.json", () => {
    expect(existsSync(bin), "node_modules/.bin/openapi-typescript is missing; run `npm ci`; see docs/web-ui.md").toBe(true);
    expect(schemaProblem(WEB_ROOT, runBin), "WEB-18").toBe("");
  });
});

describe("the schema freshness checker", () => {
  function tree(files: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), "api-fresh-tree-"));
    for (const [name, body] of Object.entries(files)) {
      mkdirSync(dirname(join(root, name)), { recursive: true });
      writeFileSync(join(root, name), body);
    }
    return root;
  }
  const upper = (spec: string, out: string) => writeFileSync(out, readFileSync(spec, "utf8").toUpperCase());

  it("passes when the committed file equals the generated one", () => {
    const root = tree({ "src/api/openapi.json": "abc\n", "src/api/schema.d.ts": "ABC\n" });
    expect(schemaProblem(root, upper)).toBe("");
  });

  it("fails on a mismatch, naming the first differing line and how to fix it", () => {
    const root = tree({ "src/api/openapi.json": "a\nb\n", "src/api/schema.d.ts": "A\nX\n" });
    const msg = schemaProblem(root, upper);
    expect(msg).toContain("line 2");
    expect(msg).toContain("npm run gen:api");
    expect(msg.endsWith("see docs/web-ui.md")).toBe(true);
  });

  it("fails when openapi.json or schema.d.ts is missing", () => {
    for (const files of [{ "src/api/schema.d.ts": "A" }, { "src/api/openapi.json": "a" }]) {
      const msg = schemaProblem(tree(files), upper);
      expect(msg).toContain("is missing");
      expect(msg.endsWith("see docs/web-ui.md")).toBe(true);
    }
  });
});
