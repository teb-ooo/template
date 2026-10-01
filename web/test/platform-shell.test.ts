/**
 * The playground's shell test (contract: docs/shell.md in the shared brain; there is no rule number for it, the closed components and this test enforce it).
 *
 * Playground-owned (listed in .playground-files). Every app mounts the platform's one top bar and one command palette
 * through `Shell` from "@teb-ooo/ui" and does nothing of its own with them. Through the TypeScript parser it scans every
 * .ts/.tsx/.js/.jsx/.mjs file under `web/src` (not test files, not generated files) and fails when:
 *
 *   a. no file renders `<Shell` imported from "@teb-ooo/ui" (and, when `src/routes/__root.tsx` exists, that file must).
 *   b. a `<Shell` gets a `header` prop (the attribute, or a spread of an object literal that has a `header` key).
 *   c. a `<Shell` is not inside a `<CommandProvider` (imported from "@teb-ooo/ui/cmdk") in the same file.
 *   d. any file uses `useFeedback`, `useFeedbackCommand` or `FeedbackPanel` (imported from @teb-ooo/*, or rendered or
 *      called by that name): the shell registers Send feedback and owns the panel.
 *   e. any file imports `CommandTrigger` (the bar has the trigger).
 *   f. the root route file (`src/routes/__root.tsx`, or the file that calls createRootRoute / createRootRouteWithContext)
 *      renders a `<header` element of its own.
 *
 * To fix a failure, in `src/routes/__root.tsx`: render `<CommandProvider><Shell sidebar={...}>...</Shell></CommandProvider>`
 * with no header prop; delete your own header, the staging chip, the palette trigger, sign in and sign out, and the feedback
 * hook, command and panel (the bar and the platform commands do all of that); put app-specific links in the sidebar, the page
 * or a Cmd+K command (`useRegisterCommands`). The upgrade steps are in docs/shell.md and in the @teb-ooo/ui docs
 * (components.md, "Upgrading an app to 0.23").
 */
import { describe, expect, it } from "vitest";
import ts from "typescript";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = join(here, "..");
const DOC = "see docs/shell.md";
const ROOT_FILE = "src/routes/__root.tsx";

const SKIP_DIRS = new Set(["node_modules", "dist", "generated"]);
const SOURCE_RE = /\.(ts|tsx|js|jsx|mjs)$/;
const TEST_RE = /\.(test|spec)\.[a-z]+$/;
const UI = "@teb-ooo/ui";
const CMDK = "@teb-ooo/ui/cmdk";
const FEEDBACK = new Set(["useFeedback", "useFeedbackCommand", "FeedbackPanel"]);

export interface Violation {
  /** a to f, as in the header comment */
  check: "a" | "b" | "c" | "d" | "e" | "f";
  file: string;
  line: number;
  what: string;
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
    } else if (SOURCE_RE.test(name) && !TEST_RE.test(name) && !name.endsWith(".d.ts")) {
      out.push(p);
    }
  }
}

/** Local names bound by imports from `module`: `named` maps the local name to the exported name; `namespaces` are `* as X` / default names. */
function importsFrom(sf: ts.SourceFile, match: (module: string) => boolean): { named: Map<string, string>; namespaces: Set<string> } {
  const named = new Map<string, string>();
  const namespaces = new Set<string>();
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier) || !match(st.moduleSpecifier.text)) continue;
    const clause = st.importClause;
    if (!clause) continue;
    if (clause.name) namespaces.add(clause.name.text);
    const b = clause.namedBindings;
    if (b && ts.isNamespaceImport(b)) namespaces.add(b.name.text);
    if (b && ts.isNamedImports(b)) for (const e of b.elements) named.set(e.name.text, (e.propertyName ?? e.name).text);
  }
  return { named, namespaces };
}

type JsxTag = ts.JsxOpeningElement | ts.JsxSelfClosingElement;

/** The exported name a JSX tag refers to when it comes from `imports` (`<Shell>`, `<S>` for `Shell as S`, `<UI.Shell>`), else null. */
function tagExport(tag: ts.JsxTagNameExpression, imports: { named: Map<string, string>; namespaces: Set<string> }): string | null {
  if (ts.isIdentifier(tag)) return imports.named.get(tag.text) ?? null;
  if (ts.isPropertyAccessExpression(tag) && ts.isIdentifier(tag.expression) && imports.namespaces.has(tag.expression.text)) return tag.name.text;
  return null;
}

