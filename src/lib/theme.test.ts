// @vitest-environment jsdom

import { readdirSync, readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import {
  applyTheme, loadTheme, resolveTheme, saveTheme, systemTheme,
  THEME_BACKGROUND, THEME_KEY, watchSystemTheme,
} from "./theme";

/* The stylesheets are read as TEXT, not applied. jsdom implements no cascade
   and no custom-property resolution, so the only way to prove the palette holds
   together is to read what is actually in the file. `?raw` cannot do it either:
   Vitest stubs every CSS request to an empty string unless test.css is on.

   Paths are relative to the project root because that is where Vitest runs;
   a file:// URL would be resolved by jsdom's URL rather than Node's and comes
   back as a path that does not exist.

   The repo checks out with CRLF on Windows, so everything is normalised first
   or the selector searches silently find nothing. */
const read = (fromProjectRoot: string) =>
  readFileSync(fromProjectRoot, "utf8").replace(/\r\n/g, "\n");

/* Comments are stripped before anything is parsed. tokens.css documents its own
   contrast ratios in prose like "--accent is 4.2:1 on --panel: borders only",
   and a declaration scanner that trusts prose reads that colon as a declaration
   and swallows the real --accent that follows it. */
const readCss = (fromProjectRoot: string) =>
  read(fromProjectRoot).replace(/\/\*[\s\S]*?\*\//g, "");

/* jsdom's matchMedia is not implemented at all, so every test that cares about
   the OS setting installs its own. `light` is what the query asks for, mirroring
   `(prefers-color-scheme: light)` in tokens.css. */
function stubMatchMedia(light: boolean) {
  const listeners = new Set<() => void>();
  const query = {
    matches: light,
    media: "(prefers-color-scheme: light)",
    addEventListener: (_: string, handler: () => void) => listeners.add(handler),
    removeEventListener: (_: string, handler: () => void) => listeners.delete(handler),
    addListener: (handler: () => void) => listeners.add(handler),
    removeListener: (handler: () => void) => listeners.delete(handler),
  };
  Object.defineProperty(window, "matchMedia", { configurable: true, writable: true, value: () => query });
  return {
    flipTo(next: boolean) {
      query.matches = next;
      for (const handler of listeners) handler();
    },
    listenerCount: () => listeners.size,
  };
}

describe("theme preference", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
    document.documentElement.style.backgroundColor = "";
    stubMatchMedia(false);
  });

  it("defaults to system and refuses anything it does not recognise", () => {
    expect(loadTheme()).toBe("system");
    localStorage.setItem(THEME_KEY, "sepia");
    expect(loadTheme()).toBe("system");
    saveTheme("light");
    expect(loadTheme()).toBe("light");
  });

  it("writes an attribute for an explicit choice and none at all for system", () => {
    expect(applyTheme("light")).toBe("light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");

    expect(applyTheme("dark")).toBe("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");

    /* No attribute is the point: it hands the decision back to the media query
       so the OS can flip it live without JavaScript. */
    applyTheme("system");
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
  });

  it("resolves system against the computer, in both directions", () => {
    stubMatchMedia(true);
    expect(systemTheme()).toBe("light");
    expect(resolveTheme("system")).toBe("light");
    expect(resolveTheme("dark")).toBe("dark");   /* explicit beats the OS */

    stubMatchMedia(false);
    expect(systemTheme()).toBe("dark");
    expect(resolveTheme("light")).toBe("light"); /* and in the other direction */
  });

  it("repaints the document ground so a stale inline colour cannot outlive a switch", () => {
    stubMatchMedia(true);
    applyTheme("system");
    expect(document.documentElement.style.backgroundColor).toBe("rgb(238, 241, 246)");
    applyTheme("dark");
    expect(document.documentElement.style.backgroundColor).toBe("rgb(8, 10, 15)");
  });

  it("reports OS changes and unsubscribes cleanly", () => {
    const media = stubMatchMedia(false);
    const seen: string[] = [];
    const stop = watchSystemTheme((theme) => seen.push(theme));
    media.flipTo(true);
    media.flipTo(false);
    expect(seen).toEqual(["light", "dark"]);
    stop();
    expect(media.listenerCount()).toBe(0);
  });
});

