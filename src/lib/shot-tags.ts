/* ---------------------------------------------------------------------------
   The MiniMax H3 shot vocabulary, in one place.

   Every string a tag can contribute to a compiled prompt lives here and
   NOWHERE else. The rule this file exists to enforce is that the words handed
   to the engine are the guide's own terms — "push in", "medium close-up",
   "low-key lighting" — never a synonym this app invented on the user's behalf.
   If a term is not in the guide it does not belong in `term`.

   Two vocabularies, deliberately separate on every option:

   - `label` is what the picker shows. It may be friendlier than the guide.
   - `term`  is what is compiled into the prompt. It is the guide's wording,
     written mid-sentence (lowercase unless the guide capitalises it), because
     the compiler splices it into a sentence and capitalises the lead itself.

   The ids are persisted in `pols.json`, so they are stable forever: rename a
   `label` freely, never an `id`. Both validators constrain ids to
   `SHOT_TAG_ID_PATTERN` (src/lib/project.ts and src-tauri/src/lib.rs), so a new
   id has to keep that shape.
   --------------------------------------------------------------------------- */

/** One choosable term. */
export interface ShotTagOption {
  /** Persisted in the project file. Never change one. */
  id: string;
  /** What the picker shows. */
  label: string;
  /** The guide's own wording, as it is spliced into the prompt. */
  term: string;
}

export type ShotTagGroupId =
  | "visualStyle"
  | "shotSize"
  | "cameraAngle"
  | "lens"
  | "cameraMovement"
  | "cameraSpeed"
  | "cameraAmplitude"
  | "lighting"
  | "timeOfDay"
  | "mood"
  | "motionPace";

export interface ShotTagGroup {
  id: ShotTagGroupId;
  /** Picker heading. */
  label: string;
  /** One line saying what this group does to the prompt. Shown in the UI so
   *  nobody has to guess which part of the sentence a tag lands in. */
  help: string;
  /** Whether more than one option may be held at once. */
  multiple: boolean;
  /** Only offered once a camera movement is chosen — "slow speed" on its own
   *  describes nothing, and the compiler drops it (see `shotTagClauses`). */
  requiresMovement?: boolean;
  options: readonly ShotTagOption[];
}

/** Group id -> chosen option ids. Persisted verbatim; see `generationJobSchema`. */
export type ShotTagSelection = Record<string, string[]>;

/** Ids both validators accept. Kept in lockstep with `is_shot_tag_id` in
 *  src-tauri/src/lib.rs — a shape neither layer has to guess about. */
export const SHOT_TAG_ID_PATTERN = /^[a-z][a-z0-9-]*$/;

/* The canonical H3 style names. These are the SAME seven strings
   `deriveH3Style` can produce, and `MID_SENTENCE_STYLES` in project.ts already
   knows how to spell each of them mid-sentence — so choosing one here can
   simply replace the guess made from the user's words. */
const VISUAL_STYLES: readonly ShotTagOption[] = [
  { id: "live-action-cinematic", label: "Live action, cinematic", term: "Live-action, cinematic" },
  { id: "live-action-documentary", label: "Live action, documentary", term: "Live-action, documentary" },
  { id: "vintage-film", label: "Vintage film", term: "Vintage film" },
  { id: "animated-2d", label: "2D animation", term: "2D-animated" },
  { id: "cg-3d", label: "3D CG", term: "3D CG" },
  { id: "claymation", label: "Claymation", term: "Claymation" },
  { id: "watercolor", label: "Watercolor", term: "Watercolor" },
];

