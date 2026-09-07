import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repository = resolve(scriptDirectory, "..");
const outputDirectory = join(repository, "src", "assets", "reference-icons");

const defaults = {
  executable: "D:\\Projects\\slopfab\\build\\Release\\slopfab.exe",
  transformer: "D:\\Projects\\slopfab\\weights\\transformer\\MiniMax_H3_FL2VA_pruned_nvfp4.safetensors",
  textEncoder: "D:\\Projects\\slopfab\\weights\\text_encoder\\qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors",
  videoVae: "D:\\Projects\\slopfab\\weights\\vae\\video_vae_nf4.safetensors",
  audioVae: "D:\\Projects\\slopfab\\weights\\vae\\audio_vae_nf4.safetensors",
  cargo: "C:\\Users\\NN\\.cargo\\bin\\cargo.exe",
};

const settings = {
  executable: process.env.SLOPFAB_EXE || defaults.executable,
  transformer: process.env.SLOPFAB_TRANSFORMER || defaults.transformer,
  textEncoder: process.env.SLOPFAB_TEXT_ENCODER || defaults.textEncoder,
  videoVae: process.env.SLOPFAB_VIDEO_VAE || defaults.videoVae,
  audioVae: process.env.SLOPFAB_AUDIO_VAE || defaults.audioVae,
  cargo: process.env.CARGO_EXE || defaults.cargo,
  ffmpeg: process.env.FFMPEG_EXE || "ffmpeg",
};

const force = process.argv.includes("--force");
const dryRun = process.argv.includes("--dry-run");
const requestedId = process.argv.find((argument) => argument.startsWith("--id="))?.slice(5);
const requestedType = process.argv.find((argument) => argument.startsWith("--type="))?.slice(7);
const requestedShard = process.argv.find((argument) => argument.startsWith("--shard="))?.slice(8);
const requestedLimit = Number(process.argv.find((argument) => argument.startsWith("--limit="))?.slice(8) || 0);
const requestedWorkers = Number(process.argv.find((argument) => argument.startsWith("--workers="))?.slice(10) || process.env.REFERENCE_ICON_WORKERS || 2);

function run(command, args, options = {}) {
  return new Promise((accept, reject) => {
    const child = spawn(command, args, { stdio: "inherit", windowsHide: true, ...options });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) accept();
      else reject(new Error(`${command} stopped with ${signal ? `signal ${signal}` : `exit code ${code}`}.`));
    });
  });
}

function runQuiet(command, args, options = {}) {
  return new Promise((accept, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, ...options });
    let output = "";
    child.stdout.on("data", (chunk) => { output = `${output}${chunk}`.slice(-12_000); });
    child.stderr.on("data", (chunk) => { output = `${output}${chunk}`.slice(-12_000); });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) accept();
      else reject(new Error(`${command} stopped with ${signal ? `signal ${signal}` : `exit code ${code}`}.\n${output}`));
    });
  });
}

