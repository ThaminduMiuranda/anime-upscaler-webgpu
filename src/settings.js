// Shared settings/presets. Loaded by the content scripts, the popup and the service worker.
(() => {
  const NS = (globalThis.VideoUpscaler ||= {});
  if (NS.DEFAULTS) return;

  // Strength values are all 0..1.
  //  denoise    – edge-preserving bilateral filter on the source (removes compression noise / banding)
  //  edgeAA     – edge-directed smoothing during upscale (removes jaggies / stair-stepping on lines)
  //  warp       – warp-sharpening: pulls edge transitions tighter so edges/outlines look crisp
  //  lineDarken – darkens thin dark lines (outlines) slightly
  //  sharpen    – final halo-free adaptive sharpening at output resolution
  const PRESETS = {
    fast: { denoise: 0, edgeAA: 0, warp: 0, lineDarken: 0, sharpen: 0.35 },
    balanced: { denoise: 0.25, edgeAA: 0.6, warp: 0.5, lineDarken: 0.15, sharpen: 0.35 },
    quality: { denoise: 0.4, edgeAA: 0.85, warp: 0.8, lineDarken: 0.3, sharpen: 0.45 },
  };

  const DEFAULTS = {
    enabled: true,
    preset: 'balanced',
    ...PRESETS.balanced,
    compare: false,
    showStats: false,
    maxOutput: 2160, // max output height-class (1080 / 1440 / 2160)
  };

  const NUMERIC = ['denoise', 'edgeAA', 'warp', 'lineDarken', 'sharpen', 'maxOutput'];

  function normalizeSettings(raw) {
    const s = { ...DEFAULTS, ...(raw || {}) };
    for (const k of NUMERIC) {
      const n = Number(s[k]);
      s[k] = Number.isFinite(n) ? n : DEFAULTS[k];
    }
    s.enabled = !!s.enabled;
    s.compare = !!s.compare;
    s.showStats = !!s.showStats;
    return s;
  }

  NS.PRESETS = PRESETS;
  NS.DEFAULTS = DEFAULTS;
  NS.SLIDER_KEYS = ['denoise', 'edgeAA', 'warp', 'lineDarken', 'sharpen'];
  NS.normalizeSettings = normalizeSettings;
})();
