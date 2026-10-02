import { APP_VERSION } from "./version";

const seenKey = (version: string) => `slopus.release-notes.seen.${version}`;

export function hasSeenReleaseNotes(version = APP_VERSION): boolean {
  try { return localStorage.getItem(seenKey(version)) === "true"; }
  catch { return false; }
}

export function markReleaseNotesSeen(version = APP_VERSION): void {
  try { localStorage.setItem(seenKey(version), "true"); }
  catch { /* Unavailable storage must not prevent reading or dismissing the notes. */ }
}
