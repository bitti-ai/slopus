# Built-in reference icons

Hover over a preset's icon area in **Add a reference** to reveal its generation
button. It generates or regenerates only that preset and keeps the picker open.
Hovering the button does not highlight or select the reference card.
Built-in icon work follows category order: Character, Animal, Product, Location,
then Style.

Slopus can close immediately while only reference icons are generating.
An icon is published only after the complete JPEG is written and flushed to a
temporary file, then atomically replaces its destination. Interrupted temporary
files are ignored, and an existing icon stays available until its replacement
is complete. Normal video generation still uses the quit confirmation.

Opening **Add a reference** for the first time offers to generate any missing
built-in icons. **Don't ask again** remembers either answer across app launches:
Start enables generation of missing icons on later visits; Cancel disables it.
Without that option, the question appears only once per app session.

Generating the catalog can take a long time. It uses the current generator's
model settings, runs in the Work Queue, and yields to normal video generation.
An interrupted built-in icon is retried after the videos finish. The Work Queue
can also cancel the batch. An engine or storage failure stops the remaining
catalog so the same failure is not repeated for every reference.

Built-in icons are shared across projects. They are saved as 256×256 JPEGs in
`reference-icons/` inside the same directory as `slopus.log`, using stable preset
IDs as filenames. They load as their cards come into view and are never sent to
the video engine as reference-image attachments. Existing project-specific
icons remain in their project folders.
