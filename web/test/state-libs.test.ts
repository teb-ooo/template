/**
 * The playground's client-state test (rule WEB-16: server state lives in TanStack Query and nowhere else, client-only state
 * stays local to a component, no global store).
 *
 * Playground-owned (listed in .playground-files). It fails on
 *  - a state or data-fetching library in package.json (dependencies, devDependencies, peerDependencies, optionalDependencies):
 *    redux, @reduxjs/toolkit, react-redux, zustand, jotai, recoil, mobx, mobx-react, mobx-react-lite, valtio, swr, nanostores,
 *    @tanstack/store, @tanstack/react-store and axios;
 *  - an import, export-from, dynamic import or require of one of them (or a subpath such as `zustand/middleware`) in a
 *    .ts/.tsx/.js/.jsx/.mjs file under `web/src`, found through the TypeScript parser, so comments and strings never match.
 * React context is allowed. Generated files are skipped (`schema.d.ts`, `routeTree.gen.ts`, `.d.ts` under `src/api/`, files
 * that say "generated" or "DO NOT EDIT" at the top). There is no escape. Raw `fetch` is WEB-17's business (no-raw-fetch.test.ts).
 * That server state is not hidden in a module variable or a context is a judgement the test cannot make.
 *
 * To fix a failure: remove the library; read server data with the generated hooks (`api.useQuery("get", "/api/items")`),
 * keep UI state in `useState`/`useReducer` in the component that owns it, and lift it to a small React context only for a subtree.
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

const BANNED: Record<string, string> = {
  redux: "a global store",
  "@reduxjs/toolkit": "a global store",
  "react-redux": "a global store",
  zustand: "a global store",
  jotai: "a global store",
  recoil: "a global store",
  mobx: "a global store",
  "mobx-react": "a global store",
  "mobx-react-lite": "a global store",
  valtio: "a global store",
  nanostores: "a global store",
  "@tanstack/store": "a global store",
  "@tanstack/react-store": "a global store",
  swr: "a second server-state cache next to TanStack Query",
  axios: "a second HTTP client next to the generated hooks",
};
const SCAN_DIRS = ["src"];
const SKIP_DIRS = new Set(["node_modules", "dist", "generated"]);
const SOURCE_RE = /\.(ts|tsx|js|jsx|mjs)$/;
const DEP_SECTIONS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];

export interface Problem {
  file: string;
  line: number;
  lib: string;
  how: string;
}

/** The banned library a module specifier names (a subpath counts), or null. */
export function bannedLib(specifier: string): string | null {
  for (const lib of Object.keys(BANNED)) if (specifier === lib || specifier.startsWith(`${lib}/`)) return lib;
  return null;
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

/** Banned libraries named in web/package.json. */
export function findBannedDeps(webRoot: string): Problem[] {
  const file = ["package.json", "package.json.tmpl"].map((n) => join(webRoot, n)).find((p) => existsSync(p));
  if (!file) return [];
  const pkg = JSON.parse(readFileSync(file, "utf8")) as Record<string, Record<string, string> | undefined>;
  const out: Problem[] = [];
  const text = readFileSync(file, "utf8").split("\n");
  for (const section of DEP_SECTIONS) {
    for (const name of Object.keys(pkg[section] ?? {})) {
      if (!BANNED[name]) continue;
      const idx = text.findIndex((l) => l.includes(`"${name}"`));
      out.push({ file: "package.json", line: idx + 1, lib: name, how: `lists ${name} in ${section}` });
    }
  }
  return out;
}

/** Imports, re-exports, dynamic imports and requires of a banned library under web/src. */
export function findBannedImports(webRoot: string): Problem[] {
  const files: string[] = [];
  for (const d of SCAN_DIRS) if (existsSync(join(webRoot, d))) walk(join(webRoot, d), files);
  const out: Problem[] = [];
  for (const f of files.sort()) {
    const src = readFileSync(f, "utf8");
    if (isGenerated(webRoot, f, src)) continue;
    const kind = f.endsWith("x") ? ts.ScriptKind.TSX : f.endsWith(".ts") ? ts.ScriptKind.TS : ts.ScriptKind.JS;
    const sf = ts.createSourceFile(f, src, ts.ScriptTarget.Latest, true, kind);
    const hit = (n: ts.Node, spec: string, how: string): void => {
      const lib = bannedLib(spec);
      if (lib)
        out.push({
          file: relative(webRoot, f).split(sep).join("/"),
          line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1,
          lib,
          how: `${how} "${spec}"`,
        });
    };
    const visit = (n: ts.Node): void => {
      if (
        (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) &&
        n.moduleSpecifier &&
        ts.isStringLiteralLike(n.moduleSpecifier)
      ) {
        hit(n, n.moduleSpecifier.text, ts.isImportDeclaration(n) ? "imports" : "re-exports from");
      } else if (
        ts.isImportEqualsDeclaration(n) &&
        ts.isExternalModuleReference(n.moduleReference) &&
        ts.isStringLiteralLike(n.moduleReference.expression)
      ) {
        hit(n, n.moduleReference.expression.text, "imports");
      } else if (ts.isCallExpression(n) && n.arguments.length >= 1) {
        const arg = n.arguments[0];
        const callee = n.expression;
        const isRequire = ts.isIdentifier(callee) && callee.text === "require";
        if ((callee.kind === ts.SyntaxKind.ImportKeyword || isRequire) && arg && ts.isStringLiteralLike(arg)) {
          hit(n, arg.text, callee.kind === ts.SyntaxKind.ImportKeyword ? "dynamically imports" : "requires");
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return out;
}

export function describeProblem(p: Problem): string {
  const where = p.file === "package.json" ? `web/package.json:${p.line}` : `web/${p.file}:${p.line}`;
  return (
    `${where}: rule WEB-16: ${p.how}, ${BANNED[p.lib]}. ` +
    `Server state lives in TanStack Query (the generated hooks, api.useQuery("get", "/api/...")) and client-only state stays local to a component ` +
    `(useState, useReducer, a small React context). To fix: remove ${p.lib} (npm uninstall ${p.lib}) and use those; ${DOC}`
  );
}

describe("no state library or second HTTP client (WEB-16)", () => {
  it("package.json lists none", () => {
    const hits = findBannedDeps(WEB_ROOT).map(describeProblem);
    expect(hits, hits.join("\n")).toEqual([]);
  });

  it("web/src imports none", () => {
    const hits = findBannedImports(WEB_ROOT).map(describeProblem);
    expect(hits, hits.join("\n")).toEqual([]);
  });
});

describe("the state-library checker", () => {
  function withTree<T>(files: Record<string, string>, fn: (dir: string) => T): T {
    const dir = mkdtempSync(join(tmpdir(), "state-libs-"));
    try {
      for (const [name, body] of Object.entries(files)) {
        mkdirSync(dirname(join(dir, name)), { recursive: true });
        writeFileSync(join(dir, name), body);
      }
      return fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("accepts React context, TanStack Query, comments and look-alike names", () => {
    const hits = withTree(
      {
        "package.json":
          '{ "dependencies": { "react": "1", "@tanstack/react-query": "1", "swr-like": "1", "reduxish": "1" } }',
        "src/a.tsx":
          'import { createContext, useState } from "react";\nimport { useQuery } from "@tanstack/react-query";\n// import create from "zustand";\nconst s = "import axios from \'axios\'";\nexport const C = createContext(0);\n',
        "src/api/schema.d.ts": 'import x from "zustand";\n',
        "src/routeTree.gen.ts": 'import x from "zustand";\n',
      },
      (d) => [...findBannedDeps(d), ...findBannedImports(d)],
    );
    expect(hits).toEqual([]);
  });

  it("rejects every banned library in package.json, naming the line", () => {
    const body =
      '{\n  "dependencies": {\n    "zustand": "5",\n    "axios": "1"\n  },\n  "devDependencies": { "@reduxjs/toolkit": "2", "swr": "2", "jotai": "2", "recoil": "1", "mobx": "6", "valtio": "1", "redux": "5" }\n}';
    const hits = withTree({ "package.json": body }, findBannedDeps);
    expect(hits.map((h) => h.lib).sort()).toEqual([
      "@reduxjs/toolkit",
      "axios",
      "jotai",
      "mobx",
      "recoil",
      "redux",
      "swr",
      "valtio",
      "zustand",
    ]);
    expect(hits.find((h) => h.lib === "zustand")?.line).toBe(3);
    const msg = describeProblem(hits.find((h) => h.lib === "zustand")!);
    expect(msg).toContain("web/package.json:3: rule WEB-16");
    expect(msg).toContain("TanStack Query");
    expect(msg.endsWith("see docs/web-ui.md")).toBe(true);
  });

  it("rejects imports, re-exports, dynamic imports, requires and subpaths with file and line", () => {
    const hits = withTree(
      {
        "src/a.ts": 'import { create } from "zustand";\n',
        "src/b.tsx": '\nimport { atom } from "jotai/utils";\n',
        "src/c.ts": 'export * from "redux";\n',
        "src/d.ts": 'const x = await import("swr");\n',
        "src/e.js": 'const a = require("axios");\n',
        "src/deep/f.ts": 'import axios = require("axios");\n',
      },
      findBannedImports,
    );
    expect(hits.map((h) => `${h.file}:${h.line}:${h.lib}`)).toEqual([
      "src/a.ts:1:zustand",
      "src/b.tsx:2:jotai",
      "src/c.ts:1:redux",
      "src/d.ts:1:swr",
      "src/deep/f.ts:1:axios",
      "src/e.js:1:axios",
    ]);
    const msg = describeProblem(hits[0]!);
    expect(msg).toContain('web/src/a.ts:1: rule WEB-16: imports "zustand"');
    expect(msg.endsWith("see docs/web-ui.md")).toBe(true);
  });

  it("does not scan e2e or test directories", () => {
    expect(
      withTree(
        { "e2e/a.ts": 'import x from "axios";\n', "test/b.ts": 'import x from "zustand";\n' },
        findBannedImports,
      ),
    ).toEqual([]);
  });
});
