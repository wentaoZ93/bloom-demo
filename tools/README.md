# Asset processing tool

`process-video.py` turns a source video of a single subject into the
asset sequence the demo expects: tight-cropped frames, scene-padded
frames, and an `aspects.json`.

## Setup

```bash
pip install opencv-python numpy
# Optional, only if you'll use --mode rembg:
pip install rembg
```

`ffmpeg` must be on your PATH.

## Quick start

```bash
# from the demo root, replace the asset set:
python tools/process-video.py path/to/video.mp4 --out data/

# with debug overlays so you can sanity-check the bboxes:
python tools/process-video.py video.mp4 --out data/ --debug
```

The tool overwrites `data/frames-natural/`, `data/frames-scene/`, and
`data/aspects.json`. It also patches `data/manifest.json`'s
`totalFrames` field if the file exists.

## Picking a detection mode

The hard part of this pipeline is figuring out where the subject is in
each frame. There are three modes:

### `--mode hsv` (default, fastest)

Threshold the image in HSV color space. Best when the subject is a
distinct color from the background.

```bash
# purple subject (default values)
python tools/process-video.py v.mp4 --out data/ \
  --mode hsv --hue 115,175 --sat-min 40 --val-min 25

# red subject (red wraps around hue 0/180, may need two passes)
python tools/process-video.py v.mp4 --out data/ \
  --mode hsv --hue 0,15 --sat-min 50

# yellow subject
python tools/process-video.py v.mp4 --out data/ \
  --mode hsv --hue 20,40
```

Hue ranges (OpenCV uses 0–180, not 0–360):
- Red: 0–10 and 170–180 (wraps around — pick whichever side dominates)
- Orange: 10–25
- Yellow: 25–35
- Green: 40–80
- Cyan: 80–100
- Blue: 100–130
- Purple/Magenta: 130–170

### `--mode dark` (simple)

Threshold on grayscale. Good when subject and background have very
different brightness.

```bash
# white flower on black background (subject is brighter)
python tools/process-video.py v.mp4 --out data/ --mode dark --threshold 60

# black object on white background (subject is darker)
python tools/process-video.py v.mp4 --out data/ \
  --mode dark --threshold 200 --invert
```

### `--mode rembg` (slowest, most reliable)

Uses [rembg](https://github.com/danielgatis/rembg) (U²-Net) for AI
background removal. Works on basically any subject and any background,
but takes ~10x longer. No tuning required.

```bash
python tools/process-video.py v.mp4 --out data/ --mode rembg
```

If you're not sure which mode to use, start with `rembg`. It just works.

## Tuning

Most of the time you'll only adjust a few flags:

| Flag | Default | What it does |
|---|---|---|
| `--smooth` | 7 | Bbox smoothing window. Higher = stabler edges, more lag at start/end of motion. Try 3 if your video is short or fast. |
| `--natural-max-edge` | 420 | Max edge length (px) of natural-aspect frames. Lower = smaller files. |
| `--scene-size` | 480 | Square canvas size for scene frames. Should match `manifest.json`. |
| `--quality` | 80 | WebP quality 0–100. 80 is visually lossless for most content. |
| `--min-area` | 500 | Reject detections smaller than this many pixels (filters noise). |
| `--debug` | off | Save bbox overlays in `data/debug/`. Use this when tuning. |

## Workflow

When something looks wrong (jittery edges, framing too loose/tight,
detection misses some frames), run with `--debug` and open
`data/debug/000.jpg`, `060.jpg`, `120.jpg` to see where the boxes
landed:

```bash
python tools/process-video.py v.mp4 --out data/ --mode hsv --debug
open data/debug/000.jpg
```

Common fixes:
- **Box doesn't cover the subject** → wrong mode/parameters. Try
  `--mode rembg` first to confirm the rest of the pipeline is fine.
- **Box has noise outside the subject** → increase `--morph-open` (try
  9 or 11) or `--min-area`.
- **Box flickers between frames** → increase `--smooth` (try 11).
- **Box has gaps inside the subject** → increase `--morph-close` (try
  21 or 25).

## What gets generated

```
data/
├── aspects.json              -- list of W/H ratios, one per frame
├── frames-natural/
│   ├── 000.webp              -- frame 0, tight-cropped, native aspect
│   ├── 001.webp
│   └── ...
└── frames-scene/
    ├── 000.webp              -- frame 0, on 480×480 canvas, subject
    ├── 001.webp                 centered, scale relative to its
    └── ...                      maximum bbox across all frames
```

## Caveats

- One subject per video. Multi-object scenes will pick the largest
  connected component each frame, which may flicker between objects.
- Frame rate is whatever your source video uses. The demo doesn't care.
- If your video is very long (>500 frames), expect a noticeable wait
  for `rembg` mode and a heavier final asset.
