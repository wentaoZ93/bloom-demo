// =========================================================================
// Bloom demo · interaction logic
// Three independent controllers sharing the FrameSequence loader.
// =========================================================================

// ---------- Constants ----------

// Outward-pointing unit vector for each resize direction.
// Used by Option 1: dragging in direction d only changes the size scalar,
// computed as the projection of mouse delta onto this vector.
const DIR_VEC = {
  e:  [ 1,  0],
  w:  [-1,  0],
  s:  [ 0,  1],
  n:  [ 0, -1],
  se: [ Math.SQRT1_2,  Math.SQRT1_2],
  sw: [-Math.SQRT1_2,  Math.SQRT1_2],
  ne: [ Math.SQRT1_2, -Math.SQRT1_2],
  nw: [-Math.SQRT1_2, -Math.SQRT1_2],
};

// ---------- Utilities ----------

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** Schedule a render through requestAnimationFrame; coalesces multiple calls. */
function rafScheduler(fn) {
  let pending = 0;
  return () => {
    if (pending) return;
    pending = requestAnimationFrame(() => { pending = 0; fn(); });
  };
}

/**
 * Ease-out (cubic): fast start, gentle settle.
 * From animations.dev easing blueprint.
 *   f(t) = 1 - (1 - t)^3
 */
function easeOut(t) {
  return 1 - Math.pow(1 - t, 3);
}

// ---------- Frame sequence loader ----------

class FrameSequence {
  /**
   * @param {string} pathTemplate - e.g. "data/frames-natural/{index}.webp"
   * @param {number} count        - total frame count
   */
  constructor(pathTemplate, count) {
    this.images = Array.from({ length: count }, (_, i) => {
      const idx = String(i).padStart(3, "0");
      const img = new Image();
      img.src = pathTemplate.replace("{index}", idx);
      return img;
    });
    this.ready = Promise.all(
      this.images.map(im =>
        new Promise(res => {
          if (im.complete) return res();
          im.addEventListener("load",  res, { once: true });
          im.addEventListener("error", res, { once: true });
        })
      )
    );
  }

  get(idx) { return this.images[idx]; }
  get length() { return this.images.length; }
}

// =========================================================================
// Option 1 · Locked aspect
//   - Frame is centered in stage (via flexbox on the stage)
//   - Aspect ratio is derived from the current frame's flower shape
//   - All 8 handles only mutate a single "size scalar"
// =========================================================================

class LockedAspectController {
  constructor(opts) {
    this.frame   = opts.frameEl;
    this.canvas  = opts.frameEl.querySelector(".frame__canvas");
    this.ctx     = this.canvas.getContext("2d");
    this.readout = opts.readoutEl;
    this.bar     = opts.barEl;
    this.frames  = opts.frames;
    this.aspects = opts.aspects;

    this.MIN = opts.minScalar;
    this.MAX = opts.maxScalar;
    this.scalar = opts.initialScalar;

    this.scheduleRender = rafScheduler(() => this.render());

    this._wireHandles();
    this.render();
  }

  render() {
    const t = clamp((this.scalar - this.MIN) / (this.MAX - this.MIN), 0, 1);
    const idx = Math.min(this.frames.length - 1, Math.floor(t * (this.frames.length - 1)));
    const ar = this.aspects[idx];
    const w = Math.round(this.scalar * Math.sqrt(ar));
    const h = Math.round(this.scalar / Math.sqrt(ar));

    this.frame.style.width  = w + "px";
    this.frame.style.height = h + "px";

    const dpr = window.devicePixelRatio || 1;
    this.canvas.width  = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.canvas.style.width  = w + "px";
    this.canvas.style.height = h + "px";

    const im = this.frames.get(idx);
    if (im && im.complete) {
      this.ctx.drawImage(im, 0, 0, this.canvas.width, this.canvas.height);
    }

    this.readout.textContent = `${w} × ${h} · frame ${idx + 1} / ${this.frames.length}`;
    this.bar.style.width = (t * 100) + "%";
  }

