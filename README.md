# Bloom · click-to-bloom demo

**`index.html`** is the direct solution — *Click to bloom*: at rest, the
frame is a small centered button. Click to play the bloom forward with an
ease-out curve, click again to close. Animations are interruptible.
Rendered as a clean black stage, made to embed (e.g. inside Framer).

- Live: https://wentaoz93.github.io/bloom-demo/

**`archive.html`** keeps the two archived alternatives alongside it:

- **Option 1 — Locked aspect**: frame is centered, its aspect ratio always
  matches the flower's natural shape. Eight resize handles all map onto a
  single "size scalar" — drag direction is constrained.
- **Option 2 — Mask window**: the flower sits in a fixed virtual scene, and
  the frame is an independent draggable / resizable viewport over it. The
  frame's area drives bloom progress.

- Archive: https://wentaoz93.github.io/bloom-demo/archive.html

## File layout

```
bloom-demo/
├── index.html               # direct solution: click to bloom only
├── archive.html             # archived: all three options side by side
├── styles.css               # all visual styling
├── app.js                   # interaction logic (ES module)
├── data/
│   ├── manifest.json        # frame counts, paths, mapping ranges
│   ├── aspects.json         # 121 floats, w/h per frame (Option 1 only)
│   ├── frames-natural/      # 121 webp · tight crop, native aspect
│   └── frames-scene/        # 121 webp · 480×480, flower at constant scale
└── README.md
```

## Run locally

This is a static site that uses `fetch()`, so it must be served, not opened
via `file://`:

```bash
cd bloom-demo
python3 -m http.server 8080
# then visit http://localhost:8080
```

Any static file server works — `npx serve`, nginx, Vercel, Netlify, S3, etc.

## Architecture

The code is split across three concerns:

- **`styles.css`** owns colors, spacing, cursors, the L-shaped corner
  markers, and card layout. Changing CSS should never affect interaction.
- **`app.js`** never sets colors or layout values that aren't size or
  position. It only mutates `frame.style.{width, height, left, top}` and
  the canvas drawing surface. Three controller classes
  (`LockedAspectController`, `MaskWindowController`, `ClickToBloomController`)
  each implement one interaction pattern.
- **`data/manifest.json`** holds all the tunable numeric ranges, so they
  can be adjusted without touching JS.

### Implementation notes

- **Pointer Events** (not mouse + touch) for cross-input parity. Each
  handle uses `setPointerCapture` so drags don't lose tracking when the
  cursor leaves the element.
- **rAF batching** via `rafScheduler()` — coalesces multiple pointer
  events per frame into one render, keeping it 60 fps even on high-rate
  trackpads.
- **DPR-aware canvas** — backing-store size = CSS size × `devicePixelRatio`
  for crisp output on retina displays.
- **Scene anchoring trick** (Options 2 & 3): the flower lives in a fixed
  480×480 virtual scene centered in the stage. A canvas inside the frame
  is positioned with a negative offset equal to `(sceneOrigin -
  framePosition)`, so the flower visually stays put while the frame moves.
- **Ease-out cubic** for Option 3: `f(t) = 1 - (1 - t)^3`. Fast initial
  response, gentle settle. Animations are interruptible — clicking
  mid-animation just changes the target and continues from current
  progress.

## Tuning

All numeric ranges live in `data/manifest.json`. Adjust without touching
JS:

```json
{
  "options": {
    "lockedAspect": {
      "minScalar": 200, "maxScalar": 460, "initialScalar": 200
    },
    "maskWindow": {
      "minScrubSize": 140, "maxScrubSize": 340, "minFrameSize": 80,
      "initialFrame": { "width": 160, "height": 160, "x": 190, "y": 190 }
    },
    "clickToBloom": {
      "closedSize": 80, "openSize": 460, "duration": 1100
    }
  }
}
```

## Replacing the flower

1. Drop your new `.webp` sequence into `data/frames-natural/` (tight crops,
   any aspect) and `data/frames-scene/` (480×480, centered, flower at
   constant scale relative to its own max bbox).
2. Regenerate `aspects.json` — one `width / height` ratio per frame, in
   source order. Used only by Option 1.
3. Update `manifest.json` with the new `totalFrames` and
   `sceneFrames.size` if changed.
