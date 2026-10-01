/**
 * The playground's TypeScript strictness test (rule WEB-24: strict, `verbatimModuleSyntax`, no `any`).
 *
 * Playground-owned (listed in .playground-files). It asserts three things:
 *  1. the effective compilerOptions of the app's tsconfig files (tsconfig.json and every file it references, with
 *     `extends` resolved; comments and trailing commas are tolerated) have `strict` true, `verbatimModuleSyntax` true and
 *     `noImplicitAny` not false;
 *  2. no .ts/.tsx/.mts/.cts file under `web/src` and `web/e2e` uses the explicit `any` type (found through the TypeScript
 *     parser, so strings, comments and identifiers such as `company` never match). Generated files are skipped:
 *     `schema.d.ts`, `routeTree.gen.ts`, any `.d.ts` under `src/api/`, and files whose first lines say "generated" or
 *     "DO NOT EDIT". There is no per-line escape;
 *  3. package.json has an `npm run typecheck` script.
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
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = join(here, "..");

const SCAN_DIRS = ["src", "e2e"];
const SKIP_DIRS = new Set(["node_modules", "dist", "generated"]);
const SOURCE_RE = /\.(ts|tsx|mts|cts)$/;
const DOC = "see docs/web-ui.md";

export interface AnyUse {
  file: string;
  line: number;
  text: string;
}

type Options = Record<string, unknown>;

interface ConfigNode {
  file: string;
  options: Options;
  /** Which file set each option (the nearest in the extends chain wins). */
  origin: Record<string, string>;
  hasReferences: boolean;
}

function readJsonc(file: string): Record<string, unknown> {
  const parsed = ts.parseConfigFileTextToJson(file, readFileSync(file, "utf8"));
  if (parsed.error) throw new Error(`${file}: ${ts.flattenDiagnosticMessageText(parsed.error.messageText, "\n")}`);
  return (parsed.config ?? {}) as Record<string, unknown>;
}

function withJson(p: string): string {
  return p.endsWith(".json") ? p : `${p}.json`;
}

function resolveExtends(from: string, spec: string): string | null {
  if (spec.startsWith(".") || spec.startsWith("/")) {
    const p = resolve(dirname(from), spec);
    return [p, withJson(p)].find((c) => existsSync(c) && statSync(c).isFile()) ?? null;
  }
  for (let d = dirname(from); ; d = dirname(d)) {
    const base = join(d, "node_modules", spec);
    const hit = [base, withJson(base), join(base, "tsconfig.json")].find((c) => existsSync(c) && statSync(c).isFile());
    if (hit) return hit;
    if (dirname(d) === d) return null;
  }
}

function loadConfig(file: string, seen: string[] = []): ConfigNode {
  if (seen.includes(file)) throw new Error(`${file}: circular "extends"`);
  const json = readJsonc(file);
  let options: Options = {};
  let origin: Record<string, string> = {};
  const ext = json.extends;
  for (const spec of typeof ext === "string" ? [ext] : Array.isArray(ext) ? (ext as string[]) : []) {
    const target = resolveExtends(file, spec);
    if (!target) throw new Error(`${file}: cannot resolve extends "${spec}"`);
    const base = loadConfig(target, [...seen, file]);
    options = { ...options, ...base.options };
    origin = { ...origin, ...base.origin };
  }
  const own = (json.compilerOptions ?? {}) as Options;
  for (const k of Object.keys(own)) origin[k] = file;
  return { file, options: { ...options, ...own }, origin, hasReferences: Array.isArray(json.references) };
}

/** tsconfig.json plus every file reachable through "references" (a path may name a directory). */
export function collectConfigs(webRoot: string): string[] {
  const root = join(webRoot, "tsconfig.json");
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const visit = (file: string): void => {
    if (out.includes(file)) return;
    out.push(file);
    const refs = readJsonc(file).references;
    if (!Array.isArray(refs)) return;
    for (const r of refs as { path?: string }[]) {
      if (typeof r.path !== "string") continue;
      const p = resolve(dirname(file), r.path);
      const target = existsSync(p) && statSync(p).isDirectory() ? join(p, "tsconfig.json") : withJson(p);
      if (existsSync(target)) visit(target);
    }
  };
  visit(root);
  return out;
}