  _wireHandles() {
    let drag = null;
    this.frame.querySelectorAll(".rh").forEach(handle => {
      handle.addEventListener("pointerdown", e => {
        drag = {
          dir: handle.dataset.dir,
          sx: e.clientX, sy: e.clientY,
          startScalar: this.scalar,
        };
        handle.setPointerCapture(e.pointerId);
        e.stopPropagation();
        e.preventDefault();
      });
      handle.addEventListener("pointermove", e => {
        if (!drag) return;
        const [vx, vy] = DIR_VEC[drag.dir];
        const delta = (e.clientX - drag.sx) * vx + (e.clientY - drag.sy) * vy;
        this.scalar = clamp(drag.startScalar + delta, this.MIN, this.MAX);
        this.scheduleRender();
      });
      const stop = () => { drag = null; };
      handle.addEventListener("pointerup", stop);
      handle.addEventListener("pointercancel", stop);
    });
  }
}

// =========================================================================
// Option 2 · Mask window
//   - Flower lives in a fixed virtual scene centered in the stage
//   - The frame is an absolutely positioned viewport (movable + resizable)
//   - Canvas inside the frame is anchored to scene coords with a negative
//     offset = (sceneOrigin - framePosition), so the flower stays put
//     visually while the frame moves around
//   - Frame area drives the bloom scrub progress
// =========================================================================

class MaskWindowController {
  constructor(opts) {
    this.frame   = opts.frameEl;
    this.canvas  = opts.frameEl.querySelector(".frame__canvas");
    this.ctx     = this.canvas.getContext("2d");
    this.readout = opts.readoutEl;
    this.bar     = opts.barEl;
    this.frames  = opts.frames;

    this.STAGE   = opts.stageSize;
    this.SCENE   = opts.sceneSize;
    this.SCENE_X = (this.STAGE - this.SCENE) / 2;
    this.SCENE_Y = (this.STAGE - this.SCENE) / 2;

    this.MIN_SCRUB = opts.minScrubSize;
    this.MAX_SCRUB = opts.maxScrubSize;
    this.MIN_W = opts.minFrameSize;
    this.MIN_H = opts.minFrameSize;

    const init = opts.initialFrame;
    this.frame.style.width  = init.width  + "px";
    this.frame.style.height = init.height + "px";
    this.frame.style.left   = init.x      + "px";
    this.frame.style.top    = init.y      + "px";

    this.scheduleRender = rafScheduler(() => this.render());

    this._wireResize();
    this._wireMove();
    this.render();
  }

  render() {
    const fx = parseFloat(this.frame.style.left) || 0;
    const fy = parseFloat(this.frame.style.top)  || 0;
    const fw = this.frame.offsetWidth;
    const fh = this.frame.offsetHeight;

    // Anchor canvas to scene coordinates
    this.canvas.style.left = (this.SCENE_X - fx) + "px";
    this.canvas.style.top  = (this.SCENE_Y - fy) + "px";
    this.canvas.style.width  = this.SCENE + "px";
    this.canvas.style.height = this.SCENE + "px";

    const t = clamp(
      (Math.sqrt(fw * fh) - this.MIN_SCRUB) / (this.MAX_SCRUB - this.MIN_SCRUB),
      0, 1
    );
    const idx = Math.min(this.frames.length - 1, Math.floor(t * (this.frames.length - 1)));

    const dpr = window.devicePixelRatio || 1;
    this.canvas.width  = Math.round(this.SCENE * dpr);
    this.canvas.height = Math.round(this.SCENE * dpr);

    const im = this.frames.get(idx);
    if (im && im.complete) {
      this.ctx.drawImage(im, 0, 0, this.canvas.width, this.canvas.height);
    }

    this.readout.textContent = `${fw} × ${fh} · frame ${idx + 1} / ${this.frames.length}`;
    this.bar.style.width = (t * 100) + "%";
  }

