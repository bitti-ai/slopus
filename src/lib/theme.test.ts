// @vitest-environment jsdom

import { readdirSync, readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import {
  applyTheme, BACKDROP_GLOBAL, hasMicaBackdrop, loadTheme, resolveTheme, saveTheme, systemTheme,
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
    document.documentElement.removeAttribute("data-backdrop");
    delete (window as unknown as Record<string, unknown>)[BACKDROP_GLOBAL];
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

  it("paints no ground at all over Mica, in either theme", () => {
    /* Any inline colour would sit on top of the backdrop and hide it. */
    (window as unknown as Record<string, unknown>)[BACKDROP_GLOBAL] = "mica";
    stubMatchMedia(true);
    applyTheme("system");
    expect(document.documentElement.style.backgroundColor).toBe("transparent");
    applyTheme("dark");
    expect(document.documentElement.style.backgroundColor).toBe("transparent");
    /* The native global becomes the attribute window.css keys on, even when
       theme-boot.js never ran. */
    expect(document.documentElement.getAttribute("data-backdrop")).toBe("mica");
  });

  it("keeps the solid ground where there is no Mica", () => {
    expect(hasMicaBackdrop()).toBe(false);
    expect(document.documentElement.hasAttribute("data-backdrop")).toBe(false);
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

  it("agrees with the three copies that live outside the bundle entirely", () => {
    /* The test above pins the copies JavaScript can reach. Three more exist
       where no stylesheet and no bundle has loaded yet, and they were unpinned
       until now — which is how a light-theme computer came to open a black
       window: tauri.conf.json's `backgroundColor` is a single static value and
       nothing checked it was even a colour the palette knows.

       It stays the DARK ground on purpose. It is what a window is created with
       before any of our code runs, and one static value cannot follow a
       three-state preference; src-tauri/src/window.rs repaints it from the OS
       theme as soon as the app is up, and theme-boot.js corrects it again on
       the webview's first frame. See the comment above GROUND_DARK for the one
       case that still gets a wrong frame and why nothing here can fix it. */
    /* Case-insensitively, all three of them: a hex colour is case-insensitive,
       so re-spelling #080a0f as #080A0F is not drift and must not fail the
       suite — this pin exists to catch a DIFFERENT colour, and a pin that also
       fires on a capital letter teaches people to edit the test. */
    const conf = JSON.parse(read("src-tauri/tauri.conf.json"));
    expect(String(conf.app.windows[0].backgroundColor).toLowerCase()).toBe(THEME_BACKGROUND.dark.toLowerCase());

    /* Written as Color(0x08, 0x0a, 0x0f, 0xff) so this comparison is exact
       rather than a decimal triple nobody could check by eye. */
    const asRustColor = (hex: string) =>
      `Color(${hex.slice(1).match(/../g)!.map((pair) => `0x${pair}`).join(", ")}, 0xff)`;
    const rust = read("src-tauri/src/window.rs");
    expect(rust.toLowerCase()).toContain(asRustColor(THEME_BACKGROUND.dark).toLowerCase());
    expect(rust.toLowerCase()).toContain(asRustColor(THEME_BACKGROUND.light).toLowerCase());
    /* And that they are actually used for this. Two consts nothing calls would
       keep passing the two assertions above while the window stayed black. */
    expect(rust).toContain("set_background_color");
    expect(rust).toContain("tauri::Theme::Light");

    /* index.html used to ship a theme-color meta that applyTheme rewrote on
       every switch. A desktop window has no browser chrome for it to tint, so
       both are gone; this keeps them from drifting back in as a sixth copy. */
    expect(read("index.html")).not.toContain("theme-color");
    expect(read("src/lib/theme.ts")).not.toContain("theme-color");
  });

  it("goes transparent under Mica in the boot script as well as in theme.ts", () => {
    /* theme-boot.js runs before the bundle, so it has to know about the
       backdrop on its own; otherwise the first frame paints an opaque ground
       over Mica and the window flashes solid before theme.ts clears it. */
    const boot = read("public/theme-boot.js");
    expect(boot).toContain(BACKDROP_GLOBAL);
    expect(boot).toContain('setAttribute("data-backdrop", "mica")');
    expect(boot).toContain('"transparent"');
    /* And the global is the one Rust actually sets. */
    expect(read("src-tauri/src/native_shell.rs")).toContain(`"${BACKDROP_GLOBAL}"`);
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
    // The lane grid's interval, computed from the ruler's own tick step so the
    // lines under the clips fall where the timecodes above them are.
    "--lane-grid": "src/components/workspace/TimelineView.tsx",
    // The project's frame shape, so the export stage keeps one size whatever is
    // under the playhead.
    "--frame-aspect": "src/components/workspace/ExportView.tsx",
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
   `hsl(` or `hsla(`, not `oklch()`, `oklab()`, `lab()`, `lch()`, `hwb()` or
   `color()`, and not a NAMED colour either — `background: white` was the widest
   way through this guard, and `color-mix(in srgb, white 30%, var(--panel))` the
   likeliest, because color-mix is how nearly every derived shade in this
   codebase is written. tokens.css is the one file that spells colours out;
   every other sheet in src/styles goes through it.

   Two spellings deliberately stay legal, because neither names a colour:
   `transparent` (the absence of one) and `currentColor` (whatever the palette
   already put on the element). And `color-mix()` itself is not banned — only
   literals inside it, which the same two checks find wherever they sit.

   A handful of literals ARE right, because they are pictures and brand marks
   rather than surfaces, and they stay dark whatever the page does. Each one is
   listed below by the exact rule it lives in, with the reason. Two assertions
   keep that list honest in both directions: a literal outside the list fails,
   and a listed rule that has gone away — or has stopped containing a literal —
   fails too. An allowlist nothing verifies is how the last two guards rotted.  */

/* The `i` is load-bearing and was missing: CSS function names are ASCII
   case-insensitive, so `RGB(255,0,0)` and `OKLCH(…)` are the same declarations
   as their lowercase spellings and walked straight through. The file's own
   `RebeccaPurple` assertion shows case had been thought about for NAMES and not
   for functions.

   `%23` is the percent-encoded `#`, which is the canonical way to put a colour
   in an inline SVG data URI — `url("data:image/svg+xml,%3Csvg fill='%23ff0000'…")`
   — and this repo already inlines SVG masks in shell.css, so it is a spelling
   that would plausibly arrive rather than a theoretical one. The raw `#` form
   was already caught; only the encoded one got through. */
const COLOUR_LITERAL = /(?:#|%23)[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/gi;

/* Every named colour in CSS Color 4. `transparent` and `currentcolor` are
   deliberately absent — see above. The interpolation spaces color-mix() takes
   (`in srgb`, `in oklab`, `in hsl`) are not in here either, and the function
   list above only matches with an opening paren, so `color-mix(in oklab, …)`
   stays legal while `oklab(0.6 0.1 0.2)` does not. */
const NAMED_COLOURS = new Set(`
  aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet
  brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan
  darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen
  darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey
  darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite
  forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew
  hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue
  lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon
  lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime
  limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple
  mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue
  mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid
  palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum
  powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen
  seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal
  thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen
`.trim().split(/\s+/));

/* The SYSTEM colours, also CSS Color 4, and every bit as much a hardcoded
   surface: `background: Canvas; color: CanvasText` is the OS's palette painted
   over this one, which is exactly the "one theme's ink on the other theme's
   ground" failure the whole guard exists for — worse, because the two palettes
   are not even ours to reason about. They went through untouched.

   These are also the reason `--custom-property` names are blanked out of a
   value below: `var(--field-bg)` is a perfectly good token name (this repo
   had one), and `Field` is a system colour, so scanning the raw value would fire on the palette
   itself. A property NAME is never a colour value; only what follows it is. */
const SYSTEM_COLOURS = new Set(`
  accentcolor accentcolortext activetext buttonborder buttonface buttontext canvas canvastext
  field fieldtext graytext highlight highlighttext linktext mark marktext selecteditem
  selecteditemtext visitedtext
`.trim().split(/\s+/));

/* CSS lets an identifier be spelled with escapes — `\77 hite` IS `white`, and
   `\72 gb(0,0,0)` IS `rgb(0,0,0)` — so a value is decoded before its words are
   read. A hex colour cannot hide this way (an escape produces an ident, and
   `#fff` is a hash token, so `\23 fff` is not a colour at all), which is why
   only idents and function names need it. */
const decodeEscapes = (value: string) => value
  .replace(/\\([0-9a-f]{1,6})[ \t\n]?/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
  .replace(/\\(.)/g, "$1");

/** Every colour a chunk of CSS names, in the two shapes a name can take. */
function colourLiterals(css: string): string[] {
  const found = [...css.matchAll(COLOUR_LITERAL)].map((match) => match[0]);
  /* A named colour only counts inside a declaration VALUE, and only after three
     things are removed from that value. Quoted strings, because `content:
     "black"` names a word rather than a colour. Custom-property NAMES, because
     `var(--field-bg)` would otherwise read as the system colour `Field`.

     And the font properties are skipped whole, because their value is a list of
     arbitrary names — `font-family: Silver, Tan, sans-serif` is three fonts and
     no colours. The note that used to stand here said blanking quoted strings
     handled that; it handled only `font-family: "Silver"`, and the unquoted
     form — which is how a stack is normally written — tripped the guard. A
     false positive is how a guard gets deleted rather than fixed, so the code
     now does what the comment says. Nothing is lost: a font called `white`
     paints nothing.

     Selectors never reach here — this only ever sees rule bodies. */
  /* The property name allows DIGITS, which it did not: `[-a-zA-Z]+` could not
     reach the colon in `--wash-3: white`, so every custom property with a digit
     in its name had its value skipped entirely — and the palette is full of
     them (--panel-2, --panel-3, --wash-3). */
  for (const [, property, raw] of css.matchAll(/([-a-zA-Z][-a-zA-Z0-9]*)\s*:\s*([^;{}]*)/g)) {
    if (/^(font|font-family|--font[-a-z0-9]*)$/i.test(property)) continue;
    const value = decodeEscapes(raw.replace(/"[^"]*"|'[^']*'/g, " ").replace(/--[a-z0-9-]+/gi, " "));
    for (const word of value.match(/[a-zA-Z]+/g) ?? []) {
      if (NAMED_COLOURS.has(word.toLowerCase()) || SYSTEM_COLOURS.has(word.toLowerCase())) found.push(word);
    }
    /* A value that carried an escape is rescanned decoded, so an escaped
       FUNCTION name is caught too. Only such values are rescanned, so ordinary
       CSS is never counted twice; a value mixing an escaped and a plain literal
       can double-count, which errs towards the guard firing. */
    if (raw.includes("\\")) found.push(...[...value.matchAll(COLOUR_LITERAL)].map((match) => match[0]));
  }
  return found;
}

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
  "titlebar.css": {
    /* Windows paints its own close button this way in every app and in both
       themes: #C42B1C with a white glyph. It is the system's caption mark, not
       a surface of this palette, and a themed red here would be the one close
       button on the desktop that looks different. */
    ".titlebar__caption--close:hover":
      "the Windows caption close red with its white glyph, identical in both themes",
    ".titlebar__caption--close:active":
      "the pressed shade of the same Windows caption close red",
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
    expect(colourLiterals(readCss("src/styles/tokens.css")).length).toBeGreaterThan(100);
  });

  it("catches the three shapes the hex-and-rgb regex alone walked straight past", () => {
    /* Each of these was tried against the previous guard and got through. The
       point of putting them here rather than trusting the regex to read right
       is that a rule nobody has ever seen bite is a rule nobody knows works. */
    expect(colourLiterals("a { background: white; }")).toEqual(["white"]);
    expect(colourLiterals("a { border-color: RebeccaPurple; }")).toEqual(["RebeccaPurple"]);
    expect(colourLiterals("a { background: color-mix(in srgb, white 30%, var(--panel)); }")).toEqual(["white"]);
    expect(colourLiterals("a { background: color-mix(in srgb, #fff 30%, var(--panel)); }")).toEqual(["#fff"]);
    expect(colourLiterals("a { color: oklch(62% 0.2 250); }")).toEqual(["oklch("]);
    expect(colourLiterals("a { color: lab(52% 40 59); }")).toEqual(["lab("]);
    expect(colourLiterals("a { color: lch(52% 72 55); }")).toEqual(["lch("]);
    expect(colourLiterals("a { color: hwb(194 0% 0%); }")).toEqual(["hwb("]);
    expect(colourLiterals("a { color: color(display-p3 1 0 0); }")).toEqual(["color("]);

    /* And the shapes that must NOT trip it. Banning any of these would ban the
       idiom the palette is actually derived with, and the next person would
       "fix" the guard by deleting it. */
    expect(colourLiterals("a { background: color-mix(in srgb, var(--accent) 20%, var(--panel-3)); }")).toEqual([]);
    expect(colourLiterals("a { background: color-mix(in oklab, var(--a), var(--b)); }")).toEqual([]);
    expect(colourLiterals("a { border-color: transparent; }")).toEqual([]);
    expect(colourLiterals("a { color: currentColor; }")).toEqual([]);
    expect(colourLiterals('a { content: "black"; filter: grayscale(1); }')).toEqual([]);
    expect(colourLiterals("a { --panel-3: var(--panel-2); border: 1px solid var(--line); }")).toEqual([]);
  });

  it("catches the five more the regex above still walked past", () => {
    /* Same discipline as the block above: each of these was tried against the
       guard as it stood and got through. */

    /* CSS function names are case-insensitive. The regex was not. */
    expect(colourLiterals("a { color: RGB(255, 0, 0); }")).toEqual(["RGB("]);
    expect(colourLiterals("a { color: OKLCH(62% 0.2 250); }")).toEqual(["OKLCH("]);
    expect(colourLiterals("a { background: HSLA(0, 0%, 0%, 0.5); }")).toEqual(["HSLA("]);

    /* The percent-encoded hash, which is how a colour is written inside an
       inline SVG data URI — the shape shell.css's masks are already written in. */
    expect(colourLiterals(`a { background: url("data:image/svg+xml,%3Csvg fill='%23ff0000'%3E%3C/svg%3E"); }`))
      .toEqual(["%23ff0000"]);

    /* System colours: the OS palette painted over ours. */
    expect(colourLiterals("a { background: Canvas; color: CanvasText; }")).toEqual(["Canvas", "CanvasText"]);
    expect(colourLiterals("a { color: GrayText; }")).toEqual(["GrayText"]);
    expect(colourLiterals("a { border-color: AccentColor; }")).toEqual(["AccentColor"]);

    /* An identifier spelled with escapes, as a name and as a function name. */
    expect(colourLiterals("a { color: \\77 hite; }")).toEqual(["white"]);
    expect(colourLiterals("a { color: \\72 gb(1, 2, 3); }")).toEqual(["rgb("]);

    /* A custom property with a digit in its name: the property regex could not
       reach the colon, so the whole value went unread. */
    expect(colourLiterals("a { --wash-3: white; }")).toEqual(["white"]);
    expect(colourLiterals("a { --panel-2: Canvas; }")).toEqual(["Canvas"]);
  });

  it("leaves the shapes those five rules could plausibly have broken alone", () => {
    /* Every widening above has a legal neighbour one character away, and a
       guard that fires on the palette's own idioms is a guard that gets
       deleted. These are those neighbours. */

    /* `Field` is a system colour; `--field-bg` is a token name (the palette
       had one until the Fluent pass). Blanking property NAMES out of a value is what separates them. */
    expect(colourLiterals("a { background: var(--field-bg); color: var(--text-primary); }")).toEqual([]);
    expect(colourLiterals("a { box-shadow: inset 0 1px var(--hairline-hi); }")).toEqual([]);

    /* An unquoted font stack, which is how a stack is normally written. The
       comment above used to claim quoted-string blanking covered this; it did
       not, and `font-family: Silver, Tan, sans-serif` tripped the guard. */
    expect(colourLiterals("a { font-family: Silver, Tan, sans-serif; }")).toEqual([]);
    expect(colourLiterals("a { font: var(--weight-medium) 12px / 1 Silver, monospace; }")).toEqual([]);
    expect(colourLiterals(':root { --font-sans: "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif; }')).toEqual([]);

    /* But skipping the font properties must not blind the REST of the rule. */
    expect(colourLiterals("a { font-family: Silver; color: white; }")).toEqual(["white"]);

    /* `color(` needs its paren, and the case-insensitive flag must not make a
       bare property name look like one. */
    expect(colourLiterals("a { accent-color: var(--accent); }")).toEqual([]);
    expect(colourLiterals("a { transition: color 0.2s ease, background-color 0.2s; }")).toEqual([]);
  });

  for (const sheet of sheets) {
    const allowed = LITERALS_ALLOWED[sheet] ?? {};
    const blocks = ruleBlocks(readCss(`src/styles/${sheet}`));

    it(`${sheet} paints only through the palette`, () => {
      const offenders: string[] = [];
      for (const { selector, body } of blocks) {
        if (selector in allowed) continue;
        for (const literal of colourLiterals(body)) {
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
        expect(colourLiterals(rule!.body), "exemption is stale: the rule names no colour any more").not.toEqual([]);
      });
    }
  }
});

/* --- Two native-app rules that are easy to undo by habit ------------------- *

   On Windows the hand cursor means "hyperlink" and nothing else, and blur is
   reserved for menus and flyouts (acrylic). Both crept back one rule at a
   time before; a web stylesheet reaches for `cursor: pointer` and a
   `backdrop-filter` by reflex. These stand in for a lint rule. */

describe("the stylesheets behave like a Windows app", () => {
  const sheets = readdirSync("src/styles").filter((file) => file.endsWith(".css")).sort();

  for (const sheet of sheets) {
    const blocks = ruleBlocks(readCss(`src/styles/${sheet}`));

    it(`${sheet} shows the hand cursor only on a real link`, () => {
      const offenders = blocks
        .filter(({ body }) => /cursor\s*:\s*pointer/.test(body))
        .map(({ selector }) => selector)
        .filter((selector) => selector !== "a[href]");
      expect(offenders).toEqual([]);
    });

    it(`${sheet} blurs only acrylic surfaces`, () => {
      const offenders = blocks
        .filter(({ body }) => /backdrop-filter\s*:/.test(body))
        .filter(({ body }) => !/backdrop-filter\s*:\s*var\(--acrylic-filter\)/.test(body) || !/var\(--acrylic\)/.test(body))
        .map(({ selector }) => selector);
      expect(offenders).toEqual([]);
    });
  }
});
