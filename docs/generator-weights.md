# Generator weights

## LoRAs

Settings → Generators includes a separate **LoRAs** library. **TaoMate 3-Step**
downloads [TaoMate-H3-3step-ComfyUI.safetensors](https://huggingface.co/CZMartin22/TaoMate-H3-3step-ComfyUI/resolve/main/TaoMate-H3-3step-ComfyUI.safetensors).
It uses the same managed `weights` location, background transfer, progress,
cancellation, retry, and Work Queue controls as model weights. Downloads are
serialized with weight downloads, and video generation can continue while downloading.
Missing managed files become downloadable again. Removing a downloaded LoRA
deletes its managed file; **Add Lora** opens an editor to link a named local file, and
removing that library entry leaves the original file untouched.

Open a generator template and use its **LoRAs** section to add available adapters.
Enable any number, adjust their strengths, and move them up or down. Disabled
adapters and strength-zero entries are omitted; the remaining paths and strengths
are passed to SlopFab in displayed order on both CUDA and Vulkan. SlopFab combines
adapter updates by summing them. Negative strengths are supported. An active
missing adapter causes an error rather than silently changing the generation.

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

In Settings → Generator, edit a template and enter local paths or HTTP/HTTPS
download URLs. Hugging Face `blob` links are converted to direct file downloads.
The bundled **First/Last Frame** (formerly **Minimax H3 Original**),
**References**, **First/Last Frame Fast**, and **Singularity** templates each download four model files. References has the same
settings, with the `minimax_h3_ref2va_pruned_int8_convrot.safetensors` transformer
in place of the First/Last Frame `minimax_h3_fl2va_pruned_int8_convrot.safetensors`.
First/Last Frame Fast uses `minimax_h3_fl2va_fasth3_dense_pruned_int8_convrot.safetensors`
and defaults to **6 steps**; its other settings are identical. First/Last Frame and
References default to 20 steps.
Singularity defaults to **4 steps** and uses
[Minimax-h3_Singularity_ref2va_Pruned_v1.3_int8.safetensors](https://huggingface.co/WarmBloodAban/Minimax-h3_Singularity/blob/main/Minimax-h3_Singularity_ref2va_Pruned_v1.3_int8.safetensors)
on all GPUs, with the same text encoder and VAEs as First/Last Frame.
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
