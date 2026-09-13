import { KNOWN_CHARACTERS } from "./known-characters";
import { ANIMAL_GROUPS, LOCATION_GROUPS, LOCATION_SETTING_GROUPS, PRODUCT_GROUPS, STYLE_GROUPS, type OptionGroup } from "./expanded-reference-options";
import type { ProjectReference } from "./project";
import { hasBuiltinIcon } from "./builtinReferenceIcons";

export type ReferenceType = "custom" | "character" | "animal" | "product" | "location" | "style";
export type PresetReferenceType = Exclude<ReferenceType, "custom">;

export interface ReferencePreset {
  id: string;
  type: PresetReferenceType;
  subcategory: string;
  name: string;
  prompt: string;
  searchTerms?: string;
  /** Optional bundled artwork, used when no shared generated icon is available.
   *  Presentation only; never attached to generation as a reference image. */
  icon?: string;
}

const referenceIconModules = import.meta.glob("../assets/reference-icons/*.jpg", {
  eager: true,
  query: "?url",
  import: "default",
}) as Record<string, string>;

const iconForPreset = (id: string): string | undefined =>
  referenceIconModules[`../assets/reference-icons/${id}.jpg`];

const withIcon = (preset: ReferencePreset): ReferencePreset => ({ ...preset, icon: iconForPreset(preset.id) });

export const hasPresetIcon = (preset: ReferencePreset | undefined): boolean => Boolean(preset && (preset.icon || hasBuiltinIcon(preset.id)));

export const REFERENCE_TYPES: ReadonlyArray<{ id: PresetReferenceType; label: string }> = [
  { id: "character", label: "Character" },
  { id: "animal", label: "Animal" },
  { id: "product", label: "Product" },
  { id: "location", label: "Location" },
  { id: "style", label: "Style" },
];

const PUBLIC_FIGURE = "Real Person / Celebrity";
const ANIMATED_FRANCHISES = new Set(["Disney", "Rick and Morty", "Sesame Street", "South Park"]);
const TV_FRANCHISES = new Set([
  "2 Broke Girls", "24", "30 Rock", "Battlestar Galactica", "Big Little Lies", "Bones", "Breaking Bad",
  "Brooklyn Nine-Nine", "Buffy the Vampire Slayer", "Californication", "Castle", "Chappelle's Show", "Cheers",
  "Chuck", "Curb Your Enthusiasm", "Dexter", "Doctor Who", "Downton Abbey", "ER", "Firefly", "Friends",
  "Fringe", "Game of Thrones", "Ghost Whisperer", "Gilmore Girls", "GLOW", "Hell's Kitchen", "Heroes",
  "Homeland", "Home Improvement", "House M.D.", "House of Cards", "House of the Dragon", "How I Met Your Mother",
  "How to Get Away with Murder", "Jeeves and Wooster", "Killing Eve", "Last Week Tonight", "Lost", "Lucifer",
  "Luther", "Mad Men", "Malcolm in the Middle", "Monk", "Mr. Bean", "Mr. Robot", "Modern Family", "Narcos",
  "NCIS", "Orange Is the New Black", "Parks and Recreation", "Peaky Blinders", "Person of Interest", "Prison Break",
  "Psych", "Rescue Me", "Sense8", "Seinfeld", "Sex and the City", "Sherlock (BBC)", "Smallville",
  "Sons of Anarchy", "Stargate Atlantis", "Stranger Things", "Succession", "Supernatural", "Ted Lasso",
  "The Apprentice", "The Big Bang Theory", "The Blacklist", "The Boys", "The Flash", "The Fresh Prince of Bel-Air",
  "The Golden Girls", "The Joe Rogan Experience", "The Last of Us", "The Mentalist", "The Night Manager", "The Office",
  "The Rookie", "The Sarah Silverman Program", "The Shield", "The Sopranos", "The Walking Dead", "The West Wing",
  "The Wire", "The X-Files", "True Detective", "Two and a Half Men", "Vikings", "Westworld", "Yellowstone",
]);
const SUPERHERO_PATTERN = /Avengers|Batman|Black Panther|Daredevil|Deadpool|Doctor Strange|Ghost Rider|Jessica Jones|Luke Cage|Marvel|Peacemaker|Shang-Chi|Spider-Man|Superman|Thor|Venom|Wonder Woman|X-Men/i;
const FANTASY_PATTERN = /Avatar|Conan|Dune|Fantastic Beasts|Game of Thrones|Harry Potter|Hobbit|House of the Dragon|Jumanji|Lord of the Rings|Maleficent|Pirates of the Caribbean|Scorpion King|Star Trek|Star Wars|Twilight|Witcher/i;

