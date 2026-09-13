# Project settings

Click the project name in the open workspace to change its name, resolution,
aspect ratio, or target length. The popup uses the same controls as New project
and opens with the current values. **Save changes** saves the project; closing
the popup or pressing Escape before saving discards the pending form edits.

Resolution and aspect ratio update both the project settings and its brief.
Target length updates the brief. New generation and export use the new canvas
settings. Existing generated files, scene durations, and timeline clip trims
are preserved.

The AI agent can apply these settings with `project.set`:

```jsonl
{"op":"project.set","aspectRatio":"9:16","resolution":"768p","targetSeconds":60}
{"op":"commit","summary":"Set the project to vertical 768p with a one-minute target length."}
```

Aspect ratios: `16:9`, `9:16`, `1:1`, `4:5`.
Resolution keys: `416p`, `544p`, `640p`, `768p`, `1088p`, `1344p`.
Target length is a whole number from 0 to 600 seconds. The numeric field accepts
any whole second. The slider uses one-second intervals through 60 seconds and
ten-second intervals above that, with extra slider space for the first minute.
Omit fields that should
stay unchanged. Changing scene lengths or timeline clips uses the separate
`scene.set` and `clip.set` commands.
