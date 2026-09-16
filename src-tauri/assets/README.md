# Animate conditioning

Animate downloads [fixed_embed_fwd_anyframe.safetensors](https://huggingface.co/drbaph/Viggle-Animate-ComfyUI/resolve/main/text_cond/fixed_embed_fwd_anyframe.safetensors)
as an additional safetensor in its generator template, into the configured
weights folder. No conditioning binary is bundled with Slopus.

The download contains Viggle's frozen `prompt_embeds` BF16 `[1,362,5120]` and
`text_token_tags` I64 `[362]`. When Animate is used, Slopus losslessly expands
BF16 to F32, renames the embedding to `prompt_embedding` `[362,5120]`, and
writes I32 tags for SlopFab. This derived `.slopfab.safetensors` file stays
beside the download and is reused while its contents match. Missing or damaged
copies are rebuilt. Removing downloaded generator weights also removes it.
SlopFab-compatible F32 files can be used directly without conversion.

The downloaded tensor values were verified against the previous bundled
conditioning (SHA-256 `54858d948cb547267495246c7d02b87973ce2b2df7d9af59ff8efe70530b2493`):
both the embedding and modality tags match exactly.

`viggle-animate-fixed-prompt.txt` is the upstream descriptive prompt. Animate
uses the frozen embedding rather than recomputing conditioning from this text.
Qwen is not needed at runtime.

These model assets originate from [Viggle/Viggle-Animate](https://huggingface.co/Viggle/Viggle-Animate)
and are covered by the upstream MiniMax-H3 Community License; see the upstream
[modification notice](https://huggingface.co/Viggle/Viggle-Animate/blob/main/MODIFICATIONS.md).