/* --- The stylesheet is the other half of the contract ---------------------- */

/** Everything between a selector and its matching close brace. */
function block(css: string, selector: string): string {
  const start = css.indexOf(selector);
  if (start < 0) throw new Error(`no such selector: ${selector}`);
  let depth = 0;
  for (let i = css.indexOf("{", start); i < css.length; i += 1) {
    if (css[i] === "{") depth += 1;
    else if (css[i] === "}") {
      depth -= 1;
      if (depth === 0) return css.slice(css.indexOf("{", start) + 1, i);
    }
  }
  throw new Error(`unterminated block: ${selector}`);
}

const declarations = (css: string): Map<string, string> => {
  const found = new Map<string, string>();
  for (const match of css.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    found.set(match[1], match[2].trim().replace(/\s+/g, " "));
  }
  return found;
};

describe("tokens.css", () => {
  const css = readCss("src/styles/tokens.css");
  const dark = declarations(block(css, "\n:root {"));
  const mediaLight = declarations(block(css, ':root:not([data-theme="dark"]) {'));
  const explicitLight = declarations(block(css, ':root[data-theme="light"] {'));

  it("guards the media block so an explicit dark choice beats a light computer", () => {
    /* Drop this guard and picking Dark on a light-theme computer silently
       repaints light: same specificity, and the media block wins on order. */
    expect(css).toContain("@media (prefers-color-scheme: light)");
    expect(css).toContain(':root:not([data-theme="dark"])');
  });

  it("never introduces a colour for the first time in a media or attribute block", () => {
    /* This is the bug the whole structure exists to prevent: a token defined
       only under light leaves dark painting with an unresolved var(), which
       falls back to inherit/initial and puts one theme's ink on the other
       theme's ground. */
    const orphans = [...mediaLight.keys(), ...explicitLight.keys()].filter((name) => !dark.has(name));
    expect(orphans).toEqual([]);
  });

  it("keeps the two light blocks identical", () => {
    expect([...explicitLight.entries()].sort()).toEqual([...mediaLight.entries()].sort());
  });

  it("flips color-scheme with the palette so platform menus follow", () => {
    /* Without this the <select> dropdown, the scrollbars and the caret stay
       dark on a light page — chrome the stylesheet cannot reach. */
    expect(block(css, "\n:root {")).toContain("color-scheme: dark");
    expect(block(css, ':root:not([data-theme="dark"]) {')).toContain("color-scheme: light");
    expect(block(css, ':root[data-theme="light"] {')).toContain("color-scheme: light");
  });

  it("agrees with the two copies of --bg that have to exist outside it", () => {
    /* theme.ts and public/theme-boot.js both hard-code the grounds because they
       run before any stylesheet is available. Drift shows up as a one-frame
       flash of a colour that is in no palette, which nobody would ever notice
       by looking. */
    expect(dark.get("--bg")).toBe(THEME_BACKGROUND.dark);
    expect(mediaLight.get("--bg")).toBe(THEME_BACKGROUND.light);

    const boot = read("public/theme-boot.js");
    expect(boot).toContain(`dark: "${THEME_BACKGROUND.dark}"`);
    expect(boot).toContain(`light: "${THEME_BACKGROUND.light}"`);
    expect(boot).toContain(THEME_KEY);
  });
});

