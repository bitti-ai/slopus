# Project settings

New projects ask for a name, resolution, aspect ratio, and **Look**.
New projects start at 60 seconds, and the timeline grows as clips are added.
The default Look includes the same presets as the scene Look selector and a
**None** option. Scenes whose Look is **None** inherit the project Look; an
explicit scene Look takes priority. Project **None** leaves the existing prompt
style inference unchanged. The inherited Look is resolved for both prompt
preview and generation, so changing it also marks affected renders out of date.

Click the project name in the open workspace to change its name, resolution,
aspect ratio, or Look. Neither popup has a length control; saving project settings
preserves the existing timeline length. The popup opens with the current
values. **Save changes** saves the project; closing
the popup or pressing Escape before saving discards the pending form edits.

Resolution and aspect ratio update both the project settings and its brief.
Dropping media or Generator scenes, moving
clips, and extending clip trims automatically grow it to cover the latest clip
end, rounded up to whole seconds. Drops retain their chosen position even when
the clip is longer than the project. Moving clips left or removing them does
not shrink the saved length. Projects may extend beyond ten minutes.
New generation and export use the new canvas
settings. Existing generated files, scene durations, and timeline clip trims
are preserved.

The AI agent can apply these settings with `project.set`:

```jsonl
{"op":"project.set","aspectRatio":"9:16","resolution":"768p","targetSeconds":60}
{"op":"commit","summary":"Set the project to vertical 768p with a one-minute target length."}
```

Aspect ratios: `16:9`, `9:16`, `1:1`, `4:5`.
Resolution keys: `416p`, `544p`, `640p`, `768p`, `1088p`, `1344p`.
The agent's target length is a nonnegative whole number.
Omit fields that should
stay unchanged. Changing scene lengths or timeline clips uses the separate
`scene.set` and `clip.set` commands.
