/**
 * The playground's design-language test.
 *
 * Copy-ready: the same file lives at `lib/ui-lib/test/design.test.ts` and at an app's `web/test/design.test.ts`.
 * It scans every .ts/.tsx/.css file under `../src` (relative to this file) and fails on anything that steps
 * outside the design system: one typeface, one body size, one display size, one radius, semantic tokens only.
 *
 * Inside the @teb-ooo/ui package (detected through ../package.json) `../theme.css` is also scanned, and it is
 * the ONE file allowed to name palette values. In an app the one file allowed to name colours directly (palette steps
 * such as rose-500, hex and colour functions, neutral-) is `web/src/colors.css`, matched by its exact path; every other
 * file, including another `colors.css` anywhere else, uses semantic tokens.
 */
import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(here, "..");
const SRC = join(PACKAGE_ROOT, "src");

function readPackageName(): string | null {
  try {
    const pkg = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")) as { name?: string };
    return pkg.name ?? null;
  } catch {
    return null;
  }
}

const IS_UI_PACKAGE = readPackageName() === "@teb-ooo/ui";
/** The only file that may name palette values, and only inside the ui package. */
const THEME_FILE = "theme.css";
const THEME_PATH = join(PACKAGE_ROOT, THEME_FILE);

/** In an app: the one file (path relative to web/, exact match) that may name colours directly. */
const COLORS_FILE = "src/colors.css";

const SKIP_DIRS = new Set(["node_modules", "generated"]);

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (!SKIP_DIRS.has(name)) walk(p, out);
    } else if (/\.(ts|tsx|css)$/.test(name) && !/\.d\.ts$/.test(name) && !/\.test\.tsx?$/.test(name)) {
      out.push(p);
    }
  }
}

function sourceFiles(): string[] {
  const out: string[] = [];
  if (existsSync(SRC)) walk(SRC, out);
  if (IS_UI_PACKAGE && existsSync(THEME_PATH)) out.push(THEME_PATH);
  return out;
}

const files = sourceFiles();
const isTheme = (f: string): boolean => IS_UI_PACKAGE && f === THEME_PATH;
const isComponentSource = (f: string): boolean =>
  IS_UI_PACKAGE && f.includes(`${sep}components${sep}`) && !/\.stories\.tsx$/.test(f);
const shown = (f: string): string => relative(PACKAGE_ROOT, f);
/** Exact, path-relative match: `web/src/colors.css` only (not a prefix, a glob, or a nested or renamed file). */
const allowsColours = (rel: string, isUiPackage: boolean): boolean =>
  !isUiPackage && rel.split(sep).join("/") === COLORS_FILE;
const isColours = (f: string): boolean => allowsColours(shown(f), IS_UI_PACKAGE);

interface Hit {
  file: string;
  line: number;
  text: string;
}

function find(re: RegExp, opts: { skip?: (f: string) => boolean; lineFilter?: (line: string) => boolean } = {}): Hit[] {
  const hits: Hit[] = [];
  for (const f of files) {
    if (opts.skip?.(f)) continue;
    const lines = readFileSync(f, "utf8").split("\n");
    lines.forEach((text, i) => {
      if (opts.lineFilter && !opts.lineFilter(text)) return;
      const m = re.exec(text);
      if (m) hits.push({ file: shown(f), line: i + 1, text: m[0] });
    });
  }
  return hits;
}

function expectNone(hits: Hit[], why: string): void {
  expect(
    hits.map((h) => `${h.file}:${h.line}: "${h.text}"`),
    why,
  ).toEqual([]);
}

const skipColours = (f: string): boolean => isTheme(f) || isColours(f);

const PALETTES = "stone|neutral|gray|zinc|slate|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose";

