// Content script: finds <video> elements, overlays a WebGPU canvas on each and renders
// upscaled frames in sync with the video (requestVideoFrameCallback).
(() => {
  const NS = (globalThis.VideoUpscaler ||= {});
  if (NS.contentLoaded) return;
  NS.contentLoaded = true;

  const LOG = '[Video Upscaler]';
  const MIN_W = 240; // ignore thumbnails / hover previews (CSS px)
  const MIN_H = 135;
  const GPU_RETRY_MS = 15000;
  const hasChrome = typeof chrome !== 'undefined' && !!chrome.storage?.local;

  let settings = NS.normalizeSettings(NS.testSettings);
  const controllers = new Map(); // video -> Controller
  const issues = new Map(); // video -> reason (for popup status)
  const failures = new WeakMap(); // video -> permanent failure reason
  const waitingForData = new WeakSet();
  let gpu = null;
  let gpuError = null;
  let gpuFailedAt = 0;

  /** Where the video picture actually sits inside its element box (object-fit aware). */
  function contentBox(ew, eh, vw, vh, fit) {
    let w = ew;
    let h = eh;
    if (fit !== 'fill') {
      const sx = ew / vw;
      const sy = eh / vh;
      let s = Math.min(sx, sy); // contain (default)
      if (fit === 'cover') s = Math.max(sx, sy);
      else if (fit === 'none') s = 1;
      else if (fit === 'scale-down') s = Math.min(1, s);
      w = vw * s;
      h = vh * s;
    }
    return { x: (ew - w) / 2, y: (eh - h) / 2, w, h };
  }

  class Controller {
    constructor(video, gpuCtx) {
      this.video = video;
      this.dead = false;
      this.pos = { l: 0, t: 0, w: -1, h: -1 };
      this.box = { x: NaN, y: NaN, w: NaN, h: NaN };
      this.out = { w: 0, h: 0 };
      this.objectFit = 'contain';
      this.frames = 0;
      this.fps = 0;
      this.fpsT0 = performance.now();
      this.gpuMs = 0;
      this.measuring = false;

      // Wrapper covers the video's element box and clips (needed for object-fit: cover).
      const wrap = (this.wrapper = document.createElement('div'));
      wrap.setAttribute('data-video-upscaler', '');
      wrap.style.cssText = [
        'position:absolute', 'left:0', 'top:0', 'width:0', 'height:0', 'margin:0', 'padding:0',
        'border:0', 'overflow:hidden', 'pointer-events:none', 'background:transparent',
        'display:block', 'visibility:hidden', 'transform:none', 'contain:strict',
      ].join(';');
      const canvas = (this.canvas = document.createElement('canvas'));
      canvas.style.cssText = 'position:absolute;left:0;top:0;display:block;margin:0;padding:0;border:0;max-width:none;max-height:none;';
      const stats = (this.statsEl = document.createElement('div'));
      stats.style.cssText = 'position:absolute;left:8px;top:8px;padding:3px 8px;font:600 11px/1.5 system-ui,sans-serif;color:#fff;background:rgba(24,12,48,.75);border-radius:6px;white-space:nowrap;display:none;';
      wrap.append(canvas, stats);

      this.renderer = new NS.Renderer(gpuCtx, canvas);
      video.after(wrap); // directly after the video: above it, below the player's controls/subtitles
      this.refreshStyle();
      this.updateStatsVisibility();

      this.loop = () => {
        if (this.dead) return;
        this.rvfc = this.video.requestVideoFrameCallback(this.loop);
        this.draw();
      };
      this.rvfc = video.requestVideoFrameCallback(this.loop);

      this.ro = new ResizeObserver(() => {
        this.refreshStyle();
        this.draw();
      });
      this.ro.observe(video);
      this.onMediaEvent = () => this.draw();
      for (const ev of ['seeked', 'loadeddata', 'resize']) video.addEventListener(ev, this.onMediaEvent);
      // While paused there are no frame callbacks; keep the overlay aligned if the layout moves.
      this.timer = setInterval(() => {
        if (this.video.paused || this.video.ended) this.draw(true);
      }, 500);
      this.draw();
    }

    refreshStyle() {
      const cs = getComputedStyle(this.video);
      this.objectFit = cs.objectFit || 'contain';
      this.hiddenByStyle = cs.visibility === 'hidden' || cs.opacity === '0';
      this.wrapper.style.zIndex = cs.zIndex !== 'auto' ? cs.zIndex : '';
    }

    updateStatsVisibility() {
      this.statsEl.style.display = settings.showStats ? 'block' : 'none';
    }

    syncLayout() {
      const v = this.video;
      const wrap = this.wrapper;
      const p = this.pos;
      const vr = v.getBoundingClientRect();
      if (vr.width < 2 || vr.height < 2 || this.hiddenByStyle) return null;
      let changed = false;

      // Self-correcting positioning: measure where the wrapper is, move it by the difference.
      const wr = wrap.getBoundingClientRect();
      const dl = vr.left - wr.left;
      const dt = vr.top - wr.top;
      if (Math.abs(dl) > 0.5 || Math.abs(dt) > 0.5) {
        p.l += dl;
        p.t += dt;
        wrap.style.left = `${p.l}px`;
        wrap.style.top = `${p.t}px`;
        changed = true;
      }
      if (p.w !== vr.width || p.h !== vr.height) {
        p.w = vr.width;
        p.h = vr.height;
        wrap.style.width = `${p.w}px`;
        wrap.style.height = `${p.h}px`;
        changed = true;
      }

      const box = contentBox(vr.width, vr.height, v.videoWidth, v.videoHeight, this.objectFit);
      const b = this.box;
      if (b.x !== box.x || b.y !== box.y || b.w !== box.w || b.h !== box.h) {
        Object.assign(b, box);
        const cs = this.canvas.style;
        cs.left = `${box.x}px`;
        cs.top = `${box.y}px`;
        cs.width = `${box.w}px`;
        cs.height = `${box.h}px`;
        changed = true;
      }

      // Output resolution = displayed size in device pixels, capped.
      const dpr = window.devicePixelRatio || 1;
      let w = box.w * dpr;
      let h = box.h * dpr;
      const maxH = settings.maxOutput || 2160;
      const maxPixels = (maxH * maxH * 16) / 9;
      if (w * h > maxPixels) {
        const k = Math.sqrt(maxPixels / (w * h));
        w *= k;
        h *= k;
      }
      const lim = this.renderer.gpu.maxTextureDimension2D;
      if (w > lim || h > lim) {
        const k = lim / Math.max(w, h);
        w *= k;
        h *= k;
      }
      w = Math.max(1, Math.round(w));
      h = Math.max(1, Math.round(h));
      if (w !== this.out.w || h !== this.out.h) {
        this.out = { w, h };
        changed = true;
      }
      return { w, h, changed };
    }

    async draw(onlyIfMoved = false) {
      if (this.dead) return;
      const v = this.video;
      if (!v.isConnected || !this.wrapper.isConnected) {
        scheduleScan(0);
        return;
      }
      if (v.mediaKeys) {
        failVideo(v, 'drm');
        return;
      }
      if (v.readyState < 2 || !v.videoWidth) return;
      const layout = this.syncLayout();
      if (!layout) {
        this.wrapper.style.visibility = 'hidden';
        return;
      }
      if (onlyIfMoved && !layout.changed) return;
      try {
        await this.renderer.render(v, layout.w, layout.h, settings);
      } catch (err) {
        if (err?.name === 'SecurityError') {
          failVideo(v, 'cross-origin');
        } else {
          console.warn(LOG, 'render failed:', err);
          failVideo(v, 'error');
        }
        return;
      }
      // Reveal only after the first successful frame so there's no black flash.
      if (this.wrapper.style.visibility !== 'visible') this.wrapper.style.visibility = 'visible';
      this.tick();
    }

    tick() {
      this.frames++;
      const now = performance.now();
      const dt = now - this.fpsT0;
      if (dt < 1000) return;
      this.fps = Math.round((this.frames * 1000) / dt);
      this.frames = 0;
      this.fpsT0 = now;
      if (!this.measuring) {
        this.measuring = true;
        const t0 = performance.now();
        (async () => {
          try {
            await this.renderer.gpu.device.queue.onSubmittedWorkDone();
            this.gpuMs = performance.now() - t0;
          } catch {
            // device lost
          }
          this.measuring = false;
        })();
      }
      if (settings.showStats) {
        const v = this.video;
        this.statsEl.textContent =
          `⬆ ${v.videoWidth}×${v.videoHeight} → ${this.out.w}×${this.out.h} · ${this.fps} fps · ${this.gpuMs.toFixed(1)} ms`;
      }
    }

    status() {
      return {
        src: [this.video.videoWidth, this.video.videoHeight],
        out: [this.out.w, this.out.h],
        fps: this.video.paused ? 0 : this.fps,
        gpuMs: Math.round(this.gpuMs * 10) / 10,
        paused: this.video.paused,
      };
    }

    destroy() {
      if (this.dead) return;
      this.dead = true;
      try {
        this.video.cancelVideoFrameCallback(this.rvfc);
      } catch {
        // ignore
      }
      this.ro.disconnect();
      for (const ev of ['seeked', 'loadeddata', 'resize']) this.video.removeEventListener(ev, this.onMediaEvent);
      clearInterval(this.timer);
      this.renderer.destroy();
      this.wrapper.remove();
    }
  }

  function failVideo(video, reason) {
    failures.set(video, reason);
    issues.set(video, reason);
    const c = controllers.get(video);
    if (c) {
      c.destroy();
      controllers.delete(video);
    }
    if (reason !== 'drm') console.info(LOG, `skipping video (${reason})`, video);
  }

  function destroyAll() {
    for (const c of controllers.values()) c.destroy();
    controllers.clear();
  }

  function checkEligible(v) {
    if (failures.has(v)) return failures.get(v);
    if (v.mediaKeys) return 'drm';
    if (v.readyState < 2 || !v.videoWidth) {
      if (!waitingForData.has(v)) {
        waitingForData.add(v);
        v.addEventListener('loadeddata', () => {
          waitingForData.delete(v);
          scheduleScan(0);
        }, { once: true });
      }
      return 'loading';
    }
    const r = v.getBoundingClientRect();
    if (r.width < MIN_W || r.height < MIN_H) return 'small';
    return null;
  }

  async function acquireGpu() {
    if (gpu && !gpu.lost) return gpu;
    if (gpuError && performance.now() - gpuFailedAt < GPU_RETRY_MS) return null;
    try {
      gpu = await NS.getGpu();
      gpuError = null;
      return gpu;
    } catch (err) {
      gpu = null;
      gpuError = err?.message || String(err);
      gpuFailedAt = performance.now();
      console.warn(LOG, 'WebGPU init failed:', gpuError);
      return null;
    }
  }

  NS.onDeviceLost = () => {
    gpu = null;
    destroyAll();
    scheduleScan(1000);
  };

  let scanTimer = 0;
  function scheduleScan(delay = 300) {
    if (scanTimer) return;
    scanTimer = setTimeout(() => {
      scanTimer = 0;
      scan();
    }, delay);
  }

  async function scan() {
    for (const [v, c] of controllers) {
      if (!settings.enabled || !v.isConnected || !c.wrapper.isConnected || c.dead) {
        c.destroy();
        controllers.delete(v);
      }
    }
    for (const v of issues.keys()) if (!v.isConnected) issues.delete(v);
    if (!settings.enabled) return;

    for (const v of document.querySelectorAll('video')) {
      if (controllers.has(v)) continue;
      const reason = checkEligible(v);
      if (reason) {
        issues.set(v, reason);
        continue;
      }
      issues.delete(v);
      const g = await acquireGpu();
      if (!g) return;
      if (!settings.enabled || controllers.has(v) || !v.isConnected) continue;
      try {
        controllers.set(v, new Controller(v, g));
      } catch (err) {
        console.warn(LOG, 'could not attach to video:', err);
        failures.set(v, 'error');
        issues.set(v, 'error');
      }
    }
  }

  function applySettings(next) {
    settings = NS.normalizeSettings(next);
    if (!settings.enabled) {
      destroyAll();
      return;
    }
    for (const c of controllers.values()) {
      c.updateStatsVisibility();
      c.draw(); // refresh immediately, even when paused
    }
    scheduleScan(0);
  }

  const NOTABLE = new Set(['drm', 'cross-origin', 'error']);

  function onMessage(msg, _sender, sendResponse) {
    if (msg?.type !== 'au:getStatus') return false;
    const active = [...controllers.values()].filter((c) => !c.dead);
    const notable = [...new Set([...issues.values()].filter((r) => NOTABLE.has(r)))];
    const hasVideos = !!document.querySelector('video');
    if (!active.length && !notable.length && !(gpuError && hasVideos)) return false; // let other frames answer

    const payload = {
      host: location.hostname,
      gpu: gpu?.adapterName || null,
      gpuError,
      videos: active.map((c) => c.status()),
      issues: notable,
    };
    if (active.length) {
      sendResponse(payload);
      return false;
    }
    // Frames with only problems answer slightly later so a frame with a working video wins.
    setTimeout(() => sendResponse(payload), 200);
    return true;
  }

  async function init() {
    if (hasChrome) {
      try {
        const { settings: stored } = await chrome.storage.local.get('settings');
        settings = NS.normalizeSettings(stored);
      } catch (err) {
        console.warn(LOG, 'could not read settings:', err);
      }
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && changes.settings) applySettings(changes.settings.newValue);
      });
      chrome.runtime.onMessage.addListener(onMessage);
    }
    NS.applySettings = applySettings; // used by the test harness
    new MutationObserver(() => scheduleScan()).observe(document.documentElement, { childList: true, subtree: true });
    setInterval(() => scheduleScan(0), 2000);
    scan();
  }

  init();
})();
