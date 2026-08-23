import { KNOWN_CHARACTERS } from "./known-characters";
import {
  LOCATION_GROUPS,
  LOCATION_VARIANTS,
  PRODUCT_GROUPS,
  PRODUCT_VARIANTS,
  STYLE_GROUPS,
  STYLE_VARIANTS,
  type OptionGroup,
  type OptionVariant,
} from "./expanded-reference-options";
import type { ProjectReference } from "./project";

export type ReferenceType = "custom" | "character" | "product" | "location" | "style";
export type PresetReferenceType = Exclude<ReferenceType, "custom">;

export interface ReferencePreset {
  id: string;
  type: PresetReferenceType;
  subcategory: string;
  name: string;
  prompt: string;
  searchTerms?: string;
}

export const REFERENCE_TYPES: ReadonlyArray<{ id: ReferenceType; label: string }> = [
  { id: "custom", label: "Custom" },
  { id: "character", label: "Character" },
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

const knownCharacterPresets: ReferencePreset[] = KNOWN_CHARACTERS.map(([name, actor, franchise], index) => ({
  id: `character-known-${safeId(name)}-${index + 1}`,
  type: "character",
  subcategory: characterSubcategory(franchise),
  name: (duplicateNames.get(name) ?? 0) > 1 ? `${name} · ${actor}` : name,
  prompt: franchise === PUBLIC_FIGURE
    ? `${name}.`
    : (duplicateNames.get(name) ?? 0) > 1 ? `${name}, ${actor} portrayal.` : `${name} from ${franchise}.`,
  searchTerms: `${actor} ${franchise}`,
}));

const expandOptions = (
  type: PresetReferenceType,
  groups: readonly OptionGroup[],
  variants: readonly OptionVariant[],
  label: (option: string, variant: OptionVariant) => string,
  prompt: (option: string, variant: OptionVariant) => string,
): ReferencePreset[] => groups.flatMap((group) => group.options.flatMap((option) => variants.map((variant) => ({
  id: `${type}-${safeId(group.subcategory)}-${safeId(option)}-${safeId(variant.name)}`,
  type,
  subcategory: group.subcategory,
  name: label(option, variant),
  prompt: prompt(option, variant),
}))));

const expandedProductPresets = expandOptions(
  "product",
  PRODUCT_GROUPS,
  PRODUCT_VARIANTS,
  (option, variant) => `${variant.name} ${option}`,
  (option, variant) => `${variant.prompt} ${option.toLocaleLowerCase()}.`,
);
const expandedLocationPresets = expandOptions(
  "location",
  LOCATION_GROUPS,
  LOCATION_VARIANTS,
  (option, variant) => `${option} · ${variant.name}`,
  (option, variant) => `${option}, ${variant.prompt}.`,
);
const expandedStylePresets = expandOptions(
  "style",
  STYLE_GROUPS,
  STYLE_VARIANTS,
  (option, variant) => `${variant.name} ${option}`,
  (option, variant) => `${variant.prompt} ${option.toLocaleLowerCase()}.`,
);

const curatedPresets: ReferencePreset[] = [
  { id: "character-alice", type: "character", subcategory: "Literature & legend", name: "Alice in Wonderland", prompt: "Alice in her blue dress and white apron." },
  { id: "character-dracula", type: "character", subcategory: "Literature & legend", name: "Count Dracula", prompt: "Count Dracula in formal black evening wear." },
  { id: "character-robin-hood", type: "character", subcategory: "Literature & legend", name: "Robin Hood", prompt: "Robin Hood in practical forest-green clothing." },
  { id: "character-peter-pan", type: "character", subcategory: "Literature & legend", name: "Peter Pan", prompt: "Peter Pan in simple green woodland clothes." },
  { id: "character-frankenstein", type: "character", subcategory: "Literature & legend", name: "Frankenstein's Creature", prompt: "Frankenstein's towering, solemn creature." },
  { id: "character-dorothy-gale", type: "character", subcategory: "Literature & legend", name: "Dorothy Gale", prompt: "Dorothy Gale in a blue gingham dress." },
  { id: "character-king-arthur", type: "character", subcategory: "Literature & legend", name: "King Arthur", prompt: "King Arthur in polished medieval armor." },

  { id: "product-watch", type: "product", subcategory: "Fashion", name: "Luxury wristwatch", prompt: "Brushed steel watch with sapphire crystal." },
  { id: "product-skincare", type: "product", subcategory: "Beauty", name: "Skincare bottle", prompt: "Minimal frosted-glass skincare bottle." },
  { id: "product-sneaker", type: "product", subcategory: "Fashion", name: "Performance sneaker", prompt: "Modern mesh sneaker with a sculpted sole." },
  { id: "product-smartphone", type: "product", subcategory: "Technology", name: "Flagship smartphone", prompt: "Slim glass smartphone with a satin frame." },
  { id: "product-car", type: "product", subcategory: "Vehicles", name: "Sports car", prompt: "Low sports car with precise LED lights." },
  { id: "product-coffee", type: "product", subcategory: "Appliances", name: "Espresso machine", prompt: "Compact brushed-steel espresso machine." },
  { id: "product-chair", type: "product", subcategory: "Furniture", name: "Designer lounge chair", prompt: "Sculptural wood and fabric lounge chair." },

  { id: "location-cyberpunk-alley", type: "location", subcategory: "Urban", name: "Neon city alley", prompt: "Rainy neon alley with reflective pavement." },
  { id: "location-victorian-manor", type: "location", subcategory: "Historic", name: "Victorian manor", prompt: "Weathered Victorian manor with dark wood." },
  { id: "location-moon-base", type: "location", subcategory: "Sci-fi", name: "Lunar research base", prompt: "White lunar base under harsh sunlight." },
  { id: "location-alpine-village", type: "location", subcategory: "Nature", name: "Alpine village", prompt: "Timber village beneath snowy mountains." },
  { id: "location-art-deco-lobby", type: "location", subcategory: "Interiors", name: "Art Deco hotel lobby", prompt: "Brass and dark-stone Art Deco lobby." },
  { id: "location-medieval-market", type: "location", subcategory: "Historic", name: "Medieval market", prompt: "Busy medieval market with canvas stalls." },
  { id: "location-tropical-beach", type: "location", subcategory: "Nature", name: "Remote tropical beach", prompt: "Secluded turquoise beach with palms." },
  { id: "location-modern-studio", type: "location", subcategory: "Interiors", name: "Modern creative studio", prompt: "Bright timber studio with large windows." },

  { id: "style-film-noir", type: "style", subcategory: "Cinematic", name: "Film noir", prompt: "High-contrast monochrome with hard shadows." },
  { id: "style-documentary", type: "style", subcategory: "Cinematic", name: "35 mm documentary", prompt: "Natural light, handheld framing, subtle grain." },
  { id: "style-watercolor", type: "style", subcategory: "Illustration", name: "Storybook watercolor", prompt: "Soft watercolor on textured paper." },
  { id: "style-stop-motion", type: "style", subcategory: "Animation", name: "Handmade stop motion", prompt: "Tactile miniatures with stepped movement." },
  { id: "style-editorial", type: "style", subcategory: "Commercial", name: "Luxury editorial", prompt: "Sculpted light and deliberate negative space." },
  { id: "style-retrofuturism", type: "style", subcategory: "Retro", name: "1970s retrofuturism", prompt: "Rounded forms and warm analog controls." },
  { id: "style-anime", type: "style", subcategory: "Animation", name: "Cinematic anime", prompt: "Clean linework with painted backgrounds." },
  { id: "style-clay", type: "style", subcategory: "Animation", name: "Clay animation", prompt: "Hand-sculpted clay with playful movement." },
];

export const REFERENCE_PRESETS: readonly ReferencePreset[] = [
  ...knownCharacterPresets,
  ...expandedProductPresets,
  ...expandedLocationPresets,
  ...expandedStylePresets,
  ...curatedPresets,
]
  .sort((left, right) => left.type.localeCompare(right.type) || left.subcategory.localeCompare(right.subcategory) || left.name.localeCompare(right.name));

export function referenceType(reference: ProjectReference): ReferenceType {
  const stored = reference.intendedUse.length === 1
    ? REFERENCE_TYPES.find((type) => type.id !== "custom" && type.id === reference.intendedUse[0])?.id
    : undefined;
  /* Existing references were all free-written prompts, even when they carried
   * one or more library tags. They stay editable as Custom. A non-custom type
   * is only claimed when its prompt is one of that type's actual presets. */
  return stored && REFERENCE_PRESETS.some((preset) => preset.type === stored && preset.prompt === reference.description)
    ? stored
    : "custom";
}

export const referenceTypeLabel = (type: ReferenceType): string =>
  REFERENCE_TYPES.find((candidate) => candidate.id === type)?.label ?? "Custom";

export const selectedReferencePreset = (reference: ProjectReference): ReferencePreset | undefined =>
  REFERENCE_PRESETS.find((preset) => preset.type === referenceType(reference) && preset.prompt === reference.description);