function loadCatalog() {
  const runner = join(repository, "node_modules", "vite-node", "vite-node.mjs");
  const helper = join(scriptDirectory, "reference-icon-catalog.ts");
  const result = spawnSync(process.execPath, [runner, helper], {
    cwd: repository,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.status !== 0) throw new Error(`Could not load the reference catalogue.\n${result.stderr || result.stdout}`);
  return JSON.parse(result.stdout);
}

function backend() {
  if (process.env.SLOPFAB_BACKEND === "cuda" || process.env.SLOPFAB_BACKEND === "vulkan") {
    return process.env.SLOPFAB_BACKEND;
  }
  const devices = spawnSync(settings.executable, ["devices"], { encoding: "utf8", windowsHide: true });
  return devices.status === 0 && /^device\s+\d+/m.test(devices.stdout || "") ? "cuda" : "vulkan";
}

function stylePrompt(entry) {
  const tailoredSubject = {
    "Architectural photography": "a distinctive modern pavilion exterior",
    "Editorial photography": "a thoughtful person in a lived-in interior",
    "Fashion photography": "a full-length fashion model wearing a structured contemporary outfit",
    "Food photography": "a carefully plated colorful meal",
    "Macro photography": "the intricate center of a small flower",
    "Product photography": "an unbranded sculptural ceramic bottle",
    "Street photography": "a pedestrian crossing a layered urban street",
    "Studio portrait": "a single person posed against a seamless backdrop",
    "Travel photography": "a traveler overlooking a dramatic mountain landscape",
    "Wildlife photography": "a small wild animal in its natural habitat",
    "Automotive campaign": "a modern performance car on a clean architectural road",
    "Beauty campaign": "a close beauty portrait with luminous natural skin",
    "Clean product ad": "an unbranded sculptural ceramic bottle on a simple pedestal",
    "Fashion lookbook": "a full-length model wearing a complete contemporary outfit",
    "Food commercial": "a freshly prepared colorful hero dish",
    "Lifestyle campaign": "a relaxed person enjoying an aspirational outdoor moment",
    "Luxury editorial": "an elegantly dressed model with one refined accessory",
    "Sports campaign": "an athlete in motion with one piece of sports equipment",
    "Technology launch": "a sleek unbranded handheld electronic device on a luminous pedestal",
    "Travel campaign": "a traveler within a striking destination landscape",
    "Motion graphics": "bold abstract geometric forms arranged around one clear focal shape",
    "UI motion design": "a layered futuristic interface of cards, controls and data shapes",
  }[entry.name];
  const scene = tailoredSubject ?? {
    Animation: "an expressive human adventurer in a dynamic pose within a simple atmospheric environment",
    Cinematic: "a lone traveler in an atmospheric city street shaped by dramatic architectural light",
    Photography: "one clear portfolio subject",
    Illustration: "a welcoming greenhouse storefront with one person and abundant plants",
    "Fine art": "a solitary figure in a textured landscape with a strong foreground and distant horizon",
    Graphic: "a bold text-free cultural poster composition built from a clear central motif and balanced geometric forms",
    Retro: "a stylish traveler beside a compact car in a period city setting",
    Experimental: "a human portrait integrated with simple architectural forms",
    Commercial: "one clear aspirational campaign subject",
    Digital: "a small futuristic pavilion with one stylized human figure for scale",
  }[entry.subcategory];
  if (!scene) throw new Error(`Style icon '${entry.id}' has unsupported subcategory '${entry.subcategory}'.`);
  const treatment = {
    Animation: `${entry.subject} production frame, entirely animated with unmistakable medium-specific character rendering and environment design, not live-action photography`,
    Cinematic: `${entry.subject} film still with unmistakable genre-specific cinematography, production design, color grade and lighting`,
    Photography: `professional ${entry.subject} portfolio image with discipline-specific lens choice, framing and lighting`,
    Illustration: `${entry.subject}, entirely hand-rendered illustration with prominent medium-specific marks, edges and surface texture, not photography`,
    "Fine art": `${entry.subject} artwork on a physical surface with prominent handmade medium texture, expressive marks and visible material character, not photography`,
    Graphic: `${entry.subject} graphic artwork with deliberate flat shapes, typography-free hierarchy and print-ready composition`,
    Retro: `authentic ${entry.subject} image with unmistakable period design, color treatment, wardrobe and capture artifacts`,
    Experimental: `${entry.subject} artwork with the named optical or mixed-media effect unmistakably dominating the entire frame`,
    Commercial: `polished ${entry.subject} campaign image with premium art direction, controlled highlights and a clean hero composition`,
    Digital: `${entry.subject}, entirely computer-rendered with unmistakable technique-specific geometry, surfaces and lighting rather than ordinary photography`,
  }[entry.subcategory];
  return `${treatment}. Subject: ${scene}. Preserve a clear focal point, refined detail and strong visual hierarchy`;
}

function promptFor(entry) {
  const description = {
    character: `a tight professional headshot portrait of ${entry.subject}, head and shoulders fully visible, facing the camera, natural neutral expression, eyes tack-sharp with clean symmetrical catchlights, realistic skin texture, flattering three-point portrait lighting with a large soft key at 45 degrees, gentle fill, subtle hair light and controlled highlights, simple light gray seamless studio background`,
    animal: `a clear animal portrait of ${entry.subject}, whole body visible, species-accurate anatomy and distinctive markings, detailed fur, feathers or scales, natural lighting, simple natural background`,
    product: `a professional full product photograph of ${entry.subject}, the entire product fully visible and centered, accurate geometry and materials, tack-sharp edges and fine surface detail, large diffused softbox key light, clean fill and precise rim separation, controlled reflections, simple light gray seamless studio background`,
    location: `a comprehensive establishing photograph of ${entry.subject}, the full location clearly visible, balanced natural cinematic illumination, crisp foreground, midground and background detail, realistic materials, clean color separation, broad dynamic range with protected highlights and open shadows`,
    style: stylePrompt(entry),
  }[entry.type];
  if (!description) throw new Error(`Reference icon '${entry.id}' has unsupported type '${entry.type}'.`);
  const visualDirection = entry.type === "style"
    ? `A polished square visual style reference, ${description}, the entire frame consistently uses the requested visual treatment, high fidelity`
    : `Live-action, high-end commercial reference photography, ${description}, refined natural tonality, high image fidelity`;
  return [
    `integrated_multimodal_description: [Shot 1] ${visualDirection}, square composition, static camera, no movement, no blur, no distortion, no text, no logo, no watermark, no border.`,
    "",
    "overall_soundscape: N/A",
    "",
    "non_diegetic_music: N/A",
  ].join("\n");
}

function stableSeed(id) {
  return Number.parseInt(createHash("sha256").update(id).digest("hex").slice(0, 8), 16);
}

async function generate(entry, temporaryDirectory, inferenceBackend) {
  const destination = join(outputDirectory, `${entry.id}.jpg`);
  const promptPath = join(temporaryDirectory, `${entry.id}.txt`);
  const rawBase = join(temporaryDirectory, `${entry.id}.mp4`);
  const y4mPath = join(temporaryDirectory, `${entry.id}.y4m`);
  await writeFile(promptPath, promptFor(entry), "utf8");

  const args = [
    "generate",
    "--prompt-file", promptPath,
    "--out", rawBase,
    "--raw",
    "--resolution", "256x256",
    // H3's decoder cannot accept one temporal frame. Six is the smallest legal
    // request and resolves to 22; only frame zero is retained below.
    "--frames", "6",
    "--steps", "30",
    "--seed", String(stableSeed(entry.id)),
    "--inference-backend", inferenceBackend,
    "--attention", inferenceBackend === "cuda" ? "sage2" : "exact",
    "--transformer", settings.transformer,
    "--text-encoder", settings.textEncoder,
    "--vae", settings.videoVae,
    "--audio-vae", settings.audioVae,
  ];
  if (dryRun) args.push("--dry-run");

  if (dryRun) console.log(`\n[${entry.name}] MiniMax H3, 30 steps, ${inferenceBackend}`);
  await (dryRun ? run : runQuiet)(settings.executable, args, { cwd: repository });
  if (dryRun) return;
  await run(settings.ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-i", y4mPath,
    "-frames:v", "1",
    "-vf", "scale=256:256:flags=lanczos",
    "-pix_fmt", "yuvj444p",
    "-q:v", "1",
    destination,
  ]);
}

