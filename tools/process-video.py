#!/usr/bin/env python3
"""
process-video.py — turn a source video of a single subject into the asset
sequence the Bloom demo expects.

Outputs (under --out):
    aspects.json
    frames-natural/000.webp ... NNN.webp   tight crops, native aspect
    frames-scene/000.webp   ... NNN.webp   uniform 480x480, subject centered
                                           at constant scale relative to its
                                           own max bbox

The tool ships three subject-detection modes:
    --mode hsv     (default) HSV color range. Fast, no external deps beyond
                   OpenCV and numpy. Best for solid-colored subjects on
                   clean backgrounds.
    --mode dark    Subject is darker than background (or vice versa).
                   Simple grayscale threshold.
    --mode rembg   Use the rembg / U²-Net model. Works on arbitrary subjects
                   and backgrounds. Requires `pip install rembg`. ~10x
                   slower than HSV but no parameter tuning.

Examples:
    # Purple flower on dark background (the original Anemone clip)
    python process-video.py video.mp4 --out ../data \\
      --mode hsv --hue 115,175 --sat-min 40 --val-min 25

    # White flower on dark background
    python process-video.py video.mp4 --out ../data \\
      --mode dark --threshold 60

    # Anything on anything (slowest, most reliable)
    python process-video.py video.mp4 --out ../data --mode rembg

Tip: if the bbox is unstable across frames (jittering edges), increase
--smooth.
"""

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path

import cv2
import numpy as np


# ---------------------------------------------------------------------------
# Subject-mask backends
# ---------------------------------------------------------------------------

def mask_hsv(img_bgr, hue_lo, hue_hi, sat_min, val_min):
    """Threshold on HSV color range. Returns binary mask (uint8 0/255)."""
    hsv = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2HSV)
    mask = cv2.inRange(hsv, (hue_lo, sat_min, val_min), (hue_hi, 255, 255))
    return mask


def mask_dark(img_bgr, threshold, invert):
    """
    Threshold on grayscale.
    invert=False  -> subject is BRIGHTER than background
    invert=True   -> subject is DARKER  than background
    """
    gray = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2GRAY)
    if invert:
        _, mask = cv2.threshold(gray, threshold, 255, cv2.THRESH_BINARY_INV)
    else:
        _, mask = cv2.threshold(gray, threshold, 255, cv2.THRESH_BINARY)
    return mask


_REMBG_SESSION = None
def mask_rembg(img_bgr):
    """U²-Net background removal. Returns alpha-derived mask."""
    global _REMBG_SESSION
    try:
        from rembg import remove, new_session
    except ImportError:
        sys.exit("rembg not installed. Run: pip install rembg")
    if _REMBG_SESSION is None:
        _REMBG_SESSION = new_session()
    rgba = remove(img_bgr, session=_REMBG_SESSION)
    if rgba.shape[2] == 4:
        return rgba[:, :, 3]
    return cv2.cvtColor(rgba, cv2.COLOR_BGR2GRAY)


def build_mask(img_bgr, args):
    if args.mode == "hsv":
        h_lo, h_hi = args.hue
        return mask_hsv(img_bgr, h_lo, h_hi, args.sat_min, args.val_min)
    if args.mode == "dark":
        return mask_dark(img_bgr, args.threshold, args.invert)
    if args.mode == "rembg":
        return mask_rembg(img_bgr)
    raise ValueError(args.mode)


# ---------------------------------------------------------------------------
# Bounding box detection
# ---------------------------------------------------------------------------

def detect_bbox(img_bgr, args):
    """
    Return (x, y, w, h) of the largest connected component in the subject
    mask, or None if no subject was found.
    """
    mask = build_mask(img_bgr, args)

    # Clean up small noise and close gaps
    kernel_open = np.ones((args.morph_open, args.morph_open), np.uint8)
    kernel_close = np.ones((args.morph_close, args.morph_close), np.uint8)
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel_open)
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel_close)

    # Largest connected component (excluding background label 0)
    n, _, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
    if n <= 1:
        return None
    biggest = 1 + np.argmax(stats[1:, cv2.CC_STAT_AREA])
    x, y, w, h, area = stats[biggest]
    if area < args.min_area:
        return None
    return (int(x), int(y), int(w), int(h))


