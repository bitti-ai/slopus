# Generator weights

Settings opens as a full-screen page with sections in the left sidebar.
Generator templates open in a popup over the page and save edits immediately.
Escape or the popup's close button returns to the generator list. From Settings,
**Back** or Escape returns to the previous screen, preserving project edits.

**Reference icon generator** chooses the template used for automatic, manually
regenerated, and built-in reference icons, independently of the video generator.
Only available text-prompt templates appear; Animate cannot generate still icons.
If only one is available, it is used automatically. Without a valid saved choice,
the video default is used if eligible, otherwise the first available template.
Icons use the selected template's steps, attention, MotionCache and LoRAs,
including their step overrides.

## Sampler and scheduler

Open a generator template's **Sampling** section to choose its sampler and
scheduler. Both start at **Model default**, which preserves the current
checkpoint and adapter recipe. Existing templates keep their behavior.

| Generator | Samplers besides Model default | Schedulers besides Model default |
| --- | --- | --- |
| MiniMax H3 | Euler, AB2 (CUDA), Re-noising, ER-SDE | Beta |
| MOSS, Fibo 2, Krea 2 | Euler, ER-SDE | Beta |
| FastH3 Omni | Euler | None |
| Animate | Euler | Beta when no adapter fixes the schedule |
| YuE2, MiniMax Music3 | None | None |

Active DMAD and Pika recipes control both choices. These restrictions apply to template, global
and scene adapters; saved preferences return when the restriction is removed.
Selecting a sampler other than Euler turns off MotionCache. H3 image editing
requires Euler or Re-noising. Custom checkpoint metadata is also validated by
SlopFab before generation; Beta cannot replace a fixed grid supplied by metadata.
An adapter's step-count override alone does not prevent using Beta.

Selections persist in template settings, `.slop` exports and worker requests.
The optional payload fields are `sampler` (`default`, `euler`, `ab2`, `renoise`,
`er_sde`) and `scheduler` (`default`, `beta`). Omitted fields mean Model default.
Explicit choices require a compatible SlopFab runtime on the generation machine.

## Sharing generator templates

Use **Export** in Settings → Generator to select one or more templates and save
a `.slop` file. Each required model, configured optional file, and referenced
LoRA must have an HTTP or HTTPS download URL. The export picker explains which
templates need URLs before they can be shared. Downloaded templates retain their
source URLs and GPU variants when exported; local paths and download state are
excluded.

Use **Import** to open a `.slop` file. Templates are added with new IDs; duplicate
names receive numbered suffixes. Existing templates, the default generator, and
unrelated settings are preserved. Custom LoRAs are included by URL, including
their strength, activation, step override and sampling recipe. Matching LoRAs
already in the recipient's library are reused. Import does not download weights;
use the template's normal **Download** action when ready.

### `.slop` version 1

A `.slop` file is UTF-8 JSON, optionally with a BOM. It contains a versioned
envelope and typed, independently versioned entries. This separates the file
format from individual payloads so future entries can represent project
templates, settings bundles, or other shareable data:

```json
{
  "format": "slop",
  "version": 1,
  "items": [
    {
      "type": "generator-template",
      "version": 1,
      "data": {
        "name": "Example generator",
        "modelType": "minimax-h3",
        "defaultSteps": 20,
        "attention": "sage2",
        "mode": "prompt",
        "motionCache": false,
        "sources": {
          "transformer": [{ "url": "https://example.com/transformer.safetensors", "gpuModel": "", "minVramGb": 0 }],
          "textEncoder": [{ "url": "https://example.com/text-encoder.safetensors", "gpuModel": "", "minVramGb": 0 }],
          "videoVae": [{ "url": "https://example.com/video-vae.safetensors", "gpuModel": "", "minVramGb": 0 }],
          "audioVae": [{ "url": "https://example.com/audio-vae.safetensors", "gpuModel": "", "minVramGb": 0 }]
        },
        "loras": [],
        "additionalSafetensors": []
      }
    }
  ]
}
```

Version 1 supports 1–100 entries, with a 4 MB file limit. The current importer
accepts only `generator-template` entries at payload version 1. Unsupported
envelope versions, entry types, payload versions, and malformed entries reject
the entire import before settings are changed. Unknown payload fields are
rejected so settings from a newer version cannot silently disappear. Future
payload changes must declare a supported version and migration explicitly.

Generator payloads carry no machine IDs or paths. `sources` maps the existing
weight roles (`transformer`, `textEncoder`, `videoVae`, `audioVae`, optional
`tokenizer`) to ordered variant arrays. Each variant has `url`, optional
`gpuModel` (default empty), and optional `minVramGb` (default zero). Prompt mode
requires the four model roles; Animate requires transformer and both VAEs, plus
an additional safetensor with `role: "promptEmbedding"`.

