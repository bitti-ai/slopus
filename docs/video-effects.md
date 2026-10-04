# Video effects

Select a video or image clip in the timeline and use **Add Effect** in the inspector.
Each effect can be adjusted or removed independently. Locked tracks cannot be edited.

| Effect | Controls |
| --- | --- |
| Sharpen | Edge enhancement, 0–200%; zero bypasses sharpening. |
| Gaussian Blur | Radius, 0–24 source pixels; zero bypasses blur. |
| Basic Corrections | Temperature, tint, highlights, shadows, whites and blacks −100 to +100%; exposure −4 to +4 stops; contrast −100 to +100%; saturation 0–200%. The existing brightness control remains available. |
| Creative | Eight procedural looks at 0–100% intensity, faded film 0–100%, sharpen 0–200%, and vibrance −100 to +100%. |
| Curves | RGB master and individual red, green and blue channels; hue vs saturation, hue vs hue, hue vs luma, luma vs saturation, and saturation vs saturation. |
| Color Wheels | Shadow, midtone and highlight tint wheels, each with separate lightness from −100 to +100%. |
| Vignette | Amount −100 to +100% (positive darkens, negative lightens), midpoint 0–100%, roundness −100 to +100%, and feather 0–100%. |
| 3D LUT | Import or replace a `.cube` file and blend it at 0–100% intensity. |

The render order is Chroma Key → Gaussian Blur → Sharpen (standalone + Creative) → Basic Corrections → Creative look / faded film / vibrance → Curves → Color Wheels → LUT → Vignette → Look temperature. Transform, opacity, and transitions composite the result into the timeline. This order is fixed; the inspector is not a reorderable effect stack. Blur radii refer to source resolution, so preview and export use the same radius even at different output sizes.

Creative includes **Teal & Orange**, **Warm Film**, **Cool Blue**, **Bleach Bypass**, **Faded Matte**, **Monochrome**, **Golden Hour**, and **Night**. These are shader colour transforms, not LUT files. None and zero look intensity leave the look unchanged; faded film, sharpening and vibrance remain independently adjustable. Vibrance gives less saturated colours more weight.

Choose a curve from the channel menu. Click the graph or use Add point to insert a control point, drag a point, or enter its input/output coordinates. Arrow keys move a focused point (Shift makes larger steps), and Delete removes an interior point. Reset curve resets the selected channel; the effect header resets all channels. Shape-preserving monotone cubic interpolation passes through the points without segment overshoot. Hue curves link their endpoints and use matching tangents across the red seam. Their neutral line is 50%: hue vs hue offsets hue, hue vs luma offsets HSL lightness, and the saturation curves multiply saturation. Luma vs saturation uses HSL lightness, matching FilmCraft's grading convention. Small sampled curve buffers are rebuilt only when settings change; no picture pixels are read back from the GPU.

Drag each wheel toward a colour to tint that tonal range. Arrow keys adjust the tint, Home or a double-click recentres it, and its reset button also resets lightness. Shadow and highlight weights taper smoothly into midtones. The lightness sliders work independently of tint.

Vignette midpoint moves the start of the edge treatment, feather changes its transition width, and roundness moves from a rounded rectangle through a frame-shaped ellipse to a circle. Existing vignette amounts retain their appearance with midpoint 50%, roundness 0%, and feather 100%.

All new effects support bypass, reset, copy/paste, removal, project save/reopen, and the existing undo workflow. Older correction settings keep the `colorCorrection` project key and render with neutral defaults for the new controls.

LUT import accepts 3D `.cube` tables from 2³ through 65³, including `TITLE`, `DOMAIN_MIN`/`DOMAIN_MAX`, and Resolve's `LUT_3D_INPUT_RANGE`. Tables use red-fastest row order and trilinear interpolation. One-dimensional and combined shaper LUTs are rejected with an explanation. Files are limited to 16 MB. LUTs are embedded in the project and need no external file after import. A failed replacement leaves the previous LUT intact.

Color operations work on the decoded, display-referred RGB picture. Choose a LUT appropriate for that input; importing a LUT does not configure log, HDR, or project color management. Exposure multiplies RGB by 2 raised to the selected value; contrast pivots around 0.5. Final output is clamped to 0–1.

These effects require WebGPU. Preview and export share the same shader processor, import decoded video frames as external textures, and keep intermediate pictures in GPU memory. Blur uses two separable passes and filters premultiplied alpha to avoid colored fringes around keyed objects. LUTs and working textures are reused across frames. Playback redraws on video-frame callbacks; paused footage redraws after seeking or changing settings.

If a GPU is unavailable, the monitor reports an error and export refuses to produce a file with these effects omitted. Projects without these effects retain the existing canvas export fallback.

Implementation references: [WebGPU external textures](https://www.w3.org/TR/webgpu/#external-texture), [WGSL](https://www.w3.org/TR/WGSL/), and the [Adobe Cube specification](https://kono.phpage.fr/images/a/a1/Adobe-cube-lut-specification-1.0.pdf).

The Creative transforms are adapted from [FilmCraft's procedural looks](https://github.com/storytold/filmcraft/blob/main/crates/render/src/effects.rs), used under the [MIT license](../public/licenses/filmcraft.txt).