def smooth_boxes(boxes, window):
    """
    Time-domain box smoothing. For each frame, average the bbox across a
    window of neighbors. Cuts down jittery edges.
    """
    out = []
    for i in range(len(boxes)):
        nb = [b for b in boxes[max(0, i - window): i + window + 1] if b is not None]
        if not nb:
            out.append(None)
            continue
        out.append(tuple(int(np.mean([b[k] for b in nb])) for k in range(4)))
    return out


# ---------------------------------------------------------------------------
# Pipeline
# ---------------------------------------------------------------------------

def extract_frames(video_path, out_dir):
    """Use ffmpeg to extract all frames as PNGs."""
    out_dir.mkdir(parents=True, exist_ok=True)
    print(f"[1/5] Extracting frames from {video_path.name}...")
    subprocess.run([
        "ffmpeg", "-y", "-loglevel", "error",
        "-i", str(video_path),
        "-vsync", "0",
        str(out_dir / "f_%04d.png"),
    ], check=True)
    paths = sorted(out_dir.glob("*.png"))
    print(f"      {len(paths)} frames")
    return paths


def main():
    ap = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument("video", type=Path, help="input video file")
    ap.add_argument("--out", type=Path, required=True,
                    help="output directory (matches the demo's data/ folder)")

    # Detection mode
    ap.add_argument("--mode", choices=["hsv", "dark", "rembg"], default="hsv")

    # HSV parameters
    ap.add_argument("--hue", type=lambda s: tuple(int(x) for x in s.split(",")),
                    default=(115, 175),
                    help="HSV hue range, comma-separated, 0-180. Default 115,175 (purple).")
    ap.add_argument("--sat-min", type=int, default=40)
    ap.add_argument("--val-min", type=int, default=25)

    # Dark/bright threshold parameters
    ap.add_argument("--threshold", type=int, default=60,
                    help="Grayscale threshold for --mode dark. Default 60.")
    ap.add_argument("--invert", action="store_true",
                    help="For --mode dark: subject is DARKER than background.")

    # Mask cleanup
    ap.add_argument("--morph-open", type=int, default=5)
    ap.add_argument("--morph-close", type=int, default=15)
    ap.add_argument("--min-area", type=int, default=500,
                    help="Minimum subject pixel area to count as a detection.")

    # Time-domain smoothing
    ap.add_argument("--smooth", type=int, default=7,
                    help="Bbox smoothing window. Higher = stabler edges, more lag.")

    # Output sizes
    ap.add_argument("--natural-max-edge", type=int, default=420,
                    help="Max edge length (px) for tight-cropped frames.")
    ap.add_argument("--scene-size", type=int, default=480,
                    help="Square canvas size for scene frames.")
    ap.add_argument("--quality", type=int, default=80,
                    help="WebP quality, 0-100.")

    # Misc
    ap.add_argument("--keep-temp", action="store_true",
                    help="Don't delete intermediate raw frames.")
    ap.add_argument("--debug", action="store_true",
                    help="Save debug overlays of detected bboxes.")

    args = ap.parse_args()

    if not args.video.exists():
        sys.exit(f"Input video not found: {args.video}")
    args.out.mkdir(parents=True, exist_ok=True)
    natural_dir = args.out / "frames-natural"
    scene_dir   = args.out / "frames-scene"
    debug_dir   = args.out / "debug"
    raw_dir     = args.out / "_raw"
    if natural_dir.exists(): shutil.rmtree(natural_dir)
    if scene_dir.exists():   shutil.rmtree(scene_dir)
    if debug_dir.exists():   shutil.rmtree(debug_dir)
    natural_dir.mkdir(parents=True)
    scene_dir.mkdir(parents=True)
    if args.debug: debug_dir.mkdir(parents=True)

    # 1. Extract
    frame_paths = extract_frames(args.video, raw_dir)
    if not frame_paths:
        sys.exit("ffmpeg produced no frames")

    # 2. Detect bbox per frame
    print(f"[2/5] Detecting subject bboxes ({args.mode})...")
    raw_boxes = []
    for fp in frame_paths:
        img = cv2.imread(str(fp))
        bb = detect_bbox(img, args)
        raw_boxes.append(bb)
    detected = sum(1 for b in raw_boxes if b is not None)
    print(f"      {detected}/{len(raw_boxes)} frames had a detection")
    if detected < len(raw_boxes) * 0.5:
        print("      ⚠ Low detection rate. Try a different --mode or adjust thresholds.")

    # 3. Smooth bboxes over time
    print(f"[3/5] Smoothing bboxes (window={args.smooth})...")
    boxes = smooth_boxes(raw_boxes, args.smooth)

    # 4. Determine global max bbox dimension (for scene scaling)
    max_dim = max(max(b[2], b[3]) for b in boxes if b is not None)
    print(f"      max bbox dim across all frames: {max_dim}px")

    # 5. Write outputs
    print(f"[4/5] Writing natural + scene frames...")
    aspects = []
    for i, fp in enumerate(frame_paths):
        img = cv2.imread(str(fp))
        H, W = img.shape[:2]
        bb = boxes[i]
        # Hold last-known bbox if a frame has no detection
        if bb is None:
            bb = next((b for b in boxes[i:] if b is not None),
                      next((b for b in boxes[:i][::-1] if b is not None), (0, 0, W, H)))

        x, y, w, h = bb
        x = max(0, x); y = max(0, y)
        w = min(W - x, w); h = min(H - y, h)
        crop = img[y:y+h, x:x+w]
        aspects.append(round(w / h, 4))

        # ---- natural: scale tight crop so longest edge = natural_max_edge ----
        scale = args.natural_max_edge / max(w, h)
        nw, nh = max(1, int(w * scale)), max(1, int(h * scale))
        natural = cv2.resize(crop, (nw, nh), interpolation=cv2.INTER_LANCZOS4)
        cv2.imwrite(str(natural_dir / f"{i:03d}.webp"), natural,
                    [cv2.IMWRITE_WEBP_QUALITY, args.quality])

        # ---- scene: scale relative to global max_dim, center on square canvas ----
        s_scale = args.scene_size / max_dim
        sw, sh = max(1, int(w * s_scale)), max(1, int(h * s_scale))
        scaled = cv2.resize(crop, (sw, sh), interpolation=cv2.INTER_LANCZOS4)
        canvas = np.zeros((args.scene_size, args.scene_size, 3), dtype=np.uint8)
        ox = (args.scene_size - sw) // 2
        oy = (args.scene_size - sh) // 2
        canvas[oy:oy+sh, ox:ox+sw] = scaled
        cv2.imwrite(str(scene_dir / f"{i:03d}.webp"), canvas,
                    [cv2.IMWRITE_WEBP_QUALITY, args.quality])

        # ---- debug overlay ----
        if args.debug:
            vis = img.copy()
            cv2.rectangle(vis, (x, y), (x+w, y+h), (0, 255, 255), 3)
            cv2.imwrite(str(debug_dir / f"{i:03d}.jpg"), vis,
                        [cv2.IMWRITE_JPEG_QUALITY, 70])

    # 6. aspects.json + manifest update hint
    print(f"[5/5] Writing aspects.json...")
    (args.out / "aspects.json").write_text(json.dumps(aspects))

    # Update manifest in place if it exists, otherwise leave a hint
    manifest_path = args.out / "manifest.json"
    if manifest_path.exists():
        m = json.loads(manifest_path.read_text())
        m["totalFrames"] = len(frame_paths)
        m["sceneFrames"]["size"] = args.scene_size
        manifest_path.write_text(json.dumps(m, indent=2))
        print(f"      updated manifest.json (totalFrames={len(frame_paths)})")
    else:
        print(f"      no manifest.json found in {args.out} — remember to set totalFrames={len(frame_paths)}")

    # Cleanup
    if not args.keep_temp:
        shutil.rmtree(raw_dir)
    print(f"\n✓ Done. Output in {args.out}")
    if args.debug:
        print(f"  Debug overlays in {debug_dir}")


if __name__ == "__main__":
    main()
