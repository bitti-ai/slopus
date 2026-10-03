/* The desktop the app runs on, for the few words and glyphs that differ.
   WebView2 reports "Windows NT"; WebKitGTK reports "X11; Linux". jsdom and an
   unknown engine count as Windows, the platform the UI is drawn after. */

export type HostPlatform = "windows" | "linux" | "macos";

export function hostPlatform(userAgent: string = globalThis.navigator?.userAgent ?? ""): HostPlatform {
  if (/Windows NT/i.test(userAgent)) return "windows";
  if (/Macintosh|Mac OS X/i.test(userAgent)) return "macos";
  if (/Linux|X11|CrOS/i.test(userAgent)) return "linux";
  return "windows";
}

/** The file manager's name, for "Show in …" menu items. */
export function fileManagerName(platform: HostPlatform = hostPlatform()): string {
  return platform === "windows" ? "File Explorer" : platform === "macos" ? "Finder" : "Files";
}

/** Where the SlopFab runtime belongs, for a "runtime missing" status. */
export function runtimeLocationHint(platform: HostPlatform = hostPlatform()): string {
  return platform === "windows"
    ? "slopfab.dll should be next to Slopus.exe."
    : "libslopfab.so should be in /usr/lib/Slopus or next to the slopus executable.";
}