  _wireResize() {
    let drag = null;
    this.frame.querySelectorAll(".rh").forEach(handle => {
      handle.addEventListener("pointerdown", e => {
        const startX = parseFloat(this.frame.style.left) || 0;
        const startY = parseFloat(this.frame.style.top)  || 0;
        const startW = this.frame.offsetWidth;
        const startH = this.frame.offsetHeight;
        drag = {
          dir: handle.dataset.dir,
          sx: e.clientX, sy: e.clientY,
          startX, startY, startW, startH,
          right:  startX + startW,
          bottom: startY + startH,
        };
        handle.setPointerCapture(e.pointerId);
        e.stopPropagation();
        e.preventDefault();
      });
      handle.addEventListener("pointermove", e => {
        if (!drag) return;
        const dx = e.clientX - drag.sx;
        const dy = e.clientY - drag.sy;
        const dir = drag.dir;
        let { startX, startY, startW, startH, right, bottom } = drag;
        let x = startX, y = startY, w = startW, h = startH;

        if (dir.includes("e")) {
          w = clamp(startW + dx, this.MIN_W, this.STAGE - x);
        }
        if (dir.includes("w")) {
          x = clamp(startX + dx, 0, right - this.MIN_W);
          w = right - x;
        }
        if (dir.includes("s")) {
          h = clamp(startH + dy, this.MIN_H, this.STAGE - y);
        }
        if (dir.includes("n")) {
          y = clamp(startY + dy, 0, bottom - this.MIN_H);
          h = bottom - y;
        }

        this.frame.style.left = x + "px";
        this.frame.style.top  = y + "px";
        this.frame.style.width  = w + "px";
        this.frame.style.height = h + "px";
        this.scheduleRender();
      });
      const stop = () => { drag = null; };
      handle.addEventListener("pointerup", stop);
      handle.addEventListener("pointercancel", stop);
    });
  }

