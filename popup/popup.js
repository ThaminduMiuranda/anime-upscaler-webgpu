const NS = globalThis.VideoUpscaler;
const $ = (id) => document.getElementById(id);

let settings = NS.normalizeSettings();
let saveTimer = 0;

const ISSUE_TEXT = {
  drm: 'DRM-protected video — the browser blocks GPU access to its frames.',
  'cross-origin': 'Cross-origin video without CORS — WebGPU is not allowed to read it.',
  error: 'Rendering failed on a video (see the page console).',
};

function detectPreset(s) {
  for (const [name, p] of Object.entries(NS.PRESETS)) {
    if (NS.SLIDER_KEYS.every((k) => Math.abs(p[k] - s[k]) < 1e-6)) return name;
  }
  return 'custom';
}

function render() {
  document.body.classList.toggle('disabled', !settings.enabled);
  $('enabled').checked = settings.enabled;
  for (const btn of document.querySelectorAll('#presets button')) {
    btn.setAttribute('aria-checked', String(btn.dataset.preset === settings.preset));
  }
  for (const k of NS.SLIDER_KEYS) {
    $(k).value = String(settings[k]);
    $(`${k}-out`).textContent = `${Math.round(settings[k] * 100)}%`;
  }
  $('compare').checked = settings.compare;
  $('showStats').checked = settings.showStats;
  $('maxOutput').value = String(settings.maxOutput);
}

async function persist() {
  try {
    await chrome.storage.local.set({ settings });
  } catch (err) {
    console.error('Failed to save settings', err);
  }
}

/** Update + save. Slider drags are throttled so we don't flood storage events. */
function update(patch, { throttle = false } = {}) {
  settings = NS.normalizeSettings({ ...settings, ...patch });
  render();
  if (!throttle) {
    clearTimeout(saveTimer);
    saveTimer = 0;
    persist();
    return;
  }
  if (!saveTimer) {
    saveTimer = setTimeout(() => {
      saveTimer = 0;
      persist();
    }, 80);
  }
}

function setStatus(kind, main, sub = '') {
  $('statusDot').className = `dot ${kind}`;
  $('statusMain').textContent = main;
  $('statusSub').textContent = sub;
}

async function refreshStatus() {
  if (!settings.enabled) {
    setStatus('', 'Upscaler is off', 'Turn it on (or press Alt+Shift+U) to enhance videos.');
    return;
  }
  let res = null;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id !== undefined) res = await chrome.tabs.sendMessage(tab.id, { type: 'au:getStatus' });
  } catch {
    res = null; // no content script answered (no video, or a restricted page like chrome://)
  }

  if (!res) {
    setStatus('', 'No upscalable video in this tab', 'Play a video (at least 240×135 on screen). Reload the page if it was open before installing.');
    return;
  }
  if (res.videos?.length) {
    const v = res.videos[0];
    const more = res.videos.length > 1 ? ` (+${res.videos.length - 1} more)` : '';
    const perf = v.paused ? 'paused' : `${v.fps} fps · ${v.gpuMs} ms`;
    setStatus('ok', `Upscaling ${v.src[0]}×${v.src[1]} → ${v.out[0]}×${v.out[1]}${more}`,
      `${perf} · ${res.gpu || 'GPU'}`);
    return;
  }
  if (res.gpuError) {
    setStatus('err', 'WebGPU unavailable', `${res.gpuError}. Check chrome://gpu — WebGPU must be hardware accelerated.`);
    return;
  }
  const issue = res.issues?.[0];
  setStatus('warn', 'Video found but not upscalable', ISSUE_TEXT[issue] || issue || '');
}

function bind() {
  $('enabled').addEventListener('change', async (e) => {
    update({ enabled: e.target.checked });
    await refreshStatus();
  });

  for (const btn of document.querySelectorAll('#presets button')) {
    btn.addEventListener('click', () => {
      const name = btn.dataset.preset;
      if (!NS.PRESETS[name]) return;
      update({ preset: name, ...NS.PRESETS[name] });
    });
  }

  for (const k of NS.SLIDER_KEYS) {
    $(k).addEventListener('input', (e) => {
      const next = { ...settings, [k]: Number(e.target.value) };
      update({ [k]: next[k], preset: detectPreset(next) }, { throttle: true });
    });
    $(k).addEventListener('change', () => update({}));
  }

  $('compare').addEventListener('change', (e) => update({ compare: e.target.checked }));
  $('showStats').addEventListener('change', (e) => update({ showStats: e.target.checked }));
  $('maxOutput').addEventListener('change', (e) => update({ maxOutput: Number(e.target.value) }));
  $('reset').addEventListener('click', () => update({ ...NS.DEFAULTS }));

  // Reflect changes made elsewhere (e.g. keyboard shortcuts) while the popup is open.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.settings || saveTimer) return;
    settings = NS.normalizeSettings(changes.settings.newValue);
    render();
  });
}

async function main() {
  try {
    const { settings: stored } = await chrome.storage.local.get('settings');
    settings = NS.normalizeSettings(stored);
  } catch (err) {
    console.error('Failed to load settings', err);
  }
  render();
  bind();
  await refreshStatus();
  setInterval(refreshStatus, 1000);
}

main();
