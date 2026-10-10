import { expect, it } from "vitest";
import { readableProviderOutput } from "./agentOutput";

const command = '{"op":"scene.set","id":"scene","title":"Opening"}';
const commit = '{"op":"commit","summary":"Updated the opening."}';
const reply = '{"kind":"answer","content":"Ready **now**."}';

it.each([command, JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: command } }),
  JSON.stringify({ type: "item.completed", item: { type: "command_execution", text: "Tool output" } }),
  '{"kind":"inspect","requests":[{"op":"generator.list"}]}', '[{"op":"scene.set"}]',
  '{"kind":"answer","content":', '{"op":', '"op": "scene.set",', "}", "```json\n" + command,
  "```json\n" + command + "\n```", "```json", "```", '{"unknown":"payload"}',
])("hides raw, partial and tool JSON: %s", (text) => {
  expect(readableProviderOutput(text)).toBeNull();
});

it.each([reply, JSON.stringify({ type: "result", result: reply }),
  JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: reply }] } }),
  "```json\n" + reply + "\n```",
])("extracts readable replies without their JSON wrapper: %s", (text) => {
  expect(readableProviderOutput(text)).toBe("Ready **now**.");
});

it.each([`${command}\n${commit}`, `\`\`\`jsonl\n${command}\n${commit}\n\`\`\``,
  JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: `${command}\n${commit}` } }),
])("shows only the summary of a command batch: %s", (text) => {
  expect(readableProviderOutput(text)).toBe("Updated the opening.");
});

it("keeps prose and Markdown while removing embedded JSON blocks", () => {
  const prose = "Plan:\n\n- **Warm** light\n- [Open the scene](scene:one)";
  expect(readableProviderOutput(prose)).toBe(prose);
  expect(readableProviderOutput("42")).toBe("42");
  expect(readableProviderOutput("[Open the scene](scene:one)")).toBe("[Open the scene](scene:one)");
  expect(readableProviderOutput(`Updated.\n\n\`\`\`json\n${command}\n\`\`\`\n\nAll set.`)).toBe("Updated.\n\n\n\nAll set.");
});
