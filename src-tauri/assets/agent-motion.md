## Motions

Motions are inline procedural graphics assets, created and edited with JavaScript ES modules. No compilation, package installation or external libraries. An empty Motion can already be present because the user clicked Add Motion. Populate that asset with `motion.set`; do not create a duplicate unless asked. The full source and user controls appear in the timeline inspector.

Commands (ordinary JSONL project commands followed by commit):

- `{"op":"motion.add","id":"motion-title","name":"Title","motion":DOCUMENT}` creates an asset.
- `{"op":"motion.set","id":"motion-title","name":"Optional new name","motion":DOCUMENT}` replaces its document. Omit name or motion to retain it.
- `{"op":"clip.add","id":"clip-title","asset":"motion-title","track":"...","at":0,"seconds":5}` places an asset on the timeline. An empty Motion created in the UI is already placed. Reuse its existing clip.

DOCUMENT shape:
```json
{"version":1,"space":"2d","width":1280,"height":720,"duration":5,"seed":1,"source":"export function update({ time, parameters, nodes }, draw) { const title = nodes.find(n => n.id === 'title'); title.position[0] += Math.sin(time * parameters.speed) * parameters.distance; }","nodes":[{"id":"title","name":"Title","kind":"text","position":[100,200,0],"width":900,"height":100,"text":"Hello","fontSize":72,"fill":"#ffffff"}],"parameters":[{"id":"speed","label":"Speed","type":"number","value":2,"min":0,"max":10},{"id":"distance","label":"Travel distance","type":"number","value":100,"min":0,"max":500}],"overrides":{}}
```

Document dimensions: integers 32..4096. Duration: 0.1..600 seconds. IDs start with an ASCII letter, use letters/digits/underscore/hyphen, maximum 80 characters. Up to 512 named nodes and 100 parameters. Source limit 200000 characters. `space:"2d"` is the only currently supported space; do not claim 3D support.

Each node has id, name, kind (`rect`, `ellipse`, `text`, `path`). Optional defaults: position [0,0,0], rotation [0,0,0] in degrees, scale [1,1,1], width/height 100, opacity 1, visible true, fill #ffffff, stroke transparent, strokeWidth 0, text empty, fontSize 48, fontFamily sans-serif (or serif/monospace), path empty. Position is the upper-left anchor in document pixels. Ellipses fit the width/height rectangle. Paths use SVG path syntax. Text uses a top baseline and is constrained by width. Set height to a useful selection-box height. Version 1 uses only position x/y, rotation z and scale x/y. Reserve other axes for future 3D; keep them at identity values.

Export `function update(context, draw)`. It must be synchronous and return nothing. Context includes time (seconds, clamped to duration), duration, width, height, parameters (id -> value), nodes (a fresh mutable copy), and random() (seeded identically on each evaluation). Update nodes directly. `draw.rect/ellipse/text/path({...nodeProperties})` appends temporary primitives; give IDs if needed, and do not duplicate existing IDs. Total output limit 1024 nodes. Named scene nodes are selectable/editable in the video view; prefer them over temporary primitives for user-editable elements.

Compute the result from time and parameters, independent of previous frames. Avoid mutable module state, Date, Math.random, timers, fetch, DOM, imports, async code, and direct Canvas/WebGPU calls. The runtime handles rendering and frame scheduling. Use context.random for stable procedural variation. Pure helpers at module scope are fine.

Parameter types: number, string, color, boolean. Every parameter needs id, label, type, value. Numbers can specify min, max, positive step. Expose useful movement/timing controls instead of hardcoding everything in source.

`overrides` maps named node IDs to user adjustments: offset [x,y,0], scale [x,y,1], rotation [0,0,z], optional fill/text. These apply after script evaluation. Preserve existing overrides and parameter values when revising a Motion unless the requested change requires altering them. Keep IDs stable. Remove an override only when removing its corresponding node.

Use {"kind":"inspect","requests":[{"op":"motion.capture","motion":"motion-asset-id","at":1.5}]} to inspect an actual rendered Motion frame, even without timeline placement, and correct composition or script errors. Use timeline.capture to see it composited with other timeline layers and effects. Both execute the Motion script with its saved parameters and overrides at the requested time. Create Reference in the Motion timeline context menu bakes the full Motion to H.264 at 24 fps and adds a video reference for MiniMax. Clips shorter than two seconds hold their final pose to reach two seconds; longer references initially select the first 15 seconds. The user can adjust the reference range. Never invent a baked file path or claim a render occurred just by emitting motion.add/set.
