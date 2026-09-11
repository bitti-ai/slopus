# Generator weights

In Settings → Generator, edit a template and enter local paths or HTTP/HTTPS
download URLs. Hugging Face `blob` links are converted to direct file downloads.
The bundled **Minimax H3 Original** template contains the four supplied model URLs.

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
