import { Fragment, type ReactNode } from "react";

/** Slop's replies as a chat message: paragraphs, bullet and numbered lists,
 *  headings, fenced code, and inline **bold**, *italic* and `code`. A small
 *  Markdown subset rendered as React elements — never as HTML — so whatever a
 *  provider prints is shown, not executed. */
export function MessageText({ text }: { text: string }) {
  return <>{parseBlocks(text).map((block, index) => renderBlock(block, index))}</>;
}

type Block =
  | { kind: "paragraph"; lines: string[] }
  | { kind: "heading"; text: string }
  | { kind: "list"; ordered: boolean; start: number; items: string[] }
  | { kind: "code"; text: string };

const BULLET = /^\s*[-*•]\s+(.*)$/;
const NUMBERED = /^\s*(\d+)[.)]\s+(.*)$/;
const HEADING = /^\s*#{1,6}\s+(.*)$/;
const FENCE = /^\s*```/;

export function parseBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  const lines = text.replace(/\r\n?/g, "\n").trim().split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const previous = blocks.at(-1);
    if (FENCE.test(line)) {
      const body: string[] = [];
      for (index += 1; index < lines.length && !FENCE.test(lines[index]); index += 1) body.push(lines[index]);
      blocks.push({ kind: "code", text: body.join("\n") });
      continue;
    }
    if (!line.trim()) {
      blocks.push({ kind: "paragraph", lines: [] });
      continue;
    }
    const heading = HEADING.exec(line);
    const bullet = BULLET.exec(line);
    const numbered = NUMBERED.exec(line);
    if (heading) blocks.push({ kind: "heading", text: heading[1] });
    else if (bullet || numbered) {
      const ordered = Boolean(numbered);
      const item = bullet ? bullet[1] : numbered![2];
      if (previous?.kind === "list" && previous.ordered === ordered) previous.items.push(item);
      else blocks.push({ kind: "list", ordered, start: numbered ? Number(numbered[1]) : 1, items: [item] });
    } else if (previous?.kind === "list" && /^\s+\S/.test(line)) {
      // An indented line continues the list item above it.
      previous.items[previous.items.length - 1] += ` ${line.trim()}`;
    } else if (previous?.kind === "paragraph" && previous.lines.length) previous.lines.push(line);
    else blocks.push({ kind: "paragraph", lines: [line] });
  }
  return blocks.filter((block) => block.kind !== "paragraph" || block.lines.length);
}

function renderBlock(block: Block, key: number): ReactNode {
  switch (block.kind) {
    case "paragraph": return <p key={key}>{block.lines.map((line, index) => <Fragment key={index}>{index > 0 && <br />}{renderInline(line)}</Fragment>)}</p>;
    case "heading": return <p key={key} className="message-text__heading">{renderInline(block.text)}</p>;
    case "code": return <pre key={key}><code>{block.text}</code></pre>;
    case "list": {
      const items = block.items.map((item, index) => <li key={index}>{renderInline(item)}</li>);
      return block.ordered ? <ol key={key} start={block.start === 1 ? undefined : block.start}>{items}</ol> : <ul key={key}>{items}</ul>;
    }
  }
}

const INLINE = /`([^`]+)`|\*\*(.+?)\*\*|__(.+?)__|(?<![\w*])\*(?!\s)(.+?)(?<!\s)\*(?![\w*])|(?<!\w)_(?!\s)(.+?)(?<!\s)_(?!\w)/g;

export function renderInline(text: string): ReactNode[] {
  const parts: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(INLINE)) {
    const at = match.index ?? 0;
    if (at > last) parts.push(text.slice(last, at));
    const [, code, bold, boldAlt, italic, italicAlt] = match;
    if (code !== undefined) parts.push(<code key={at}>{code}</code>);
    else if (bold !== undefined || boldAlt !== undefined) parts.push(<strong key={at}>{renderInline(bold ?? boldAlt)}</strong>);
    else parts.push(<em key={at}>{renderInline(italic ?? italicAlt)}</em>);
    last = at + match[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}
