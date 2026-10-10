/** Only human-readable provider content belongs in chat. Unknown transport
 * records, tool payloads and incomplete JSON are intentionally invisible. */
export function readableProviderOutput(input: string): string | null {
  const structured = (text: string) => /^(?:[{}\[\]]|"(?:[^"\\]|\\.)*"\s*:)/.test(text)
    && !/^\[[^\]\n]+\]\(/.test(text); // Keep ordinary Markdown links.
  const join = (values: (string | null)[]) => [...new Set(values.filter((value): value is string => Boolean(value)))].join("\n\n") || null;
  const read = (input: string, depth: number): string | null => {
    if (depth > 8) return null;
    const text = input.trim();
    if (!text) return null;
    if (/^```(?:jsonl?)?$/i.test(text)) return null;
    const fence = text.match(/^```(?:json|jsonl)?\s*\n([\s\S]*?)\n```$/i);
    if (fence && (structured(fence[1].trim()) || /^```json/i.test(text))) return read(fence[1], depth + 1);
    let value: unknown;
    try { value = JSON.parse(text); } catch {
      if (structured(text)) {
        // JSONL may contain many commands followed by a readable commit.
        // Never use incomplete or unrecognized JSON as a text fallback.
        return join(text.split(/\r?\n/).flatMap((line) => {
          try { JSON.parse(line); return [read(line, depth + 1)]; } catch { return []; }
        }));
      }
      // Preserve prose around command blocks, without flashing the payload.
      return text.replace(/```(?:json|jsonl)\b[^\n]*\n([\s\S]*?)(?:```|$)/gi,
        (_match, payload: string) => read(payload, depth + 1) ?? "")
        .split(/\r?\n/).map((line) => structured(line.trim()) ? read(line, depth + 1) ?? "" : line).join("\n").trim() || null;
    }
    if (typeof value === "string") return read(value, depth + 1);
    if (typeof value === "number" || typeof value === "boolean") return text;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    const readable = (candidate: unknown) => typeof candidate === "string" ? read(candidate, depth + 1) : null;
    if (record.op === "commit") return readable(record.summary);
    if (record.kind === "answer" || record.kind === "question") return readable(record.content);
    if (["commands", "generatorCommands", "generation"].includes(String(record.kind))) return readable(record.summary);
    if (record.type === "assistant") {
      const message = record.message as { content?: unknown } | undefined;
      if (Array.isArray(message?.content)) return join(message.content.map((part) =>
        part?.type === "text" ? readable(part.text) : null));
      return readable(message?.content);
    }
    if (record.type === "item.completed") {
      const item = record.item as { type?: string; text?: unknown } | undefined;
      if (item && (!item.type || item.type === "agent_message")) return readable(item.text);
    }
    if (record.type === "result") return readable(record.result);
    return null;
  };
  return read(input, 0);
}