describe("design language", () => {
  it("scans something", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it("uses only the one radius: no rounded-full/lg/xl/2xl/3xl", () => {
    expectNone(find(/\brounded-(full|lg|xl|2xl|3xl)\b/), "use plain `rounded`: one radius");
  });

  it("uses no Tailwind text-size utility (there are two sizes: body via <body>, display via .display-lg)", () => {
    expectNone(
      find(/(?<![-\w])text-(xs|sm|base|lg|xl|[2-9]xl|body|display)\b/),
      "components never set a font size; use the .display-lg class for titles",
    );
    expectNone(find(/(?<![-\w])text-\[(length:)?[\d.]+[a-z%]*\]/), "no arbitrary text sizes");
  });

  it("declares no font-size outside theme.css", () => {
    expectNone(find(/\bfont-size\s*:|\bfontSize\s*:/, { skip: isTheme }), "font sizes belong to theme.css only");
  });

  it("has no weight utility anywhere: the only heavier weight lives in the .display-lg class of theme.css", () => {
    expectNone(
      find(/(?<![-\w])font-(bold|semibold|medium|extrabold|black|light|extralight|thin)\b/),
      "hierarchy is colour; titles use .display-lg",
    );
    expectNone(find(/\bfont-weight\s*:|\bfontWeight\s*:/, { skip: isTheme }), "font weights belong to theme.css only");
  });

  it("declares no font-family outside theme.css: one typeface, through the tokens", () => {
    expectNone(find(/\bfont-family\s*:|\bfontFamily\s*:/, { skip: isTheme }), "the font comes from --font-sans and --font-mono");
    expectNone(find(/(?<![-\w])font-(serif|display)\b(?!\s*:)/), "no second typeface");
  });

  it("uses no neutral- scale, no important, and no near-white text steps", () => {
    expectNone(find(/neutral-/, { skip: isColours }), "the neutrals are semantic tokens (ink, ink-muted, ink-faint)");
    expectNone(find(/!important/), "no !important");
    expectNone(find(/text-(neutral|stone)-(100|200)\b/, { skip: isColours }), "use text-ink");
  });

  it("has no dark: variants: tokens carry both themes", () => {
    expectNone(find(/(?<![-\w])dark:/), "components never branch on the theme");
  });

  it("has no theme control: no theme storage and no data-theme assignment (apps follow prefers-color-scheme)", () => {
    expectNone(
      find(/\b(?:local|session)Storage\b[^\n]*(?:theme|color-scheme|prefers)|(?:theme|color-scheme|prefers)[^\n]*\b(?:local|session)Storage\b/i),
      "no stored theme preference",
    );
    expectNone(
      find(/\bsetAttribute\(\s*["'`]data-theme|\bdataset\.theme\b|\bdata-theme\s*=|\[["']data-theme["']\]\s*=/, { skip: isTheme }),
      "only a gallery forces a theme; components and apps never set data-theme",
    );
    expectNone(find(/\bmatchMedia\([^)]*prefers-color-scheme/), "no JS theming: the CSS follows the OS by itself");
  });

  it("has no raw <button outside component sources", () => {
    expectNone(find(/<button\b/, { skip: isComponentSource }), "use Button (or LinkButton for navigation)");
  });

  it("puts no title attribute on a control (use the tip prop / Tooltip)", () => {
    const hits: Hit[] = [];
    const re = /<(Button|LinkButton|Input|Link|button|a|input|select|textarea)\b[^<]*?\btitle\s*=/;
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      const m = re.exec(src);
      if (m) hits.push({ file: shown(f), line: src.slice(0, m.index).split("\n").length, text: m[0].slice(0, 60) });
    }
    expectNone(hits, "native title tooltips are banned; use tip");
  });

  it("names no palette step in any file except theme.css and web/src/colors.css", () => {
    expectNone(
      find(new RegExp(`(?<!\\w)(${PALETTES})-\\d{2,3}\\b`), { skip: skipColours }),
      "use semantic tokens (bg-surface, text-ink-muted, border-line, text-danger, ...)",
    );
  });

  it("has no hex, rgb, hsl or oklch literal in any file except theme.css and web/src/colors.css", () => {
    expectNone(find(/(?<![\w&#])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/, { skip: skipColours }), "no hex literals");
    expectNone(find(/\b(?:oklch|oklab|lab|lch|rgba?|hsla?)\(/, { skip: skipColours }), "no colour functions");
  });

  it("mentions no other product by name", () => {
    const names = /\b(lore|ory|kratos|hydra|resend|postmark|pocket-?id|tiptap)\b/i;
    expectNone(find(names), "nothing shipped names another product");
    if (IS_UI_PACKAGE) {
      const extra = ["README.md", "package.json", "theme-init.js", ...listDir("docs", /\.md$/), ...listDir("email", /./)];
      const hits: Hit[] = [];
      for (const rel of extra) {
        const p = join(PACKAGE_ROOT, rel);
        if (!existsSync(p)) continue;
        readFileSync(p, "utf8")
          .split("\n")
          .forEach((text, i) => {
            const m = names.exec(text);
            if (m) hits.push({ file: rel, line: i + 1, text: m[0] });
          });
      }
      expectNone(hits, "package files name no other product");
    }
  });
});

/** The colour rules, applied to files given as {path relative to web/, text}: the same regexes as above. */
function colourHits(entries: { rel: string; text: string }[], isUiPackage = false): string[] {
  const palette = new RegExp(`(?<!\\w)(${PALETTES})-\\d{2,3}\\b`);
  const rules = [palette, /neutral-/, /(?<![\w&#])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/, /\b(?:oklch|oklab|lab|lch|rgba?|hsla?)\(/];
  return entries.flatMap((e) =>
    allowsColours(e.rel, isUiPackage) ? [] : rules.filter((re) => re.test(e.text)).map(() => e.rel),
  );
}

describe("direct colours are allowed in web/src/colors.css only", () => {
  const sample = ":root { --brand: var(--color-rose-500); --x: oklch(0.6 0.2 20); --y: #ff0000; } .a { color: neutral-500; }\n.b { @apply bg-rose-500; }";
  const at = (rel: string, text = sample): string[] => colourHits([{ rel, text }]);

  it("passes a palette name, hex, colour function and neutral- in web/src/colors.css", () => {
    expect(at("src/colors.css")).toEqual([]);
    expect(at(["src", "colors.css"].join(sep))).toEqual([]);
  });

  it("fails the same text in a .tsx, another .css, a nested colors.css and look-alike names", () => {
    for (const rel of ["src/Card.tsx", "src/index.css", "src/x/colors.css", "src/colors.css.bak", "src/Colors.css", "src/mycolors.css", "colors.css", "src/colors.ts"]) {
      expect(at(rel).length, rel).toBeGreaterThan(0);
    }
  });

  it("keeps semantic names and ramp utilities passing everywhere", () => {
    const ok = 'className="bg-surface text-ink-muted border-line text-danger bg-danger-100 text-accent-700"';
    expect(at("src/Card.tsx", ok)).toEqual([]);
    expect(at("src/colors.css", ok)).toEqual([]);
  });

  it("does not apply inside the ui package", () => {
    expect(colourHits([{ rel: "src/colors.css", text: sample }], true).length).toBeGreaterThan(0);
  });

  it("scans a real tree: colors.css passes, nested colors.css and .tsx fail", () => {
    const dir = mkdtempSync(join(tmpdir(), "design-"));
    try {
      const write = (rel: string): void => {
        mkdirSync(dirname(join(dir, rel)), { recursive: true });
        writeFileSync(join(dir, rel), "a { color: var(--color-rose-500); }\n");
      };
      for (const rel of ["src/colors.css", "src/x/colors.css", "src/App.tsx", "src/other.css"]) write(rel);
      const found: string[] = [];
      walk(join(dir, "src"), found);
      const entries = found.map((f) => ({ rel: relative(dir, f), text: readFileSync(f, "utf8") }));
      expect([...new Set(colourHits(entries))].sort()).toEqual([join("src", "App.tsx"), join("src", "other.css"), join("src", "x", "colors.css")].sort());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function listDir(rel: string, pattern: RegExp): string[] {
  const dir = join(PACKAGE_ROOT, rel);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => pattern.test(n) && statSync(join(dir, n)).isFile())
    .map((n) => `${rel}/${n}`);
}

describe.skipIf(!IS_UI_PACKAGE)("theme.css (ui package only)", () => {
  const css = IS_UI_PACKAGE ? readFileSync(THEME_PATH, "utf8") : "";

  it("defines --color-ground as exactly #000000 in dark and #FFFFFF in light", () => {
    const all = [...css.matchAll(/--color-ground:\s*(#[0-9a-fA-F]{6});/g)].map((m) => (m[1] ?? "").toUpperCase());
    expect(all).toContain("#000000");
    expect(all).toContain("#FFFFFF");
    expect(new Set(all)).toEqual(new Set(["#000000", "#FFFFFF"]));
    expect(/@theme static \{\s*--color-ground:\s*#000000;/i.test(css), "dark is the default set").toBe(true);
    expect(/\n\[data-theme="light"\]\s*\{[\s\S]*?--color-ground:\s*#ffffff;/i.test(css), "light under data-theme").toBe(true);
    expect(/prefers-color-scheme: light\)[\s\S]*?--color-ground:\s*#ffffff;/i.test(css), "light under the OS query").toBe(true);
  });

  it("declares exactly two type size tokens: body and display", () => {
    const sizes = [...css.matchAll(/^\s*--text-([a-z0-9]+):\s*[\d.]+rem;/gm)].map((m) => m[1]);
    expect(sizes.sort()).toEqual(["body", "display"]);
    expect(css).toMatch(/--text-body:\s*0\.875rem;/);
    expect(css).toMatch(/--text-body--line-height:\s*1\.6;/);
    expect(css).toMatch(/--text-display:\s*2rem;/);
    expect(css).toMatch(/--text-display--line-height:\s*1\.3;/);
  });

  it("only ever applies those two sizes (or inherits)", () => {
    const uses = [...css.matchAll(/font-size:\s*([^;]+);/g)].map((m) => (m[1] ?? "").trim());
    expect(uses.length).toBeGreaterThan(0);
    for (const u of uses) expect(["var(--text-body)", "var(--text-display)", "inherit"], u).toContain(u);
  });

  it("has one control height, one radius", () => {
    expect(css).toMatch(/--control-h:\s*1\.75rem;/);
    expect(css).toMatch(/--radius:\s*0\.25rem;/);
  });

  it("uses Geist Mono and nothing else: one typeface", () => {
    const stack = '"Geist Mono", ui-monospace, SFMono-Regular, Menlo, monospace';
    expect(css).toContain(`--font-sans: ${stack};`);
    expect(css).toContain(`--font-mono: ${stack};`);
    const families = [...css.matchAll(/font-family:\s*([^;]+);/g)].map((m) => (m[1] ?? "").trim());
    for (const f of families) expect(['"Geist Mono"', "var(--font-mono)"], `font-family: ${f}`).toContain(f);
    expect(css.match(/@font-face/g)?.length, "exactly one @font-face").toBe(1);
    const customFamilies = [...css.matchAll(/--font-[\w-]+:/g)].map((m) => m[0]);
    expect(customFamilies.sort()).toEqual(["--font-mono:", "--font-sans:"]);
  });

  it("puts the only heavier weight inside the .display-lg rule", () => {
    const withoutFace = css.replace(/@font-face\s*\{[^}]*\}/g, "");
    const weights = [...withoutFace.matchAll(/(^|[^-\w])font-weight:\s*([^;]+);/g)].map((m) => (m[2] ?? "").trim());
    expect(weights.sort()).toEqual(["700", "inherit"]);
    const rule = /^\.display-lg,[\s\S]*?\}/m.exec(css)?.[0] ?? "";
    expect(rule).toMatch(/font-weight:\s*700;/);
  });

  it("this test file is the copy-ready one: it has the same name everywhere", () => {
    expect(basename(fileURLToPath(import.meta.url))).toBe("design.test.ts");
  });
});