export const SHOT_TAG_GROUPS: readonly ShotTagGroup[] = [
  {
    id: "visualStyle",
    label: "Look",
    help: "Opens the shot. Choosing one replaces the style PolStudio would otherwise guess from your words.",
    multiple: false,
    options: VISUAL_STYLES,
  },
  {
    id: "shotSize",
    label: "Shot size",
    help: "How much of the subject is in frame. Sits in front of your description.",
    multiple: false,
    options: [
      { id: "extreme-wide", label: "Extreme wide", term: "extreme wide shot" },
      { id: "wide", label: "Wide", term: "wide shot" },
      { id: "full", label: "Full", term: "full shot" },
      { id: "medium-full", label: "Medium full", term: "medium full shot" },
      { id: "medium", label: "Medium", term: "medium shot" },
      { id: "medium-close-up", label: "Medium close-up", term: "medium close-up" },
      { id: "close-up", label: "Close-up", term: "close-up" },
      { id: "extreme-close-up", label: "Extreme close-up", term: "extreme close-up" },
    ],
  },
  {
    id: "cameraAngle",
    label: "Camera angle",
    help: "Where the camera sits relative to the subject.",
    multiple: false,
    options: [
      { id: "eye-level", label: "Eye level", term: "eye-level angle" },
      { id: "low-angle", label: "Low angle", term: "low angle" },
      { id: "high-angle", label: "High angle", term: "high angle" },
      { id: "overhead", label: "Overhead", term: "overhead angle" },
      { id: "dutch-angle", label: "Dutch angle", term: "dutch angle" },
      { id: "over-the-shoulder", label: "Over the shoulder", term: "over-the-shoulder angle" },
      { id: "point-of-view", label: "Point of view", term: "point-of-view shot" },
    ],
  },
  {
    id: "lens",
    label: "Lens",
    help: "The optics the shot is described as being taken on.",
    multiple: false,
    options: [
      { id: "wide-angle-lens", label: "Wide angle", term: "wide-angle lens" },
      { id: "standard-lens", label: "Standard", term: "standard lens" },
      { id: "telephoto-lens", label: "Telephoto", term: "telephoto lens" },
      { id: "macro-lens", label: "Macro", term: "macro lens" },
      { id: "fisheye-lens", label: "Fisheye", term: "fisheye lens" },
      { id: "anamorphic-lens", label: "Anamorphic", term: "anamorphic lens" },
    ],
  },
  {
    id: "cameraMovement",
    label: "Camera movement",
    help: "What the camera does during the shot. Written as its own clause after your description.",
    multiple: true,
    options: [
      { id: "static-shot", label: "Static", term: "static shot" },
      { id: "push-in", label: "Push in", term: "push in" },
      { id: "pull-out", label: "Pull out", term: "pull out" },
      { id: "pan-left", label: "Pan left", term: "pan left" },
      { id: "pan-right", label: "Pan right", term: "pan right" },
      { id: "tilt-up", label: "Tilt up", term: "tilt up" },
      { id: "tilt-down", label: "Tilt down", term: "tilt down" },
      { id: "truck-left", label: "Truck left", term: "truck left" },
      { id: "truck-right", label: "Truck right", term: "truck right" },
      { id: "pedestal-up", label: "Pedestal up", term: "pedestal up" },
      { id: "pedestal-down", label: "Pedestal down", term: "pedestal down" },
      { id: "zoom-in", label: "Zoom in", term: "zoom in" },
      { id: "zoom-out", label: "Zoom out", term: "zoom out" },
      { id: "tracking-shot", label: "Tracking", term: "tracking shot" },
      { id: "arc-shot", label: "Arc", term: "arc shot" },
      { id: "crane-up", label: "Crane up", term: "crane up" },
      { id: "crane-down", label: "Crane down", term: "crane down" },
      { id: "handheld", label: "Handheld", term: "handheld" },
      { id: "whip-pan", label: "Whip pan", term: "whip pan" },
      { id: "rack-focus", label: "Rack focus", term: "rack focus" },
    ],
  },
  /* The guide asks for a movement to be qualified by HOW FAR and HOW FAST, not
     just named, so both get their own control rather than being buried in an
     adjective the user has to remember to type. Neither is offered — or
     compiled — without a movement to qualify. */
  {
    id: "cameraSpeed",
    label: "Movement speed",
    help: "How fast the camera moves. Only used once a movement is chosen.",
    multiple: false,
    requiresMovement: true,
    options: [
      { id: "slow", label: "Slow", term: "slow speed" },
      { id: "steady", label: "Steady", term: "steady speed" },
      { id: "fast", label: "Fast", term: "fast speed" },
    ],
  },
  {
    id: "cameraAmplitude",
    label: "Movement amplitude",
    help: "How far the camera travels. Only used once a movement is chosen.",
    multiple: false,
    requiresMovement: true,
    options: [
      { id: "small", label: "Small", term: "small amplitude" },
      { id: "moderate", label: "Moderate", term: "moderate amplitude" },
      { id: "large", label: "Large", term: "large amplitude" },
    ],
  },
  {
    id: "lighting",
    label: "Lighting",
    help: "How the scene is lit.",
    multiple: true,
    options: [
      { id: "soft-light", label: "Soft light", term: "soft light" },
      { id: "hard-light", label: "Hard light", term: "hard light" },
      { id: "natural-light", label: "Natural light", term: "natural light" },
      { id: "practical-light", label: "Practical light", term: "practical light" },
      { id: "backlight", label: "Backlight", term: "backlight" },
      { id: "rim-light", label: "Rim light", term: "rim light" },
      { id: "side-light", label: "Side light", term: "side light" },
      { id: "top-light", label: "Top light", term: "top light" },
      { id: "high-key", label: "High key", term: "high-key lighting" },
      { id: "low-key", label: "Low key", term: "low-key lighting" },
      { id: "silhouette", label: "Silhouette", term: "silhouette lighting" },
      { id: "volumetric-light", label: "Volumetric", term: "volumetric light" },
      { id: "firelight", label: "Firelight", term: "firelight" },
      { id: "moonlight", label: "Moonlight", term: "moonlight" },
      { id: "neon-light", label: "Neon", term: "neon light" },
    ],
  },
  {
    id: "timeOfDay",
    label: "Time of day",
    help: "When the shot happens.",
    multiple: false,
    options: [
      { id: "dawn", label: "Dawn", term: "dawn" },
      { id: "sunrise", label: "Sunrise", term: "sunrise" },
      { id: "morning", label: "Morning", term: "morning" },
      { id: "midday", label: "Midday", term: "midday" },
      { id: "afternoon", label: "Afternoon", term: "afternoon" },
      { id: "golden-hour", label: "Golden hour", term: "golden hour" },
      { id: "sunset", label: "Sunset", term: "sunset" },
      { id: "dusk", label: "Dusk", term: "dusk" },
      { id: "blue-hour", label: "Blue hour", term: "blue hour" },
      { id: "night", label: "Night", term: "night" },
    ],
  },
  {
    id: "mood",
    label: "Mood",
    help: "The feeling of the shot.",
    multiple: true,
    options: [
      { id: "intimate", label: "Intimate", term: "intimate" },
      { id: "calm", label: "Calm", term: "calm" },
      { id: "tense", label: "Tense", term: "tense" },
      { id: "ominous", label: "Ominous", term: "ominous" },
      { id: "melancholic", label: "Melancholic", term: "melancholic" },
      { id: "nostalgic", label: "Nostalgic", term: "nostalgic" },
      { id: "joyful", label: "Joyful", term: "joyful" },
      { id: "playful", label: "Playful", term: "playful" },
      { id: "mysterious", label: "Mysterious", term: "mysterious" },
      { id: "epic", label: "Epic", term: "epic" },
      { id: "dreamlike", label: "Dreamlike", term: "dreamlike" },
      { id: "solemn", label: "Solemn", term: "solemn" },
    ],
  },
  {
    id: "motionPace",
    label: "Motion",
    help: "How fast the action itself runs.",
    multiple: false,
    options: [
      { id: "slow-motion", label: "Slow motion", term: "slow motion" },
      { id: "real-time", label: "Real time", term: "real time" },
      { id: "fast-motion", label: "Fast motion", term: "fast motion" },
      { id: "time-lapse", label: "Time-lapse", term: "time-lapse" },
    ],
  },
];