/** One message per missing or disabled option, naming the tsconfig file. */
export function findConfigProblems(webRoot: string): string[] {
  const files = collectConfigs(webRoot);
  if (files.length === 0) return [`web/tsconfig.json is missing; the app needs a strict tsconfig, ${DOC}`];
  const problems: string[] = [];
  const name = (f: string): string => `web/${relative(webRoot, f).split(sep).join("/")}`;
  for (const file of files) {
    let node: ConfigNode;
    try {
      node = loadConfig(file);
    } catch (e) {
      problems.push(`${(e as Error).message}, ${DOC}`);
      continue;
    }
    // A solution-style config (only "references", no options of its own) compiles nothing itself.
    if (node.hasReferences && Object.keys(node.options).length === 0) continue;
    const at = (opt: string): string => name(node.origin[opt] ?? file);
    if (node.options.strict !== true) {
      problems.push(
        `${at("strict")}: compilerOptions.strict must be true (it is ${JSON.stringify(node.options.strict ?? null)}), ${DOC}`,
      );
    }
    if (node.options.verbatimModuleSyntax !== true) {
      problems.push(
        `${at("verbatimModuleSyntax")}: compilerOptions.verbatimModuleSyntax must be true (it is ${JSON.stringify(node.options.verbatimModuleSyntax ?? null)}), ${DOC}`,
      );
    }
    if (node.options.noImplicitAny === false) {
      problems.push(`${at("noImplicitAny")}: compilerOptions.noImplicitAny must not be false, ${DOC}`);
    }
  }
  return problems;
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
      if (!SKIP_DIRS.has(name)) walk(p, out);
    } else if (SOURCE_RE.test(name)) {
      out.push(p);
    }
  }
}

