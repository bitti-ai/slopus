import { expect, it } from "vitest";
import {
  audioReferenceBlocker, compileMiniMaxH3Prompt, compileScenePromptSegments, createDraftGenerationJob, danglingReferenceTokens, isReferenceUsable,
  projectReferenceSchema, referenceAudioNumbers, referenceToken, sceneGenerationSnapshot, sceneGenerationReferences, compileGenerationJobPrompt, usableAudioReferences, usableReferenceImages, type ProjectReference,
} from "./project";
import { referenceAudioPcm, referenceAudioRange } from "./referenceAudio";

const extension = { video: "mp4", audio: "wav", image: "png", text: "" } as const;
const reference = (id: string, kind: ProjectReference["kind"], description = ""): ProjectReference => ({
  id, kind, name: id, description, intendedUse: [], createdAt: "2026-10-03T00:00:00.000Z",
  ...(kind !== "text" ? { sourcePath: `C:/references/${id}.${extension[kind]}` } : {}),
  ...(kind === "audio" ? { audio: { startSeconds: 0, durationSeconds: 5 } } : {}),
});
const compile = (action: string, references: ProjectReference[]) =>
  compileScenePromptSegments({ shots: [{ id: "shot", startSeconds: 0, action, settings: null }] }, references).map((segment) => segment.value).join("");

it("numbers standalone sounds after enabled video soundtracks", () => {
  const withSound = { ...reference("talk", "video"), video: { startSeconds: 0, durationSeconds: 4, includeAudio: true } };
  const silent = { ...reference("walk", "video"), video: { startSeconds: 0, durationSeconds: 4, includeAudio: false } };
  const voice = reference("voice", "audio", "The voice timbre for the narrator");
  const references = [voice, withSound, silent];
  expect(isReferenceUsable(voice)).toBe(true);
  expect(usableAudioReferences(references).map((item) => item.id)).toEqual(["voice"]);
  expect(referenceAudioNumbers(references).get("voice")).toBe(2);
  expect(referenceAudioNumbers(references, false).get("voice")).toBe(1);
  const prompt = compile(`The narrator speaks in ${referenceToken("voice")}.`, references);
  expect(prompt).toContain("<Audio 2>: The voice timbre for the narrator.");
  expect(prompt).toContain("The narrator speaks in <Audio 2>.");
  expect(prompt).toContain("[reference generation + audio reference]");
  expect(prompt).toContain("<Audio 2>: reference - its audible characteristics guide the target audio without copying the original signal.");
  expect(prompt).not.toMatch(/<Subject \d> is the content shown in <Audio/);
});

it("defines an undescribed sound without inventing its role and keeps it out of subjects and pictures", () => {
  const references = [reference("hero", "image"), reference("ambience", "audio")];
  const prompt = compileMiniMaxH3Prompt("A walk through the market.", references);
  expect(prompt).toContain("<Subject 1> is the content shown in <Picture 1>.\n<Audio 1> is a reference audio clip.");
  expect(prompt).not.toContain("<Subject 2>");
  expect(usableReferenceImages(references)).toHaveLength(1);
});

it("takes voice guidance from Speech chips while keeping only words inside dialogue tags", () => {
  const refs = [reference("voice", "audio"), reference("video", "video")];
  const job = createDraftGenerationJob("", { shots: [
    { id: "a", startSeconds: 0, action: "@[ref:video]", speech: "@[ref:voice] Hello, world!", speechLanguage: "French" },
    { id: "b", startSeconds: 3, action: "The camera pans.", speech: "Goodbye." },
  ] });
  const bound = sceneGenerationReferences(job, refs);
  expect(bound).toEqual(refs);
  const prompt = compileGenerationJobPrompt(job, bound);
  expect(prompt).toContain("Use the voice characteristics of <Audio 2> for the scene's speaker (S1).");
  expect(prompt).toContain("<d>[French] Hello, world!</d>");
  expect(prompt).toContain("<d>[English] Goodbye.</d>");
  expect(prompt.match(/Use the voice characteristics/g)).toHaveLength(1);
  expect(prompt).not.toContain("@[ref:");
  expect(prompt).not.toMatch(/<d>[^<]*<Audio/);
  job.shots![0].speech = "Hello, world!";
  expect(sceneGenerationReferences(job, refs).map(({ id }) => id)).toEqual(["video"]);
});