describe("every stylesheet resolves through the palette", () => {
  const sheets = [
    "base", "controls", "shell", "library", "workspace",
    "generator", "timeline", "references", "export",
  ];
  const known = new Set(declarations(block(readCss("src/styles/tokens.css"), "\n:root {")).keys());
  /* Set by a component at runtime, so no stylesheet declares them. Each entry
     names the file that supplies it and is checked below, so this cannot rot
     into a list of tokens nothing sets any more. */
  const setByComponents: Record<string, string> = {
    "--clip-color": "src/components/workspace/TimelineView.tsx",
  };

  for (const [token, source] of Object.entries(setByComponents)) {
    it(`${token} is still set by ${source}`, () => {
      expect(read(source)).toContain(token);
    });
  }

  for (const name of sheets) {
    it(`${name}.css uses no undefined token`, () => {
      const css = readCss(`src/styles/${name}.css`);
      /* A sheet may declare its own custom properties — a track column width,
         a clip colour, the offset that centres the transport on the picture.
         Those are not palette entries and must not be, so they are collected
         from the sheet itself rather than from a hand-kept allowlist: two
         agents added one each in a single wave, and a list would have gone
         stale twice in an afternoon. What this test is for is a `var()` that
         names something nothing declares anywhere. */
      const declared = new Set([...css.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((match) => match[1]));
      const used = [...css.matchAll(/var\((--[a-z0-9-]+)/g)].map((match) => match[1]);
      const missing = [...new Set(used)].filter(
        (token) => !known.has(token) && !declared.has(token) && !(token in setByComponents),
      );
      expect(missing).toEqual([]);
    });
  }
});

/* --- The colour literals the palette cannot see ---------------------------- *

   The test above proves every `var()` resolves to a declared token. It is blind
   by construction to a colour that never goes through `var()` at all, and that
   is the shape of every light-theme defect found so far: a hardcoded near-black
   plate under themed ink (1.0:1 in light), a themed caption on a hardcoded dark
   wash (2.6:1), hatching spelled `rgba(255,255,255,0.03)` beside a `--hatch`
   token that already existed. None of them touched a var(), so nothing failed.

   So: a stylesheet may not name a colour. Not `#hex`, not `rgb(`, `rgba(`,
   `hsl(` or `hsla(`. tokens.css is the one file that spells colours out; every
   other sheet in src/styles goes through it.

   A handful of literals ARE right, because they are pictures and brand marks
   rather than surfaces, and they stay dark whatever the page does. Each one is
   listed below by the exact rule it lives in, with the reason. Two assertions
   keep that list honest in both directions: a literal outside the list fails,
   and a listed rule that has gone away — or has stopped containing a literal —
   fails too. An allowlist nothing verifies is how the last two guards rotted.  */

const COLOUR_LITERAL = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\(/g;

/** The index of the `}` that closes the `{` at `open`. */
function closingBrace(css: string, open: number): number {
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === "{") depth += 1;
    else if (css[i] === "}") { depth -= 1; if (depth === 0) return i; }
  }
  throw new Error("unterminated block");
}

/** Every rule in a sheet as { selector, body }. Conditional at-rules are walked
 *  THROUGH, so a rule inside `@media`/`@supports` is attributed to its own
 *  selector rather than to the wrapper — otherwise the perforation mask under
 *  `@supports (mask-composite: exclude)` would need a second exemption naming a
 *  feature query. `@keyframes` and `@font-face` stay whole: their inner blocks
 *  are percentages, which are no use as a name. */
function ruleBlocks(css: string): { selector: string; body: string }[] {
  const found: { selector: string; body: string }[] = [];
  const walk = (from: number, to: number) => {
    let head = "";
    for (let i = from; i < to; i += 1) {
      const ch = css[i];
      if (ch === ";") { head = ""; continue; }   /* @import, @charset */
      if (ch !== "{") { head += ch; continue; }
      const end = closingBrace(css, i);
      const selector = head.trim().replace(/\s+/g, " ");
      if (/^@(media|supports|layer|container|scope)\b/.test(selector)) walk(i + 1, end);
      else found.push({ selector, body: css.slice(i + 1, end) });
      i = end;
      head = "";
    }
  };
  walk(0, css.length);
  return found;
}

/** Rule → why that rule is allowed to name a colour. Keyed by file name. */
const LITERALS_ALLOWED: Record<string, Record<string, string>> = {
  "shell.css": {
    ".pol-logo__ticket":
      "brand mark: the PolStudio ticket is one artwork, blue plate and white letter, in both themes",
    ".pol-logo__ticket::before": "the ticket's blue plate, and the mask that cuts its perforations",
    ".pol-logo__ticket::after": "the ticket's diamond tail, the same blue as the plate",
    ".pol-logo__perforations i":
      "fallback perforations: painted black because a hole reads as a hole on any backdrop",
  },
  "library.css": {
    /* library.css says all of this in prose above the rules; the point of
       repeating it here is that the guard knows, not that a reader does. */
    ".project-card__art--aurora": "generated cover art: a picture, not a surface",
    ".project-card__art--aurora::before": "generated cover art",
    ".project-card__art--aurora::after": "generated cover art",
    ".project-card__art--paper": "generated cover art",
    ".project-card__art--paper::before": "generated cover art",
    ".project-card__art--paper::after": "generated cover art",
    ".project-card__art--chrome": "generated cover art",
    ".project-card__art--chrome::before": "generated cover art",
    ".project-card__art--chrome::after": "generated cover art",
    ".project-card__art--ember": "generated cover art",
    ".project-card__format, .project-card__quality":
      "chrome ON the cover art: white on a dark picture in both themes, because the picture is dark in both",
    ".project-card__play": "chrome ON the cover art",
    ".project-card__art-copy": "chrome ON the cover art",
  },
  "generator.css": {
    ".job-refs .ref-mini":
      "stand-in artwork for a reference thumbnail — the same case as the library's cover art",
    ".ref-mini--1": "stand-in artwork for a reference thumbnail",
  },
};

describe("no stylesheet outside tokens.css names a colour", () => {
  const sheets = readdirSync("src/styles")
    .filter((file) => file.endsWith(".css") && file !== "tokens.css")
    .sort();

  it("finds every stylesheet, so a new one cannot slip in unchecked", () => {
    /* If this list ever shrinks the guard has stopped looking somewhere. */
    expect(sheets).toContain("timeline.css");
    expect(sheets).toContain("export.css");
    expect(sheets).toContain("generator.css");
    expect(sheets.length).toBeGreaterThanOrEqual(12);
  });

  it("proves it can see a literal at all, by finding tokens.css full of them", () => {
    /* The regex and the reader are shared with the assertions below. A typo
       that made them match nothing would turn every test here green. */
    expect(readCss("src/styles/tokens.css").match(COLOUR_LITERAL)!.length).toBeGreaterThan(100);
  });

  for (const sheet of sheets) {
    const allowed = LITERALS_ALLOWED[sheet] ?? {};
    const blocks = ruleBlocks(readCss(`src/styles/${sheet}`));

    it(`${sheet} paints only through the palette`, () => {
      const offenders: string[] = [];
      for (const { selector, body } of blocks) {
        if (selector in allowed) continue;
        for (const literal of body.match(COLOUR_LITERAL) ?? []) {
          offenders.push(`${sheet}  ${selector} { … ${literal} … }`);
        }
      }
      /* Whatever you are about to add here: a token in tokens.css is almost
         certainly the fix. Exempt a rule only when it is a picture or a brand
         mark that stays the same in a light theme, and say so above. */
      expect(offenders).toEqual([]);
    });

    for (const [selector, why] of Object.entries(allowed)) {
      it(`${sheet} still has ${selector} — ${why}`, () => {
        const rule = blocks.find((block) => block.selector === selector);
        expect(rule, `exemption names a rule ${sheet} no longer has`).toBeTruthy();
        /* And it still needs the exemption. A rule that has been converted to
           tokens must lose its entry, or the list drifts back into fiction. */
        expect(rule!.body.match(COLOUR_LITERAL), "exemption is stale: the rule names no colour any more").toBeTruthy();
      });
    }
  }
});
