# Slopus 0.2.0

This alpha update adds still image projects, new scene types, and a rebuilt Windows 11–style interface with project-wide undo.

## What's new

- Image projects: compose a still image as a hierarchy of objects, text and groups on a canvas, generate it with MiniMax H3, then refine it with sequential edits on an opened or generated image. Generated images and drafts stay in an image bar, and each keeps the settings it was made with.
- Image export as JPG or PNG, at the original size or a size from the project ladder, with adjustable JPG quality. Pick any image to export from the image bar under the preview.
- New scene types: Pose, Character replace, Extend and Bridge, alongside First & last frame and Animate.
- A new interface in the style of Windows 11: a frameless Mica window, a title bar with the project's Save, Undo and Redo, and Fluent controls and icons.
- Project-wide Undo and Redo (Ctrl+Z, Ctrl+Y) for edits made in any view, by the agent, or in project settings.
- Rebuilt Generator, References, Timeline, Export and Settings screens. The Generator is a board of scenes and shot tiles; References has Icons and Details views with multi-select; the Timeline gains zoom, keyboard shortcuts and context menus.
- The agent is a docked, resizable pane that keeps running while hidden.
- LAN workers: unpack the new Slopus worker package on another computer, run `slopus-worker`, and pick it in the new **Settings → Workers** tab to generate there. Slopus finds workers on the local network automatically, or by address. Workers download generator weights from their download links themselves, local-only files are sent from this computer, and finished videos, images and latents are saved in your project as usual.
- The Work queue and Agent buttons show when work is under way, and exports keep running in the background.
- Reference images can be paged through and removed, and effects can be bypassed without removing them.

## Fixes and improvements

- Updated the bundled SlopFab runtime.
- Smoother previews: clips are preloaded and pixels are kept across cuts.
- Fixed export stalls in the video encoder.
- Choosing the project folder now comes before project setup.
- Expanded regression coverage for image projects, the new interface, undo, and export.
