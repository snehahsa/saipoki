# Map animation sprites

One **folder per animation** under `sprites/animations/`:

```
animations/
  water1/
    wa.png          ← sprite sheet (any name; prefers folder-name.png)
    water1.json     ← frame data (auto-generated, edited in map builder)
  fountain/
    fountain.png
    fountain.json
```

- Tile id: `anim-{folder}` (e.g. `anim-water1`)
- Map builder → **Anim** tool → Edit frames
- `water1.json` stores loop frames, timing, and display scale for that folder’s PNG

Reload the map builder after adding folders so `manifest.json` updates.