const manifest = loadCatalog();
const seenIds = new Set();
for (const entry of manifest) {
  if (!entry || !/^[a-z0-9][a-z0-9-]*$/.test(entry.id ?? "")) {
    throw new Error("Every reference icon needs a path-safe lowercase id.");
  }
  if (seenIds.has(entry.id)) throw new Error(`Duplicate reference icon id '${entry.id}'.`);
  if (!entry.name?.trim() || !entry.subject?.trim()) throw new Error(`Reference icon '${entry.id}' needs a name and subject.`);
  if (!["character", "animal", "product", "location", "style"].includes(entry.type)) throw new Error(`Reference icon '${entry.id}' has unsupported type '${entry.type}'.`);
  seenIds.add(entry.id);
}
if (requestedType && !["character", "animal", "product", "location", "style"].includes(requestedType)) {
  throw new Error(`Unsupported reference icon type '${requestedType}'.`);
}
let entries = requestedId
  ? manifest.filter((entry) => entry.id === requestedId)
  : requestedType ? manifest.filter((entry) => entry.type === requestedType) : manifest;
if (requestedId && entries.length === 0) throw new Error(`No reference icon entry has id '${requestedId}'.`);
if (requestedShard) {
  const match = /^(\d+)\/(\d+)$/.exec(requestedShard);
  const shard = Number(match?.[1]);
  const total = Number(match?.[2]);
  if (!match || shard < 1 || total < 1 || shard > total) {
    throw new Error("--shard must use a one-based value such as --shard=1/2.");
  }
  entries = entries.filter((_, index) => index % total === shard - 1);
}
if (Number.isFinite(requestedLimit) && requestedLimit > 0) entries = entries.slice(0, requestedLimit);
await mkdir(outputDirectory, { recursive: true });
const temporaryDirectory = await mkdtemp(join(tmpdir(), "slopus-reference-icons-"));
const inferenceBackend = backend();

