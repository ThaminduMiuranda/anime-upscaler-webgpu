// Service worker: keyboard shortcuts + toolbar badge. Holds no state in memory.
importScripts('settings.js');

const { DEFAULTS, normalizeSettings } = globalThis.AnimeUpscaler;

async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return normalizeSettings(settings);
}

async function updateBadge() {
  try {
    const s = await getSettings();
    await chrome.action.setBadgeBackgroundColor({ color: '#6b4cff' });
    await chrome.action.setBadgeText({ text: s.enabled ? '' : 'OFF' });
  } catch (err) {
    console.warn('badge update failed', err);
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  try {
    const { settings } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: normalizeSettings({ ...DEFAULTS, ...settings }) });
  } catch (err) {
    console.warn('settings init failed', err);
  }
  await updateBadge();
});

chrome.runtime.onStartup.addListener(updateBadge);

chrome.commands.onCommand.addListener(async (command) => {
  try {
    const s = await getSettings();
    if (command === 'toggle-upscaler') s.enabled = !s.enabled;
    else if (command === 'toggle-compare') s.compare = !s.compare;
    else return;
    await chrome.storage.local.set({ settings: s });
  } catch (err) {
    console.warn('command failed', err);
  }
});

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area === 'local' && changes.settings) await updateBadge();
});