  _wireMove() {
    let drag = null;
    this.frame.addEventListener("pointerdown", e => {
      if (e.target.closest(".rh")) return;
      drag = {
        sx: e.clientX, sy: e.clientY,
        startX: parseFloat(this.frame.style.left) || 0,
        startY: parseFloat(this.frame.style.top)  || 0,
      };
      this.frame.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    this.frame.addEventListener("pointermove", e => {
      if (!drag) return;
      const fw = this.frame.offsetWidth;
      const fh = this.frame.offsetHeight;
      const x = clamp(drag.startX + (e.clientX - drag.sx), 0, this.STAGE - fw);
      const y = clamp(drag.startY + (e.clientY - drag.sy), 0, this.STAGE - fh);
      this.frame.style.left = x + "px";
      this.frame.style.top  = y + "px";
      this.scheduleRender();
    });
    const stop = () => { drag = null; };
    this.frame.addEventListener("pointerup", stop);
    this.frame.addEventListener("pointercancel", stop);
  }
}

// =========================================================================
// Option 3 · Click to bloom
//   - Frame at rest is a small centered button (closed bud)
//   - Click triggers an ease-out animation: frame grows and frame index
//     advances in lockstep, both driven by a single progress value [0, 1]
//   - Mid-animation clicks are interruptible — animation continues from
//     the current progress in the new direction
// =========================================================================

class ClickToBloomController {
  constructor(opts) {
    this.frame   = opts.frameEl;
    this.canvas  = opts.frameEl.querySelector(".frame__canvas");
    this.ctx     = this.canvas.getContext("2d");
    this.readout = opts.readoutEl;
    this.bar     = opts.barEl;
    this.frames  = opts.frames;

    this.STAGE   = opts.stageSize;
    this.SCENE   = opts.sceneSize;
    this.SCENE_X = (this.STAGE - this.SCENE) / 2;
    this.SCENE_Y = (this.STAGE - this.SCENE) / 2;

    this.CLOSED  = opts.closedSize;
    this.OPEN    = opts.openSize;
    this.DURATION = opts.duration;

    this.isOpen = false;
    this.progress = 0;
    this.animFrom = 0;
    this.animTo   = 0;
    this.animStart = null;
    this.rafId = 0;

    this.frame.addEventListener("click", () => this.toggle());
    this.paint();
  }

  paint() {
    const size = this.CLOSED + (this.OPEN - this.CLOSED) * this.progress;
    const x = (this.STAGE - size) / 2;
    const y = (this.STAGE - size) / 2;

    this.frame.style.left   = x + "px";
    this.frame.style.top    = y + "px";
    this.frame.style.width  = size + "px";
    this.frame.style.height = size + "px";

    // Anchor canvas to scene coords (same trick as MaskWindow)
    this.canvas.style.left = (this.SCENE_X - x) + "px";
    this.canvas.style.top  = (this.SCENE_Y - y) + "px";
    this.canvas.style.width  = this.SCENE + "px";
    this.canvas.style.height = this.SCENE + "px";

    const idx = Math.min(this.frames.length - 1, Math.floor(this.progress * (this.frames.length - 1)));
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width  = Math.round(this.SCENE * dpr);
    this.canvas.height = Math.round(this.SCENE * dpr);

    const im = this.frames.get(idx);
    if (im && im.complete) {
      this.ctx.drawImage(im, 0, 0, this.canvas.width, this.canvas.height);
    }

    this.readout.textContent =
      `${Math.round(size)} × ${Math.round(size)} · frame ${idx + 1} / ${this.frames.length}`;
    this.bar.style.width = (this.progress * 100) + "%";
  }

  _tick(now) {
    if (this.animStart === null) this.animStart = now;
    const t = Math.min(1, (now - this.animStart) / this.DURATION);
    const eased = easeOut(t);
    this.progress = this.animFrom + (this.animTo - this.animFrom) * eased;
    this.paint();
    if (t < 1) {
      this.rafId = requestAnimationFrame(this._tick.bind(this));
    } else {
      this.progress = this.animTo;
      this.paint();
      this.rafId = 0;
    }
  }

  toggle() {
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.animFrom = this.progress;
    this.animTo = this.isOpen ? 0 : 1;
    this.isOpen = !this.isOpen;
    this.animStart = null;
    this.rafId = requestAnimationFrame(this._tick.bind(this));
  }
}

// =========================================================================
// Boot
// =========================================================================

async function main() {
  const [manifest, aspects] = await Promise.all([
    fetch("data/manifest.json").then(r => r.json()),
    fetch("data/aspects.json").then(r => r.json()),
  ]);

  const naturalFrames = new FrameSequence(manifest.naturalFrames.path, manifest.totalFrames);
  const sceneFrames   = new FrameSequence(manifest.sceneFrames.path,   manifest.totalFrames);

  // Option 1 · Locked aspect
  const opt1 = manifest.options.lockedAspect;
  const c1 = new LockedAspectController({
    frameEl:    document.querySelector('.frame[data-option="1"]'),
    readoutEl:  document.querySelector('[data-readout="1"]'),
    barEl:      document.querySelector('[data-progress="1"]'),
    frames:     naturalFrames,
    aspects,
    minScalar:     opt1.minScalar,
    maxScalar:     opt1.maxScalar,
    initialScalar: opt1.initialScalar,
  });

  // Option 2 · Mask window
  const opt2 = manifest.options.maskWindow;
  const c2 = new MaskWindowController({
    frameEl:    document.querySelector('.frame[data-option="2"]'),
    readoutEl:  document.querySelector('[data-readout="2"]'),
    barEl:      document.querySelector('[data-progress="2"]'),
    frames:     sceneFrames,
    stageSize:    manifest.stage.size,
    sceneSize:    manifest.sceneFrames.size,
    minScrubSize: opt2.minScrubSize,
    maxScrubSize: opt2.maxScrubSize,
    minFrameSize: opt2.minFrameSize,
    initialFrame: opt2.initialFrame,
  });

  // Option 3 · Click to bloom
  const opt3 = manifest.options.clickToBloom;
  const c3 = new ClickToBloomController({
    frameEl:    document.querySelector('.frame[data-option="3"]'),
    readoutEl:  document.querySelector('[data-readout="3"]'),
    barEl:      document.querySelector('[data-progress="3"]'),
    frames:     sceneFrames,
    stageSize:  manifest.stage.size,
    sceneSize:  manifest.sceneFrames.size,
    closedSize: opt3.closedSize,
    openSize:   opt3.openSize,
    duration:   opt3.duration,
  });

  // Re-render once frame sequences finish loading
  naturalFrames.ready.then(() => c1.render());
  sceneFrames.ready.then(() => {
    c2.render();
    c3.paint();
  });
}

main();