const GROUPS_BY_ID: ReadonlyMap<string, ShotTagGroup> = new Map(SHOT_TAG_GROUPS.map((group) => [group.id, group]));

export function shotTagGroup(id: string): ShotTagGroup | undefined {
  return GROUPS_BY_ID.get(id);
}

/** The terms chosen in one group, in the group's own option order.
 *  Order comes from the taxonomy, not from the order boxes were ticked, so the
 *  same set of tags always compiles to the same bytes. Ids this build does not
 *  know are skipped rather than guessed at — see `normalizeShotTagSelection`
 *  for why they are still KEPT in the file. */
export function shotTagTerms(selection: ShotTagSelection | null | undefined, groupId: ShotTagGroupId): string[] {
  const group = GROUPS_BY_ID.get(groupId);
  const chosen = selection?.[groupId];
  if (!group || !chosen || chosen.length === 0) return [];
  return group.options.filter((option) => chosen.includes(option.id)).map((option) => option.term);
}

/** Every option the user has chosen, across all groups, for counting and for
 *  listing back what is set. Unknown ids are left out — they cannot be shown
 *  as a term because this build has no term for them. */
export function selectedShotTagOptions(selection: ShotTagSelection | null | undefined): Array<{ group: ShotTagGroup; option: ShotTagOption }> {
  if (!selection) return [];
  return SHOT_TAG_GROUPS.flatMap((group) => {
    const chosen = selection[group.id] ?? [];
    return group.options.filter((option) => chosen.includes(option.id)).map((option) => ({ group, option }));
  });
}