/** Every explicit `any` type annotation under web/src and web/e2e (generated files skipped). */
export function findAnyUses(webRoot: string): AnyUse[] {
  const files: string[] = [];
  for (const d of SCAN_DIRS) if (existsSync(join(webRoot, d))) walk(join(webRoot, d), files);
  const hits: AnyUse[] = [];
  for (const f of files.sort()) {
    const src = readFileSync(f, "utf8");
    if (isGenerated(webRoot, f, src)) continue;
    const kind = f.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    const sf = ts.createSourceFile(f, src, ts.ScriptTarget.Latest, true, kind);
    const lines = src.split("\n");
    const visit = (n: ts.Node): void => {
      if (n.kind === ts.SyntaxKind.AnyKeyword) {
        const line = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line;
        hits.push({
          file: relative(webRoot, f).split(sep).join("/"),
          line: line + 1,
          text: (lines[line] ?? "").trim(),
        });
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return hits;
}

export function describeAny(v: AnyUse): string {
  return `web/${v.file}:${v.line} uses the explicit type \`any\` (\`${v.text}\`). Use \`unknown\` and narrow it, or a precise type; ${DOC}`;
}

export function findScriptProblem(webRoot: string): string | null {
  const file = ["package.json", "package.json.tmpl"].map((n) => join(webRoot, n)).find((p) => existsSync(p));
  if (!file) return `web/package.json is missing, ${DOC}`;
  const scripts = (JSON.parse(readFileSync(file, "utf8")) as { scripts?: Record<string, string> }).scripts ?? {};
  return scripts.typecheck ? null : `web/package.json has no "typecheck" script (tsc --noEmit); ${DOC}`;
}

describe("TypeScript strictness (WEB-24)", () => {
  it("tsconfig is strict with verbatimModuleSyntax", () => {
    expect(findConfigProblems(WEB_ROOT), findConfigProblems(WEB_ROOT).join("\n")).toEqual([]);
  });

  it("web/src and web/e2e use no explicit any", () => {
    const hits = findAnyUses(WEB_ROOT).map(describeAny);
    expect(hits, hits.join("\n")).toEqual([]);
  });

  it("package.json has a typecheck script", () => {
    expect(findScriptProblem(WEB_ROOT), `${findScriptProblem(WEB_ROOT)}`).toBeNull();
  });
});

describe("TypeScript strictness fixtures", () => {
  function fixture(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), "ts-strict-"));
    for (const [name, body] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, name)), { recursive: true });
      writeFileSync(join(dir, name), body);
    }
    return dir;
  }
  function withFixture<T>(files: Record<string, string>, fn: (dir: string) => T): T {
    const dir = fixture(files);
    try {
      return fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  const GOOD = '{ "compilerOptions": { "strict": true, "verbatimModuleSyntax": true } }';

  it("accepts a strict config, with comments and trailing commas", () => {
    const body = '// c\n{ /* x */ "compilerOptions": { "strict": true, "verbatimModuleSyntax": true, }, }';
    expect(withFixture({ "tsconfig.json": body }, findConfigProblems)).toEqual([]);
  });

  it("names the file and option when strict or verbatimModuleSyntax is missing", () => {
    const p = withFixture({ "tsconfig.json": '{ "compilerOptions": { "target": "ES2023" } }' }, findConfigProblems);
    expect(p).toHaveLength(2);
    expect(p[0]).toContain("web/tsconfig.json: compilerOptions.strict must be true");
    expect(p[1]).toContain("verbatimModuleSyntax must be true");
    expect(p.every((m) => m.endsWith("see docs/web-ui.md"))).toBe(true);
  });

  it("rejects strict false and noImplicitAny false", () => {
    const body = '{ "compilerOptions": { "strict": false, "verbatimModuleSyntax": true, "noImplicitAny": false } }';
    const p = withFixture({ "tsconfig.json": body }, findConfigProblems);
    expect(p.join("\n")).toContain("strict must be true (it is false)");
    expect(p.join("\n")).toContain("noImplicitAny must not be false");
  });

  it("follows references and extends, and names the weak referenced file", () => {
    const files = {
      "tsconfig.json":
        '{ "files": [], "references": [{ "path": "./tsconfig.app.json" }, { "path": "./tsconfig.node.json" }] }',
      "tsconfig.base.json": GOOD,
      "tsconfig.app.json": '{ "extends": "./tsconfig.base.json", "compilerOptions": { "jsx": "react-jsx" } }',
      "tsconfig.node.json": '{ "compilerOptions": { "strict": true } }',
    };
    const p = withFixture(files, findConfigProblems);
    expect(p).toHaveLength(1);
    expect(p[0]).toContain("web/tsconfig.node.json: compilerOptions.verbatimModuleSyntax");
  });

  it("lets a child override an inherited option and names the overriding file", () => {
    const files = {
      "tsconfig.json": '{ "extends": "./base.json", "compilerOptions": { "strict": false } }',
      "base.json": GOOD,
    };
    const p = withFixture(files, findConfigProblems);
    expect(p).toHaveLength(1);
    expect(p[0]).toContain("web/tsconfig.json: compilerOptions.strict");
  });

  it("fails when tsconfig.json is missing", () => {
    expect(withFixture({ "x.txt": "" }, findConfigProblems)[0]).toContain("tsconfig.json is missing");
  });

  const SRC_BAD = [
    "export const a: any = 1;",
    "export const b = 1 as any;",
    "export const c = <any>1;",
    "export const d: any[] = [];",
    "export const e: Array<any> = [];",
    "export const f: Promise<any> = Promise.resolve(1);",
    "export const g: Record<string, any> = {};",
    "export const h: Map<string, Set<any>> = new Map();",
    "export function i(x: any): void {}",
  ];

  it("flags every explicit any form with its line", () => {
    const hits = withFixture({ "src/bad.ts": SRC_BAD.join("\n") }, findAnyUses);
    expect(hits.map((h) => h.line)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(hits[0]?.file).toBe("src/bad.ts");
    expect(describeAny(hits[0] as AnyUse)).toMatch(
      /^web\/src\/bad\.ts:1 .*use `unknown` and narrow it, or a precise type; see docs\/web-ui\.md$/i,
    );
  });

  it("scans tsx and e2e too", () => {
    const hits = withFixture(
      { "src/x.tsx": "export const X = (p: { a: any }) => <b>{p.a}</b>;", "e2e/s.spec.ts": "let z: any;" },
      findAnyUses,
    );
    expect(hits.map((h) => h.file).sort()).toEqual(["e2e/s.spec.ts", "src/x.tsx"]);
  });

  it("accepts unknown, identifiers, strings, comments and templates containing any", () => {
    const src = [
      "// any any: any",
      "/* as any */",
      "export const company: unknown = 'any';",
      'export const s = "x: any";',
      "export const t = `Promise<any> ${1}`;",
      "export const many = (anyone: string[]) => anyone;",
      "export type Anything = { any: number };",
    ].join("\n");
    expect(withFixture({ "src/ok.ts": src }, findAnyUses)).toEqual([]);
  });

  it("ignores generated files", () => {
    const files = {
      "src/api/schema.d.ts": "export type A = any;",
      "src/api/other.d.ts": "export type A = any;",
      "src/routeTree.gen.ts": "export const a: any = 1;",
      "src/marked.ts": "// DO NOT EDIT\nexport const a: any = 1;",
      "src/marked2.ts": "/* generated by tool */\nexport const a: any = 1;",
      "src/real.ts": "export const a: any = 1;",
    };
    expect(withFixture(files, findAnyUses).map((h) => h.file)).toEqual(["src/real.ts"]);
  });

  it("checks the typecheck script", () => {
    expect(
      withFixture({ "package.json": '{ "scripts": { "typecheck": "tsc --noEmit" } }' }, findScriptProblem),
    ).toBeNull();
    expect(withFixture({ "package.json": '{ "scripts": {} }' }, findScriptProblem)).toContain("typecheck");
  });
});