const characterSubcategory = (franchise: string): string => {
  if (franchise === PUBLIC_FIGURE) return "Public figures";
  if (ANIMATED_FRANCHISES.has(franchise)) return "Animation";
  if (SUPERHERO_PATTERN.test(franchise)) return "Superheroes";
  if (FANTASY_PATTERN.test(franchise)) return "Sci-fi & fantasy";
  if (TV_FRANCHISES.has(franchise)) return "Television";
  return "Film";
};

const safeId = (value: string) => value.toLocaleLowerCase().normalize("NFKD")
  .replace(/[\u0300-\u036f]/g, "")
  .replace(/[^a-z0-9]+/g, "-")
  .replace(/(^-|-$)/g, "");

const duplicateNames = new Map<string, number>();
for (const [name] of KNOWN_CHARACTERS) duplicateNames.set(name, (duplicateNames.get(name) ?? 0) + 1);

const knownCharacterPresets: ReferencePreset[] = KNOWN_CHARACTERS.map<ReferencePreset>(([name, actor, franchise], index) => ({
  id: `character-known-${safeId(name)}-${index + 1}`,
  type: "character",
  subcategory: characterSubcategory(franchise),
  name: (duplicateNames.get(name) ?? 0) > 1 ? `${name} · ${actor}` : name,
  prompt: franchise === PUBLIC_FIGURE
    ? `${name}.`
    : (duplicateNames.get(name) ?? 0) > 1 ? `${name}, ${actor} portrayal.` : `${name} from ${franchise}.`,
  searchTerms: `${actor} ${franchise}`,
})).map(withIcon);

/** Product, location and style catalogs contain unique subjects. Qualifying
 * adjectives no longer multiply each subject into five near-duplicates. */
const optionsAsPresets = (type: PresetReferenceType, groups: readonly OptionGroup[]): ReferencePreset[] =>
  groups.flatMap((group) => group.options.map((option) => ({
    id: `${type}-${safeId(group.subcategory)}-${safeId(option)}`,
    type,
    subcategory: group.subcategory,
    name: option,
    prompt: `${option}.`,
  })));

const animalPresets = optionsAsPresets("animal", ANIMAL_GROUPS).map(withIcon);
const productPresets = optionsAsPresets("product", PRODUCT_GROUPS).map(withIcon);
const locationPresets = optionsAsPresets("location", LOCATION_GROUPS).map(withIcon);
const stylePresets = optionsAsPresets("style", STYLE_GROUPS).map(withIcon);

export type LocationSettings = Partial<Record<(typeof LOCATION_SETTING_GROUPS)[number]["id"], string>>;

export interface LocationSelection {
  preset: ReferencePreset;
  settings: LocationSettings;
}

export function composeLocationPrompt(preset: ReferencePreset, settings: LocationSettings): string {
  const qualifiers = LOCATION_SETTING_GROUPS.flatMap((group) => {
    const option = group.options.find((candidate) => candidate.id === settings[group.id]);
    return option ? [option.prompt] : [];
  });
  return `${preset.name}${qualifiers.length ? `, ${qualifiers.join(", ")}` : ""}.`;
}

/** Recovers picker state from its prompt, avoiding UI-only fields in portable
 * project JSON. Only a prompt this picker itself can compose is recognized. */