LoRA entries embed `name`, `url`, `enabled`, and `strength`, plus optional
`stepOverride` and `samplingPreset` (`"dmad-4step"`). Their array order is
preserved. Additional safetensors carry `name`, `url`, and an optional
`role: "promptEmbedding"`. Local download and preparation state is never shared.
URLs must be HTTP(S) and cannot contain username/password credentials.

## LoRAs

Settings → Generators includes a separate **LoRAs** library. **TaoMate 3-Step**
downloads [TaoMate-H3-3step-ComfyUI.safetensors](https://huggingface.co/CZMartin22/TaoMate-H3-3step-ComfyUI/resolve/main/TaoMate-H3-3step-ComfyUI.safetensors).
**Turbo** downloads [minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors](https://huggingface.co/lightx2v/Minimax-h3-Turbo/resolve/main/minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors)
and defaults to an editable **4-step override**.
**LightX2V Turbo** downloads [the silveroxides experimental adapter](https://huggingface.co/silveroxides/MiniMax-H3_tests/resolve/main/experimental/minimax_h3_fl2v_lightx2v_turbo_4to8step_v0.1-v1.0_768p_v4_step600_dareties.safetensors)
and defaults to an editable **6-step override** and **0.9 multiplier**.
**Hyperflow 8-Step** downloads [the Hyperflow adapter](https://huggingface.co/VideoRebirthAI/hyperflow/resolve/main/minimax_h3_hyperflow_8step_v1.0.safetensors)
and defaults to an editable **8-step override** for MiniMax H3.
These adapters use the same managed `weights` location, background transfer, progress,
cancellation, retry, and Work Queue controls as model weights. Downloads are
serialized with weight downloads, and video generation can continue while downloading.
Missing managed files become downloadable again. Removing a downloaded LoRA
deletes its managed file; **Add Lora** opens an editor to link a named local file, and
removing that library entry leaves the original file untouched.

Open a generator template and use its **LoRAs** section to add local or downloadable adapters.
Downloading the generator also downloads any missing active LoRAs with download links.
Already downloaded adapters are reused; disabled and strength-zero adapters are skipped.
The generator stays under **Download** until its model weights and active downloadable
LoRAs are available. Progress, cancellation, and retry cover the entire download.
If only a LoRA remains, the generator row names it (for example, **Needs Turbo LoRA**).
The editor checks and marks individual model files as **Found** even while an adapter is missing.
Enable any number, adjust their strengths, and move them up or down. Disabled
adapters and strength-zero entries are omitted; the remaining paths and strengths
are passed to SlopFab in displayed order on both CUDA and Vulkan. SlopFab combines
adapter updates by summing them. Negative strengths are supported. An active
missing adapter causes an error rather than silently changing the generation.

Open any LoRA from the library to set its **Multiplier** (default **1**).
This multiplies its strength in every generator template. For example, a LoRA
multiplier of **0.75** and a template strength of **0.5** send **0.375** to the
engine. Negative values are supported. A multiplier of **0** disables the
adapter, skips its download, and excludes its step override. Existing LoRAs
without a saved multiplier keep their original strength.

Open any LoRA from the library to edit its optional **Override step count**.
Any supported scene step count (a whole number from 2 to 2147483647) is accepted.
The highest override among enabled, nonzero-strength LoRAs replaces the scene's
step count, even when the scene requests more steps. Without an active override,
the scene's steps are used. TaoMate defaults to an editable override of 3;
older TaoMate schedule settings migrate to this value. All adapters now use the
ordinary schedule, whose step count includes the terminal sigma (N steps means
N−1 model evaluations).
The library and per-template selections persist on this computer; adapter paths
are injected into runtime requests and are not saved into portable project files.

## Model weights

Generator templates are grouped by model in Settings. The **Model** selector in
each template chooses its model family independently of its name.

**MOSS Image** generates new images from text on CUDA with Flash attention and
defaults to 50 steps. Its download includes the MOSS SFT INT8 transformer,
Qwen3.5 9B INT8 text encoder, FLUX.2 small image VAE, and Qwen3.5 tokenizer JSON.
It needs no audio VAE. Downloaded MOSS templates appear in the image generator
picker and are excluded from video generation. Image editing, Zoom, reference
images, character sheets, LoRAs, and MotionCache are unavailable for this model.

The internal capability switches live in `src/lib/generatorModels.json`, shared
by the UI and native request validation. Each model declares `imageGeneration`,
`videoGeneration`, `imageEditing`, `imageReferences`, `loras`, and `motionCache`.
Change these switches when a model gains support, or add a model entry to define
its available operations. Legacy templates without a model family remain MiniMax H3.

Generator templates also offer **Enable MotionCache**, off by default. It uses
SlopFab's default motion-aware denoising reuse settings on CUDA and Vulkan.
Reuse can reduce transformer calls but may change detail and motion; short
schedules may finish without reuse. It is unavailable in Animate mode. The
preference is saved per template and applies to subsequent generation requests.
Older runtimes remain usable with it off and report a clear error if enabled
without MotionCache support.

The native defaults are threshold 0.15, motion strength 1, warmup 4 calls,
at most 2 consecutive skips, active range 0.15–0.95, and subsampling stride 8.

In Settings → Generator, edit a template and enter local paths or HTTP/HTTPS
download URLs. Hugging Face `blob` links are converted to direct file downloads.
The bundled **First/Last Frame** (formerly **Minimax H3 Original**),
**References**, **FastH3 Omni**, and **Singularity** templates each download four model files. References has the same
settings, with the `minimax_h3_ref2va_pruned_int8_convrot.safetensors` transformer
in place of the First/Last Frame `minimax_h3_fl2va_pruned_int8_convrot.safetensors`.
FastH3 Omni uses `fasth3_omniref_8step_pruned_int8_convrot.safetensors`
and `minimax_h3_video_vae_int8_convrot.safetensors`, and defaults to **8 steps**.
Existing Fast templates receive the updated URLs and step default once, preserving custom settings.
First/Last Frame and
References default to 20 steps.
Singularity defaults to **4 steps** and uses
[Minimax-h3_Singularity_ref2va_Pruned_v1.3_int8.safetensors](https://huggingface.co/WarmBloodAban/Minimax-h3_Singularity/blob/main/Minimax-h3_Singularity_ref2va_Pruned_v1.3_int8.safetensors)
on all GPUs, with the same text encoder and VAEs as First/Last Frame.
It also includes **Turbo**, enabled at strength **1** with its **4-step override**.
Existing Singularity templates receive Turbo once, preserving any existing Turbo selection.
All four text encoder downloads use the original Qwen3-VL 32B encoder on all GPUs.
The incompatible 4B INT4 ConvRot option is removed from saved Minimax templates;
templates using its downloaded file switch back to the original encoder, which
may need downloading. The old file is left on disk.
First/Last Frame uses Winnougan's `minimax_h3_fl2va_pruned-w4a8_convrot_pruned.safetensors` fallback at 20 GB or less; References uses the hybrid REF2VA W4A8 model.
Both use their respective INT8 transformer above 20 GB; unknown hardware uses the W4A8 fallback.
FastH3 Omni uses its Omni transformer on all GPUs, without a W4A8 fallback.
Saved Fast templates using the old fallback switch to Omni; an existing Omni download is reused when available.
Other local weights and customized download variants are preserved.

Bundled MiniMax weights declare these minimum GPU memory capacities:

| Weight | Minimum VRAM (GB) |
| --- | ---: |
| First/Last Frame W4A8 / INT8 | 12 / 21 |
| References hybrid W4A8 / INT8 | 12 / 21 |
| FastH3 Omni INT8 | 22 |
| Singularity INT8 | 21 |
| Animate INT8 | 21 |
| H3 Qwen3-VL 32B text encoder | 16 |
| H3 video VAE FP16 / INT8 | 6 / 3 |
| Sol H3 VAE | 6 |
| H3 audio VAE FP32 | 1 |
| MiniMax Music3 transformer INT8 / FP16 / FP32 | 3 / 5 / 10 |
| MiniMax Music3 text encoder / audio VAE | 9 / 1 |

MiniMax Music3 selects FP32 at 10 GB or more, FP16 at 5 GB or more, and INT8
below 5 GB. Its text encoder still requires 9 GB; smaller GPUs receive the
download warning even if the transformer fits. Existing Music3 templates gain
the new variants once, preserving downloaded files and customized sources.

Before a generator or shared-component download starts transferring files, Slopus
warns if all GPU-compatible variants for any needed weight exceed the detected
GPU capacity. The warning lists the GPUs and the unmet minimums, with **Cancel**
and **Download anyway** actions. Continuing selects the smallest GPU-compatible
variant when none fits. A known downloaded dependency is also checked when
downloading the rest of a generator. For example, H3's shared 16 GB text encoder
still triggers a warning on a 12 GB GPU even though its W4A8 transformer fits.
Capacities are not added across GPUs or across model files. Unknown GPU capacity
does not trigger a low-memory warning and uses the smallest compatible variant.
This checks GPU capacity, not the memory currently free while other apps run.
Existing unrestricted bundled sources receive these limits once; custom positive
limits, GPU rules, URLs and downloaded paths are preserved.

Templates awaiting downloads appear under **Download**. Once their
weights are downloaded, they move into **Generators**. Removing or losing their
downloaded files moves them back to **Download**.

**Krea 2 Turbo** and **Krea 2 Raw** are text-to-image generators without editing,
image references, audio, LoRAs or MotionCache. Each downloads its matching INT8
ConvRot transformer (14 GB minimum VRAM), the Qwen3-VL 4B INT8 ConvRot text encoder
(5 GB), and Qwen-Image VAE (0 GB, unrestricted). The tokenizer is embedded in
SlopFab. Both use Flash attention on CUDA or portable Vulkan.

The Krea sampling recipe is saved with the template and exported in `.slop`
bundles. Turbo defaults to 8 steps, CFG 0 and sigma shift `exp(1.15)`. Raw defaults
to 52 steps and CFG 3.5; its automatic sigma shift depends on the canvas size.
Authored CFG, step counts and image sigma shifts override the defaults. Negative
prompts affect Krea generation when CFG is greater than zero. Existing catalogs
receive the two templates once, preserving customized templates and later removal.

Enable **Show advanced options** at the end of the template editor, then open
**Download variants** under a weight to add alternative URLs. Each variant
can specify part of a GPU model name and a minimum VRAM capacity in GB. Selection
prefers a matching GPU-specific variant, then the highest memory tier that fits;
ties preserve the listed order. Leave the GPU field blank and VRAM at zero for a
universal fallback. Windows hardware detection includes NVIDIA, AMD, and Intel.
Memory tiers account for the small amount of VRAM reserved by the driver.
If every compatible variant exceeds the detected capacity, downloading requires
accepting the memory warning. A zero minimum leaves that variant unrestricted.

Click the template's download icon or **Download weights** in its editor to
download missing weights. Files go into `weights` beside `Slopus.exe`. If that
location cannot be written, Slopus uses a `weights` subfolder beside its log file.
To use custom locations, edit `%LOCALAPPDATA%\Slopus\settings.json`, which is
created automatically on startup:

```json
{
  "weightFolders": ["D:\\Projects\\weights"]
}
```

Each entry is an absolute path to the weight folder itself. Slopus checks custom
folders in list order, then `weights` beside the executable, then the log folder's
`weights` directory for an existing completed download. New downloads go to the
first writable folder in that same order. These locations apply to both model
weights and LoRAs. Changes take effect on the next download or removal without
restarting. Startup and the regular availability checks also discover completed
model and LoRA downloads in these folders, even when no local paths were saved.
An empty list keeps the default locations.

To move previously downloaded weights into a custom folder, move their matching
`.complete.json` records with them so Slopus can recognize and reuse the files
automatically. Only files with valid download records can be removed
through the app. Other app preferences continue to use WebView2 localStorage.

Downloads continue in the background when Settings is closed. Reopening Settings
shows the current progress as a color fill across the generator's template row.
The fill tracks completed files plus progress through the current file.
Downloads also appear in Work Queue with progress and cancellation controls.
They run separately from the generation queue and do not occupy a generation slot.
Progress details and cancellation remain available in Settings if the editor is closed.
Failed or cancelled transfers keep their downloaded bytes. Choose **Retry**, or
reopen the app and choose **Download** for the same generator or LoRA, to continue
from the saved position. Completed files are reused and progress includes the
bytes already downloaded. Downloads do not restart automatically when the app opens.

Partial downloads use a stable `.part` file and matching `.part.json` record in
the weight folder. Keep both files together if moving an unfinished download.
Slopus searches all configured weight folders for existing progress before
starting a new file. Partial files cannot be used for generation until complete.

Resume requests use the saved strong ETag with HTTP `Range` and `If-Range`, and
validate the returned byte range before appending. If the file changed, the server
ignores ranges, or no strong ETag is available, Slopus starts that file again
instead of combining incompatible data. This follows the
[HTTP range request rules](https://www.rfc-editor.org/rfc/rfc9110.html#section-13.1.5).
No full model file is buffered in memory.

After completion, the path fields show local files, while the source URLs remain
stored. Templates needing downloads cannot be selected as default and are omitted
from the generation picker. Missing downloaded files are checked at startup, when
Settings or the generator page opens or regains focus, and periodically while those
pages are open. A missing file restores its URL for redownload.

For a template with download sources, the remove icon deletes its managed weight
files and retains the template with its URLs. Manually selected files outside the
managed download records are not deleted. Templates sharing a removed downloaded
file also become downloadable again. Removing a template containing only manually
configured local paths retains the previous behavior of removing the template.
