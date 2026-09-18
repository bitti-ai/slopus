# Video effects

Select a video or image clip in the timeline and use **Add Effect** in the inspector.
Each effect can be adjusted or removed independently. Locked tracks cannot be edited.

| Effect | Controls |
| --- | --- |
| Sharpen | Edge enhancement, 0–200%; zero bypasses sharpening. |
| Gaussian Blur | Radius, 0–24 source pixels; zero bypasses blur. |
| Color Correction | Exposure −4 to +4, contrast −100 to +100%, saturation 0–200%. Saturation zero produces monochrome. |
| Vignette | Edge darkening, 0–100%. |
| 3D LUT | Import or replace a `.cube` file and blend it at 0–100% intensity. |

The render order is Chroma Key → Gaussian Blur → Sharpen → Color Correction → LUT → Vignette → Look temperature. Transform, opacity, and transitions composite the result into the timeline. This order is fixed; the inspector is not a reorderable effect stack. Blur radii refer to source resolution, so preview and export use the same radius even at different output sizes.

LUT import accepts 3D `.cube` tables from 2³ through 65³, including `TITLE`, `DOMAIN_MIN`/`DOMAIN_MAX`, and Resolve's `LUT_3D_INPUT_RANGE`. Tables use red-fastest row order and trilinear interpolation. One-dimensional and combined shaper LUTs are rejected with an explanation. Files are limited to 16 MB. LUTs are embedded in the project and need no external file after import. A failed replacement leaves the previous LUT intact.

Color operations work on the decoded, display-referred RGB picture. Choose a LUT appropriate for that input; importing a LUT does not configure log, HDR, or project color management. Exposure multiplies RGB by 2 raised to the selected value; contrast pivots around 0.5. Final output is clamped to 0–1.

These effects require WebGPU. Preview and export share the same shader processor, import decoded video frames as external textures, and keep intermediate pictures in GPU memory. Blur uses two separable passes and filters premultiplied alpha to avoid colored fringes around keyed objects. LUTs and working textures are reused across frames. Playback redraws on video-frame callbacks; paused footage redraws after seeking or changing settings.

If a GPU is unavailable, the monitor reports an error and export refuses to produce a file with these effects omitted. Projects without these effects retain the existing canvas export fallback.

Implementation references: [WebGPU external textures](https://www.w3.org/TR/webgpu/#external-texture), [WGSL](https://www.w3.org/TR/WGSL/), and the [Adobe Cube specification](https://kono.phpage.fr/images/a/a1/Adobe-cube-lut-specification-1.0.pdf).