function elementOf(n: ts.Node): JsxTag | null {
  if (ts.isJsxSelfClosingElement(n)) return n;
  if (ts.isJsxElement(n)) return n.openingElement;
  return null;
}

/** Every violation under `<webRoot>/src`. */
export function findViolations(webRoot: string): Violation[] {
  const files: string[] = [];
  if (existsSync(join(webRoot, "src"))) walk(join(webRoot, "src"), files);
  const out: Violation[] = [];
  const rendersShell = new Set<string>();

  for (const f of files.sort()) {
    const src = readFileSync(f, "utf8");
    if (isGenerated(webRoot, f, src)) continue;
    const rel = relative(webRoot, f).split(sep).join("/");
    const kind = f.endsWith("x") ? ts.ScriptKind.TSX : f.endsWith(".ts") ? ts.ScriptKind.TS : ts.ScriptKind.JS;
    const sf = ts.createSourceFile(f, src, ts.ScriptTarget.Latest, true, kind);
    const add = (check: Violation["check"], n: ts.Node, what: string) =>
      out.push({ check, file: rel, line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1, what });

    const ui = importsFrom(sf, (m) => m === UI);
    const cmdk = importsFrom(sf, (m) => m === CMDK);
    const anyTeb = importsFrom(sf, (m) => m === UI || m.startsWith(`${UI}/`) || m === "@teb-ooo/web" || m.startsWith("@teb-ooo/web/"));
    const callsRootRoute = /\bcreateRootRoute(WithContext)?\b/.test(src);
    const isRoot = rel === ROOT_FILE || callsRootRoute;

    // (e) CommandTrigger imported from any @teb-ooo/ui entry; (d) the feedback trio imported from @teb-ooo/*.
    for (const st of sf.statements) {
      if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
      const m = st.moduleSpecifier.text;
      if (!(m === UI || m.startsWith(`${UI}/`) || m === "@teb-ooo/web" || m.startsWith("@teb-ooo/web/") || m === "@teb-ooo/cmdk")) continue;
      const b = st.importClause?.namedBindings;
      if (!b || !ts.isNamedImports(b)) continue;
      for (const e of b.elements) {
        const name = (e.propertyName ?? e.name).text;
        if (name === "CommandTrigger") add("e", e, "imports CommandTrigger");
        if (FEEDBACK.has(name)) add("d", e, `imports ${name}`);
      }
    }

    const visit = (n: ts.Node): void => {
      const el = elementOf(n);
      if (el) {
        const name = tagExport(el.tagName, ui);
        // (b), (c): every Shell element.
        if (name === "Shell") {
          rendersShell.add(rel);
          for (const a of el.attributes.properties) {
            if (ts.isJsxAttribute(a) && ts.isIdentifier(a.name) && a.name.text === "header") add("b", a, "passes a header prop to Shell");
            if (ts.isJsxSpreadAttribute(a) && ts.isObjectLiteralExpression(a.expression)) {
              for (const p of a.expression.properties) {
                if ((ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) && p.name.getText(sf).replace(/^["']|["']$/g, "") === "header") {
                  add("b", p, "passes a header prop to Shell (spread)");
                }
              }
            }
          }
          let wrapped = false;
          for (let p: ts.Node | undefined = n.parent; p; p = p.parent) {
            if (ts.isJsxElement(p) && tagExport(p.openingElement.tagName, cmdk) === "CommandProvider") wrapped = true;
          }
          if (!wrapped) add("c", n, "Shell is not inside CommandProvider (from @teb-ooo/ui/cmdk) in this file");
        }
        // (d) the feedback panel rendered by its name, even when it is defined elsewhere.
        const t = el.tagName;
        const tn = ts.isIdentifier(t) ? t.text : null;
        if (tn && FEEDBACK.has(anyTeb.named.get(tn) ?? tn)) add("d", n, `renders ${anyTeb.named.get(tn) ?? tn}`);
        // (f) the root route file renders its own header.
        if (isRoot && ts.isIdentifier(t) && t.text === "header") add("f", n, "the root route renders its own <header");
      }
      // (d) the hooks called by name.
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) {
        const called = anyTeb.named.get(n.expression.text) ?? n.expression.text;
        if (FEEDBACK.has(called) && called !== "FeedbackPanel") add("d", n, `calls ${called}`);
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }

  // (a): the route root renders Shell.
  const rootPath = join(webRoot, ROOT_FILE);
  if (existsSync(rootPath)) {
    if (!rendersShell.has(ROOT_FILE)) out.push({ check: "a", file: ROOT_FILE, line: 1, what: `does not render <Shell> imported from "${UI}"` });
  } else if (files.length > 0 && rendersShell.size === 0) {
    out.push({ check: "a", file: "src", line: 1, what: `no file renders <Shell> imported from "${UI}" (and ${ROOT_FILE} is missing)` });
  }
  return out;
}

const ADVICE: Record<Violation["check"], string> = {
  a: `render the platform shell at the route root: <CommandProvider><Shell sidebar={...}>...</Shell></CommandProvider>, Shell from "${UI}"`,
  b: "delete the header prop: Shell is closed, its bar is the platform's; app-specific links go in the sidebar, the page or a Cmd+K command",
  c: `wrap Shell in <CommandProvider> from "${CMDK}" in the same JSX tree, inside the router and the query provider`,
  d: "delete it: the Shell registers Send feedback in Cmd+K (owner only) and owns the feedback panel",
  e: "delete it: the bar has the Cmd+K trigger",
  f: "delete your own header and everything it held; the Shell draws the one platform bar",
};

export function describeViolation(v: Violation): string {
  return `web/${v.file}:${v.line}: ${v.what}. To fix: ${ADVICE[v.check]}; ${DOC}`;
}

describe("the app uses the platform shell", () => {
  it("web/src renders Shell with no header, inside CommandProvider, with no feedback hooks, no trigger and no own header", () => {
    const hits = findViolations(WEB_ROOT).map(describeViolation);
    expect(hits, hits.join("\n")).toEqual([]);
  });
});

describe("the shell checker", () => {
  function run(files: Record<string, string>): Violation[] {
    const dir = mkdtempSync(join(tmpdir(), "platform-shell-"));
    try {
      for (const [name, body] of Object.entries(files)) {
        mkdirSync(dirname(join(dir, name)), { recursive: true });
        writeFileSync(join(dir, name), body);
      }
      return findViolations(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  const at = (hits: Violation[]) => hits.map((h) => `${h.check}:${h.file}:${h.line}`);

  const GOOD = [
    'import { createRootRouteWithContext, Outlet } from "@tanstack/react-router";',
    'import { CommandProvider } from "@teb-ooo/ui/cmdk";',
    'import { Shell } from "@teb-ooo/ui";',
    "export const Route = createRootRouteWithContext()({ component: Root });",
    "function Root() {",
    "  return (",
    "    <CommandProvider>",
    "      <Shell sidebar={<nav />}>",
    "        <Outlet />",
    "      </Shell>",
    "    </CommandProvider>",
    "  );",
    "}",
    "",
  ].join("\n");

  it("accepts the template's root, an aliased Shell, a namespace import and ignored files", () => {
    expect(run({ "src/routes/__root.tsx": GOOD })).toEqual([]);
    expect(
      run({
        "src/routes/__root.tsx": GOOD.replace('import { Shell } from "@teb-ooo/ui";', 'import { Shell as Frame } from "@teb-ooo/ui";').replace("<Shell", "<Frame").replace("</Shell>", "</Frame>"),
      }),
    ).toEqual([]);
    expect(
      run({
        "src/routes/__root.tsx": GOOD.replace('import { Shell } from "@teb-ooo/ui";', 'import * as UI from "@teb-ooo/ui";').replace("<Shell", "<UI.Shell").replace("</Shell>", "</UI.Shell>"),
        // a header in a page, a word in a comment or a string, and test and generated files are not the root layout
        "src/routes/index.tsx": 'import { Heading } from "@teb-ooo/ui";\n// useFeedback and <Shell header={x}> are banned\nconst s = "FeedbackPanel";\nexport const P = () => <header>page</header>;\n',
        "src/app.test.tsx": 'import { CommandTrigger } from "@teb-ooo/ui/cmdk";\n',
        "src/routeTree.gen.ts": "/* eslint-disable */\n// generated\nuseFeedback();\n",
      }),
    ).toEqual([]);
  });

  it("(a) fails a root that does not render Shell, and an app with no Shell at all", () => {
    expect(at(run({ "src/routes/__root.tsx": 'export const Route = 1;\nconst x = <div />;\n' }))).toEqual(["a:src/routes/__root.tsx:1"]);
    expect(at(run({ "src/routes/__root.tsx": 'import { Shell } from "./my-shell";\nconst x = <Shell sidebar={1}>a</Shell>;\n' }))).toEqual(["a:src/routes/__root.tsx:1"]);
    expect(at(run({ "src/main.tsx": "export const x = 1;\n" }))).toEqual(["a:src:1"]);
  });

  it("(b) fails a header prop on Shell, also through a spread of an object literal", () => {
    const hits = run({
      "src/routes/__root.tsx": GOOD.replace("<Shell sidebar={<nav />}>", "<Shell sidebar={<nav />} header={<b />}>"),
      "src/other.tsx": GOOD.replace("<Shell sidebar={<nav />}>", "<Shell {...{ sidebar: <nav />, header: <b /> }}>"),
    });
    expect(at(hits)).toEqual(["b:src/other.tsx:8", "b:src/routes/__root.tsx:8"]);
    expect(describeViolation(hits[0]!)).toContain("web/src/other.tsx:8: passes a header prop");
    expect(describeViolation(hits[0]!)).toContain("docs/shell.md");
  });

  it("(c) fails a Shell outside CommandProvider, or with a CommandProvider from another module", () => {
    const bare = GOOD.replace("<CommandProvider>", "<div>").replace("</CommandProvider>", "</div>");
    expect(at(run({ "src/routes/__root.tsx": bare }))).toEqual(["c:src/routes/__root.tsx:8"]);
    const other = GOOD.replace('"@teb-ooo/ui/cmdk"', '"./my-provider"');
    expect(at(run({ "src/routes/__root.tsx": other }))).toEqual(["c:src/routes/__root.tsx:8"]);
  });

  it("(d) fails useFeedback, useFeedbackCommand and FeedbackPanel: import, call and render", () => {
    const hits = run({
      "src/routes/__root.tsx": GOOD.replace('import { Shell } from "@teb-ooo/ui";', 'import { Shell, FeedbackPanel } from "@teb-ooo/ui";\nimport { useFeedback } from "@teb-ooo/web";')
        .replace("function Root() {", "function Root() {\n  const fb = useFeedback();")
        .replace("<Outlet />", "<Outlet /><FeedbackPanel feedback={fb} />"),
      "src/x.ts": 'import { useFeedbackCommand as cmd } from "@teb-ooo/ui/cmdk";\ncmd(1);\n',
    });
    expect(hits.filter((h) => h.check === "d").map((h) => h.what)).toEqual([
      "imports FeedbackPanel",
      "imports useFeedback",
      "calls useFeedback",
      "renders FeedbackPanel",
      "imports useFeedbackCommand",
      "calls useFeedbackCommand",
    ]);
    expect(hits.every((h) => h.check === "d")).toBe(true);
  });

  it("(e) fails CommandTrigger imported from the ui entries", () => {
    expect(at(run({ "src/routes/__root.tsx": GOOD, "src/bar.tsx": 'import { CommandTrigger } from "@teb-ooo/ui/cmdk";\n' }))).toEqual(["e:src/bar.tsx:1"]);
    expect(at(run({ "src/routes/__root.tsx": GOOD, "src/bar.tsx": 'import { CommandTrigger as T } from "@teb-ooo/ui";\n' }))).toEqual(["e:src/bar.tsx:1"]);
  });

  it("(f) fails a <header in the root route file, in a helper component too, and not in other files", () => {
    const own = GOOD.replace("<Outlet />", "<header>x</header><Outlet />");
    expect(at(run({ "src/routes/__root.tsx": own }))).toEqual(["f:src/routes/__root.tsx:9"]);
    const helper = GOOD + "function AppHeader() {\n  return <header>x</header>;\n}\n";
    expect(at(run({ "src/routes/__root.tsx": helper }))).toEqual(["f:src/routes/__root.tsx:15"]);
    expect(at(run({ "src/routes/__root.tsx": GOOD, "src/routes/page.tsx": "export const P = () => <header>x</header>;\n" }))).toEqual([]);
  });
});