export function countShotTags(selection: ShotTagSelection | null | undefined): number {
  return selectedShotTagOptions(selection).length;
}

/** Tidies a selection for storage: drops empty groups, drops repeats, and
 *  returns `null` when nothing is left so the field is omitted from the file
 *  rather than written as an empty object.
 *
 *  It deliberately does NOT drop ids this build doesn't recognise. A project
 *  written by a newer build would otherwise lose the user's choices the first
 *  time an older build re-saved it. `validate_and_normalize_config` in
 *  src-tauri/src/lib.rs performs exactly these three steps, in this order, so
 *  the file is byte-identical whichever layer wrote it last. */
export function normalizeShotTagSelection(selection: ShotTagSelection | null | undefined): ShotTagSelection | null {
  if (!selection) return null;
  const normalized: ShotTagSelection = {};
  for (const groupId of Object.keys(selection).sort()) {
    const kept: string[] = [];
    for (const optionId of selection[groupId] ?? []) {
      if (!kept.includes(optionId)) kept.push(optionId);
    }
    if (kept.length > 0) normalized[groupId] = kept;
  }
  return Object.keys(normalized).length > 0 ? normalized : null;
}

/** Ticks or unticks one option, respecting the group's cardinality.
 *  Returns a NEW selection; never mutates the one passed in. */
export function toggleShotTag(selection: ShotTagSelection | null | undefined, groupId: string, optionId: string): ShotTagSelection {
  const current = { ...(selection ?? {}) };
  const chosen = current[groupId] ?? [];
  const group = GROUPS_BY_ID.get(groupId);
  if (chosen.includes(optionId)) current[groupId] = chosen.filter((id) => id !== optionId);
  else current[groupId] = group?.multiple ? [...chosen, optionId] : [optionId];
  return normalizeShotTagSelection(current) ?? {};
}

/** Whether a movement has been chosen, which is what makes speed and amplitude
 *  meaningful. Both the picker and the compiler ask this same question, so a
 *  control the UI greys out is exactly the one the prompt would ignore. */
export function hasCameraMovement(selection: ShotTagSelection | null | undefined): boolean {
  return shotTagTerms(selection, "cameraMovement").length > 0;
}

/** What the tags contribute to one `[Shot N]`, split by where it lands. */
export interface ShotTagClauses {
  /** Canonical H3 style name, or null to keep deriving it from the user's words. */
  style: string | null;
  /** Framing terms, in guide order, that precede the user's description. */
  framing: string[];
  /** Whole sentences that follow the user's description, already terminated. */
  clauses: string[];
}

const list = (terms: string[]): string => terms.join(", ");

/** Guide order inside a shot: size, then angle, then lens, then the subject and
 *  its action (the user's own words), then the camera's move, then light, time,
 *  mood and the pace of the action. */
export function shotTagClauses(selection: ShotTagSelection | null | undefined): ShotTagClauses {
  const style = shotTagTerms(selection, "visualStyle")[0] ?? null;
  const framing = [
    ...shotTagTerms(selection, "shotSize"),
    ...shotTagTerms(selection, "cameraAngle"),
    ...shotTagTerms(selection, "lens"),
  ];

  const clauses: string[] = [];
  const movement = shotTagTerms(selection, "cameraMovement");
  if (movement.length > 0) {
    // Speed and amplitude qualify the movement, so they ride in the same
    // clause. Without a movement they say nothing and are left out entirely —
    // the picker disables them for the same reason.
    const qualifiers = [...shotTagTerms(selection, "cameraSpeed"), ...shotTagTerms(selection, "cameraAmplitude")];
    clauses.push(`Camera movement: ${list([...movement, ...qualifiers])}.`);
  }
  const lighting = shotTagTerms(selection, "lighting");
  if (lighting.length > 0) clauses.push(`Lighting: ${list(lighting)}.`);
  const timeOfDay = shotTagTerms(selection, "timeOfDay");
  if (timeOfDay.length > 0) clauses.push(`Time of day: ${list(timeOfDay)}.`);
  const mood = shotTagTerms(selection, "mood");
  if (mood.length > 0) clauses.push(`Mood: ${list(mood)}.`);
  const pace = shotTagTerms(selection, "motionPace");
  if (pace.length > 0) clauses.push(`Motion: ${list(pace)}.`);

  return { style, framing, clauses };
}
