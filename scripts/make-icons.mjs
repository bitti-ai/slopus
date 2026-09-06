#!/usr/bin/env node
/** Generate desktop icons from the shared marketing artwork.
 * npm run icons             writes the packaged icons
 * npm run icons -- --check  verifies packaged icons against fresh output
 * Tauri's intermediate platform assets stay in the ignored artifacts folder.
 */
import { run } from "@tauri-apps/cli";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "marketing", "icon.png");
const output = join(root, "artifacts", "generated-icons");
const target = join(root, "src-tauri", "icons");
const config = JSON.parse(readFileSync(join(root, "src-tauri", "tauri.conf.json"), "utf8"));

// Tauri emits ICNS entries from a map whose iteration order varies by run.
// Sorting the entries keeps packaged files and verification reproducible.
function canonicalIcon(name, bytes) {
  if (!name.endsWith(".icns")) return bytes;
  if (bytes.toString("ascii", 0, 4) !== "icns" || bytes.readUInt32BE(4) !== bytes.length) {
    throw new Error(`Invalid ICNS header: ${name}`);
  }
  const entries = [];
  for (let offset = 8; offset < bytes.length;) {
    const size = bytes.readUInt32BE(offset + 4);
    if (size < 8 || offset + size > bytes.length) throw new Error(`Invalid ICNS entry: ${name}`);
    entries.push(bytes.subarray(offset, offset + size));
    offset += size;
  }
  entries.sort((a, b) => Buffer.compare(a.subarray(0, 4), b.subarray(0, 4)));
  return Buffer.concat([bytes.subarray(0, 8), ...entries]);
}

mkdirSync(output, { recursive: true });
await run(["icon", source, "--output", output], "slopus-icons");

const check = process.argv.includes("--check");
mkdirSync(target, { recursive: true });
for (const icon of config.bundle.icon) {
  const name = icon.replace(/^icons\//, "");
  const generated = join(output, name);
  const packaged = join(target, name);
  const bytes = canonicalIcon(name, readFileSync(generated));
  if (check) {
    if (!bytes.equals(canonicalIcon(name, readFileSync(packaged)))) {
      throw new Error(`${icon} differs from marketing/icon.png; run npm run icons.`);
    }
    console.log(`Verified ${icon}`);
  } else {
    writeFileSync(packaged, bytes);
    console.log(`Updated ${icon}`);
  }
}
