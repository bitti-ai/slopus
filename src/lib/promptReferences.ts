/** References cited inside a free-text prompt, stored in the text itself as
 *  `[Reference name]`. The prompt field reads the same syntax back and shows
 *  each one as a smart chip, so what is saved and what is shown are one parse.
 *  A name holding a bracket or a line break could not be read back, so such a
 *  reference cannot be cited this way. */

export interface PromptPart {
  kind: "text" | "reference";
  /** The literal characters for `text`; the reference name for `reference`. */
  value: string;
}

const PROMPT_REFERENCE = /\[([^[\]\n]+)\]/g;

export const promptReferenceToken = (name: string): string => `[${name}]`;

export const canCitePromptReference = (name: string): boolean => name.trim().length > 0 && !/[[\]\n]/.test(name);

export function splitPromptText(text: string): PromptPart[] {
  const parts: PromptPart[] = [];
  let cursor = 0;
  for (const match of text.matchAll(PROMPT_REFERENCE)) {
    const at = match.index ?? 0;
    if (at > cursor) parts.push({ kind: "text", value: text.slice(cursor, at) });
    parts.push({ kind: "reference", value: match[1] });
    cursor = at + match[0].length;
  }
  if (cursor < text.length) parts.push({ kind: "text", value: text.slice(cursor) });
  return parts;
}

/** Every reference name cited by a prompt, in the order it is first cited. */
export function promptReferenceNames(text: string): string[] {
  const seen: string[] = [];
  for (const part of splitPromptText(text)) {
    if (part.kind === "reference" && !seen.includes(part.value)) seen.push(part.value);
  }
  return seen;
}
