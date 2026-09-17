import h3ShotGroups from "../../shared/models/minimax-h3-shot-tags.json";
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
  /** True for a setting that describes the WHOLE scene rather than one shot.
   *  Base guide §4.1 opens the description with a single overall style, so a
   *  second style on shot 3 has nowhere to go: `compileScenePromptSegments`
   *  takes the style from the first shot that carries one and ignores the rest.
   *  The picker says so rather than letting someone set a look per shot and
   *  wonder why only one of them reached the prompt. */
  sceneWide?: boolean;
  options: readonly ShotTagOption[];
}

/** Group id -> chosen option ids. Persisted verbatim; see `generationJobSchema`. */
export type ShotTagSelection = Record<string, string[]>;

/** Ids both validators accept. Kept in lockstep with `is_shot_tag_id` in
 *  src-tauri/src/lib.rs — a shape neither layer has to guess about. */
export const SHOT_TAG_ID_PATTERN = /^[a-z][a-zA-Z0-9-]*$/;

/** The persisted H3 vocabulary is shared with the Rust agent policy. */
export const SHOT_TAG_GROUPS: readonly ShotTagGroup[] = h3ShotGroups as readonly ShotTagGroup[];

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

/** One sentence the tags contribute after the user's description. Kept split
 *  so the compiler can mark the LABEL as Slopus's own scaffolding and the
 *  TERMS as the user's choices — a pre-joined sentence would have to be
 *  attributed to one or the other, and both answers would be wrong. */
export interface ShotTagClause {
  /** The field name Slopus writes, e.g. "Camera movement". */
  label: string;
  /** The chosen terms, in taxonomy order. */
  terms: string[];
}

/** What the tags contribute to one `[Shot N]`, split by where it lands. */
export interface ShotTagClauses {
  /** Canonical H3 style name, or null to keep deriving it from the user's words. */
  style: string | null;
  /** Framing terms, in guide order, that precede the user's description. */
  framing: string[];
  /** Sentences that follow the user's description, in guide order. */
  clauses: ShotTagClause[];
}

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

  const clauses: ShotTagClause[] = [];
  const movement = shotTagTerms(selection, "cameraMovement");
  if (movement.length > 0) {
    // Speed and amplitude qualify the movement, so they ride in the same
    // clause. Without a movement they say nothing and are left out entirely —
    // the picker disables them for the same reason.
    const qualifiers = [...shotTagTerms(selection, "cameraSpeed"), ...shotTagTerms(selection, "cameraAmplitude")];
    clauses.push({ label: "Camera movement", terms: [...movement, ...qualifiers] });
  }
  const push = (label: string, groupId: ShotTagGroupId) => {
    const terms = shotTagTerms(selection, groupId);
    if (terms.length > 0) clauses.push({ label, terms });
  };
  push("Lighting", "lighting");
  push("Time of day", "timeOfDay");
  push("Mood", "mood");
  push("Motion", "motionPace");

  return { style, framing, clauses };
}
