/* PolStudio ships a browser bundle, so @types/node is deliberately NOT a
   dependency: pulling it in would let application code reach for `process`,
   `Buffer` and `fs` and still type-check, and none of those exist inside the
   Tauri webview.

   theme.test.ts nevertheless has to read the stylesheets it is asserting
   about — Vitest stubs `*.css?raw` to an empty string (test.css defaults to
   false), so an import cannot do it, and jsdom implements no cascade, so
   getComputedStyle cannot either. Declaring the single function that test
   needs keeps the reach into Node exactly that wide. */
declare module "node:fs" {
  export function readFileSync(path: string | URL, encoding: "utf8"): string;
}