it("rejects missing or non-audio Speech references and deduplicates citations", () => {
  const refs = [reference("voice", "audio"), reference("hero", "image")];
  const shots = [{ id: "a", startSeconds: 0, action: "@[ref:hero]", speech: "@[ref:voice] @[ref:voice] Hello" }];
  expect(danglingReferenceTokens(shots, refs)).toEqual([]);
  const job = createDraftGenerationJob("", { shots });
  expect(sceneGenerationReferences(job, refs)).toHaveLength(2);
  expect(compileGenerationJobPrompt(job, refs).match(/Use the voice characteristics of <Audio 1>/g)).toHaveLength(1);
  shots[0].speech = "@[ref:hero] @[ref:missing] Hello";
  expect(danglingReferenceTokens(shots, refs)).toEqual(["hero", "missing"]);
});

it("keeps a voice-only chip as guidance without inventing dialogue", () => {
  const job = createDraftGenerationJob("A speaker", { shots: [{ id: "a", startSeconds: 0, action: "A speaker", speech: "@[ref:voice]" }] });
  const prompt = compileGenerationJobPrompt(job, [reference("voice", "audio"), reference("hero", "image")]);
  expect(prompt).toContain("Use the voice characteristics of <Audio 1>");
  expect(prompt).not.toContain("<d>");
});

it("lets shots cite sounds and blocks sounds without visual media", () => {
  const job = { ...createDraftGenerationJob("Scene"), referenceIds: ["voice"] };
  const voice = reference("voice", "audio");
  expect(danglingReferenceTokens([{ id: "shot", startSeconds: 0, action: referenceToken("voice") }], [voice])).toEqual([]);
  expect(audioReferenceBlocker(job, [voice])).toMatch(/image or video/);
  expect(audioReferenceBlocker({ ...job, usePreviousSceneLastFrame: true }, [voice])).toBeNull();
  expect(audioReferenceBlocker(job, [voice, reference("hero", "image")])).toBeNull();
  const sounds = ["a", "b", "c", "d"].map((id) => reference(id, "audio"));
  expect(audioReferenceBlocker(job, [reference("hero", "image"), ...sounds])).toMatch(/at most three/);
  expect(audioReferenceBlocker(job, [reference("hero", "image"), ...sounds.slice(0, 3).map((sound) => ({ ...sound, audio: { startSeconds: 0, durationSeconds: 6 } }))])).toMatch(/15 seconds/);
});

it("round trips sound options only on sound references", () => {
  const voice = reference("voice", "audio");
  expect(projectReferenceSchema.parse(JSON.parse(JSON.stringify(voice))).audio).toEqual(voice.audio);
  expect(projectReferenceSchema.safeParse({ ...voice, audio: { startSeconds: 0, durationSeconds: 1 } }).success).toBe(false);
  expect(projectReferenceSchema.safeParse({ ...reference("motion", "video"), audio: voice.audio }).success).toBe(false);
});

it("records sound ranges in generation snapshots without temporary handles", () => {
  const request = { prompt: "Talk", frames: 120, steps: 12, seed: 1, canvasWidth: 736, canvasHeight: 416, referencePaths: [],
    referenceAudios: [{ name: "Voice", sourcePath: "C:/voice.wav", startSeconds: 1, durationSeconds: 5 }], referenceAudioIds: ["temporary"] };
  const snapshot = JSON.parse(sceneGenerationSnapshot(createDraftGenerationJob("Talk"), request));
  expect(snapshot.referenceAudios).toEqual(request.referenceAudios);
  expect(snapshot.referenceAudioIds).toBeUndefined();
});

it("interleaves and clamps the selected sound range", () => {
  const left = Float32Array.from({ length: 400 }, (_, index) => index / 100);
  const right = Float32Array.from({ length: 400 }, () => -2);
  const buffer = { numberOfChannels: 2, sampleRate: 100, length: 400, duration: 4, getChannelData: (channel: number) => channel ? right : left } as unknown as AudioBuffer;
  const pcm = referenceAudioPcm(buffer, 0.5, 2);
  expect(pcm).toHaveLength(400);
  expect([pcm[0], pcm[1], pcm[2]]).toEqual([0.5, -1, 0.5099999904632568]);
  expect(pcm[398]).toBe(1);
  expect(() => referenceAudioPcm(buffer, 2.5, 2)).toThrow(/shorter than 2 seconds/);
  expect(() => referenceAudioRange({ name: "Voice", startSeconds: 3, durationSeconds: 2 }, 4)).toThrow(/beyond the end/);
});