try {
  const pending = [];
  for (const [index, entry] of entries.entries()) {
    const destination = join(outputDirectory, `${entry.id}.jpg`);
    if (!force) {
      try {
        await access(destination);
        console.log(`[${index + 1}/${entries.length}] ${entry.name}: already exists; skipping`);
        continue;
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    pending.push(entry);
  }
  if (dryRun) {
    for (const entry of pending) await generate(entry, temporaryDirectory, inferenceBackend);
  } else if (pending.length > 0) {
    const specs = pending.map((entry) => ({
      id: entry.id,
      prompt: promptFor(entry),
      seed: stableSeed(entry.id),
      destination: join(outputDirectory, `${entry.id}.jpg`),
    }));
    await run(settings.cargo, [
      "build", "--quiet",
      "--manifest-path", join(repository, "src-tauri", "Cargo.toml"),
      "--bin", "reference_icons",
    ], { cwd: repository });
    const workerCount = Math.max(1, Math.min(specs.length, Number.isFinite(requestedWorkers) ? Math.floor(requestedWorkers) : 2));
    const batches = Array.from({ length: workerCount }, () => []);
    specs.forEach((spec, index) => batches[index % workerCount].push(spec));
    const executable = join(repository, "src-tauri", "target", "debug", "reference_icons.exe");
    const environment = {
      ...process.env,
      SLOPFAB_EXE: settings.executable,
      SLOPFAB_TRANSFORMER: settings.transformer,
      SLOPFAB_TEXT_ENCODER: settings.textEncoder,
      SLOPFAB_VIDEO_VAE: settings.videoVae,
      SLOPFAB_BACKEND: inferenceBackend,
    };
    const batchPaths = await Promise.all(batches.map(async (batch, index) => {
      const batchPath = join(temporaryDirectory, `batch-${index + 1}.json`);
      await writeFile(batchPath, JSON.stringify(batch), "utf8");
      return batchPath;
    }));
    const runs = await Promise.allSettled(batchPaths.map(async (batchPath, index) => {
      // Optional extra workers are staggered to reduce aligned peak usage;
      // more than the two-worker default requires substantially more VRAM.
      if (workerCount > 2 && index > 0) {
        await new Promise((accept) => setTimeout(accept, index * 7_000));
      }
      await run(executable, [batchPath], {
        cwd: repository,
        env: environment,
      });
    }));
    const failedIndexes = runs.flatMap((result, index) => result.status === "rejected" ? [index] : []);
    for (const index of failedIndexes) {
      console.warn(`Reference icon worker ${index + 1} failed; retrying its batch with exclusive GPU access.`);
      await run(executable, [batchPaths[index]], { cwd: repository, env: environment });
    }
  }
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
