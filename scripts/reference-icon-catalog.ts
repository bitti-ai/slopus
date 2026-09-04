import { KNOWN_CHARACTERS } from "../src/lib/known-characters";
import { REFERENCE_PRESETS } from "../src/lib/reference-presets";

const safeId = (value: string) => value.toLocaleLowerCase().normalize("NFKD")
  .replace(/[\u0300-\u036f]/g, "")
  .replace(/[^a-z0-9]+/g, "-")
  .replace(/(^-|-$)/g, "");

const knownSubjects = new Map(KNOWN_CHARACTERS.map(([name, actor, franchise], index) => [
  `character-known-${safeId(name)}-${index + 1}`,
  franchise === "Real Person / Celebrity" ? name : `${name} as portrayed by ${actor} in ${franchise}`,
]));

const catalog = REFERENCE_PRESETS
  .filter((preset) => preset.type === "character" || preset.type === "product" || preset.type === "location" || preset.type === "style")
  .map((preset) => ({
    id: preset.id,
    type: preset.type,
    subcategory: preset.subcategory,
    name: preset.name,
    subject: knownSubjects.get(preset.id) ?? preset.prompt.replace(/\.$/, ""),
  }));

process.stdout.write(JSON.stringify(catalog));