export function locationSelectionFromPrompt(prompt: string): LocationSelection | undefined {
  for (const preset of [...locationPresets].sort((left, right) => right.name.length - left.name.length)) {
    const base = preset.name;
    if (prompt === `${base}.`) return { preset, settings: {} };
    if (!prompt.startsWith(`${base}, `) || !prompt.endsWith(".")) continue;
    const qualifiers = prompt.slice(base.length + 2, -1).split(", ");
    const settings: LocationSettings = {};
    let lastGroup = -1;
    let valid = true;
    for (const qualifier of qualifiers) {
      const groupIndex = LOCATION_SETTING_GROUPS.findIndex((group) => group.options.some((option) => option.prompt === qualifier));
      const option = groupIndex >= 0 ? LOCATION_SETTING_GROUPS[groupIndex].options.find((candidate) => candidate.prompt === qualifier) : undefined;
      if (!option || groupIndex <= lastGroup) { valid = false; break; }
      settings[LOCATION_SETTING_GROUPS[groupIndex].id] = option.id;
      lastGroup = groupIndex;
    }
    if (valid && composeLocationPrompt(preset, settings) === prompt) return { preset, settings };
  }
  return undefined;
}

const curatedCharacterPresets: ReferencePreset[] = ([
  { id: "character-alice", type: "character", subcategory: "Literature & legend", name: "Alice in Wonderland", prompt: "Alice in her blue dress and white apron." },
  { id: "character-dracula", type: "character", subcategory: "Literature & legend", name: "Count Dracula", prompt: "Count Dracula in formal black evening wear." },
  { id: "character-robin-hood", type: "character", subcategory: "Literature & legend", name: "Robin Hood", prompt: "Robin Hood in practical forest-green clothing." },
  { id: "character-peter-pan", type: "character", subcategory: "Literature & legend", name: "Peter Pan", prompt: "Peter Pan in simple green woodland clothes." },
  { id: "character-frankenstein", type: "character", subcategory: "Literature & legend", name: "Frankenstein's Creature", prompt: "Frankenstein's towering, solemn creature." },
  { id: "character-dorothy-gale", type: "character", subcategory: "Literature & legend", name: "Dorothy Gale", prompt: "Dorothy Gale in a blue gingham dress." },
  { id: "character-king-arthur", type: "character", subcategory: "Literature & legend", name: "King Arthur", prompt: "King Arthur in polished medieval armor." },
] as ReferencePreset[]).map(withIcon);

export const REFERENCE_PRESETS: readonly ReferencePreset[] = [
  ...knownCharacterPresets,
  ...animalPresets,
  ...productPresets,
  ...locationPresets,
  ...stylePresets,
  ...curatedCharacterPresets,
].sort((left, right) => left.type.localeCompare(right.type) || left.subcategory.localeCompare(right.subcategory) || left.name.localeCompare(right.name));

const presetForReference = (reference: ProjectReference): ReferencePreset | undefined => {
  const intended = reference.intendedUse.length === 1 ? reference.intendedUse[0] : undefined;
  return REFERENCE_PRESETS.find((preset) => preset.type === intended && preset.prompt === reference.description)
    ?? (intended === "location" ? locationSelectionFromPrompt(reference.description)?.preset : undefined);
};

export function referenceType(reference: ProjectReference): ReferenceType {
  const stored = reference.intendedUse.length === 1
    ? REFERENCE_TYPES.find((type) => type.id === reference.intendedUse[0])?.id
    : undefined;
  return stored ?? "custom";
}

export const referenceTypeLabel = (type: ReferenceType): string =>
  REFERENCE_TYPES.find((candidate) => candidate.id === type)?.label ?? "Uncategorized";

export const referenceSubcategories = (type: ReferenceType): string[] =>
  [...new Set(REFERENCE_PRESETS.filter((preset) => preset.type === type).map((preset) => preset.subcategory))];

export const selectedReferencePreset = (reference: ProjectReference): ReferencePreset | undefined => {
  const preset = presetForReference(reference);
  return preset?.type === referenceType(reference) ? preset : undefined;
};
