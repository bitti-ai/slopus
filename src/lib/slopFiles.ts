import { invoke } from "@tauri-apps/api/core";
import { inTauri } from "./nativeShell";
import { MAX_SLOP_BYTES } from "./slop";

export async function openSlopFile(): Promise<string | null> {
  return invoke<string | null>("import_slop_file");
}

export async function readBrowserSlopFile(file: File): Promise<string> {
  if (!file.name.toLowerCase().endsWith(".slop")) throw new Error("Choose a .slop file.");
  if (file.size > MAX_SLOP_BYTES) throw new Error("The .slop file exceeds 4 MB.");
  return file.text();
}

export async function saveSlopFile(contents: string, name: string): Promise<boolean> {
  const filename = `${name.replace(/[<>:"/\\|?*\x00-\x1f]/g, "-").trim().replace(/[. ]+$/, "").slice(0, 120) || "generators"}.slop`;
  if (inTauri()) return invoke<boolean>("export_slop_file", { contents, filename });
  const url = URL.createObjectURL(new Blob([contents], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url; link.download = filename; document.body.append(link); link.click(); link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  return true;
}
