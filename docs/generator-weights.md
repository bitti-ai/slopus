# Generator weights

Settings opens as a full-screen page with sections in the left sidebar. The
sidebar stays available while editing generators and LoRAs. **Back** or Escape
returns to the previous screen, preserving the open project's edits.

## LoRAs

Settings → Generators includes a separate **LoRAs** library. **TaoMate 3-Step**
downloads [TaoMate-H3-3step-ComfyUI.safetensors](https://huggingface.co/CZMartin22/TaoMate-H3-3step-ComfyUI/resolve/main/TaoMate-H3-3step-ComfyUI.safetensors).
**Turbo** downloads [minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors](https://huggingface.co/lightx2v/Minimax-h3-Turbo/resolve/main/minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors)
and defaults to an editable **4-step override**.
**LightX2V Turbo** downloads [the silveroxides experimental adapter](https://huggingface.co/silveroxides/MiniMax-H3_tests/resolve/main/experimental/minimax_h3_fl2v_lightx2v_turbo_4to8step_v0.1-v1.0_768p_v4_step600_dareties.safetensors)
and defaults to an editable **6-step override** and **0.9 multiplier**.
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
**References**, **First/Last Frame Fast**, and **Singularity** templates each download four model files. References has the same
settings, with the `minimax_h3_ref2va_pruned_int8_convrot.safetensors` transformer
in place of the First/Last Frame `minimax_h3_fl2va_pruned_int8_convrot.safetensors`.
First/Last Frame Fast uses `fastvideo_fasth3_8step_v2_pruned_int8_convrot.safetensors`
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
First/Last Frame, References, and First/Last Frame Fast use the hybrid W4A8 transformer at 20 GB or less
and their respective INT8 transformer above 20 GB; unknown hardware uses the W4A8 fallback.
Other local weights and customized download variants are preserved.

Templates awaiting downloads appear under **Download**. Once their
weights are downloaded, they move into **Generators**. Removing or losing their
downloaded files moves them back to **Download**.

Enable **Show advanced options** at the end of the template editor, then open
**Download variants** under a weight to add alternative URLs. Each variant
can specify part of a GPU model name and a minimum VRAM capacity in GB. Selection
prefers a matching GPU-specific variant, then the highest memory tier that fits;
ties preserve the listed order. Leave the GPU field blank and VRAM at zero for a
universal fallback. Windows hardware detection includes NVIDIA, AMD, and Intel.
Memory tiers account for the small amount of VRAM reserved by the driver.

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
Failed transfers can be retried; completed files are retained, while an interrupted
file starts again. No full model file is buffered in memory.

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
