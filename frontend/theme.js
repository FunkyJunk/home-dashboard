// Shared between index.html and settings.html so both pages apply the
// same saved theme identically - a second copy of this data would drift
// the moment one page's presets were tweaked and the other's weren't.
// Themes just overwrite the same CSS custom properties every page's own
// :root block already defines defaults for.
const THEME_PRESETS = {
  midnight: {
    label: 'Midnight',
    vars: { '--bg':'#12161c', '--bg-inset':'#0d1116', '--panel':'#1b212b', '--panel-line':'#2a323f', '--text':'#ece7db', '--text-dim':'#8b93a1', '--amber':'#e8a33d', '--amber-dim':'#6b5730', '--teal':'#4fb8ae', '--teal-dim':'#2c5b56', '--coral':'#e2574c', '--coral-dim':'#5a2a26' },
  },
  slate: {
    label: 'Slate',
    vars: { '--bg':'#15181d', '--bg-inset':'#0e1013', '--panel':'#1e2228', '--panel-line':'#323841', '--text':'#e8eaed', '--text-dim':'#8a929c', '--amber':'#5b9bf0', '--amber-dim':'#274873', '--teal':'#9d8cf0', '--teal-dim':'#3c3468', '--coral':'#f0615b', '--coral-dim':'#5c2a28' },
  },
  forest: {
    label: 'Forest',
    vars: { '--bg':'#12190f', '--bg-inset':'#0c120a', '--panel':'#1b2818', '--panel-line':'#2e4029', '--text':'#eef0e4', '--text-dim':'#8fa085', '--amber':'#c9a53d', '--amber-dim':'#5c4d22', '--teal':'#5fbf8a', '--teal-dim':'#28513a', '--coral':'#e2574c', '--coral-dim':'#5a2a26' },
  },
  sunset: {
    label: 'Sunset',
    vars: { '--bg':'#1b1219', '--bg-inset':'#140c12', '--panel':'#2a1c26', '--panel-line':'#402e3b', '--text':'#f2e6e9', '--text-dim':'#a08b95', '--amber':'#f0813d', '--amber-dim':'#6b3c1f', '--teal':'#e85f9a', '--teal-dim':'#5c2947', '--coral':'#ef4e4e', '--coral-dim':'#5c2626' },
  },
  ocean: {
    label: 'Ocean',
    vars: { '--bg':'#0d1a1f', '--bg-inset':'#081215', '--panel':'#132830', '--panel-line':'#204048', '--text':'#e3f2f0', '--text-dim':'#7fa3a8', '--amber':'#3dc6e8', '--amber-dim':'#1e5666', '--teal':'#4f8ab8', '--teal-dim':'#264a63', '--coral':'#e2574c', '--coral-dim':'#5a2a26' },
  },
  mono: {
    label: 'Mono',
    vars: { '--bg':'#15161a', '--bg-inset':'#0f1013', '--panel':'#1e2024', '--panel-line':'#33363c', '--text':'#eceef0', '--text-dim':'#8a8d93', '--amber':'#c8ccd2', '--amber-dim':'#4a4d54', '--teal':'#9aa0a8', '--teal-dim':'#383c42', '--coral':'#e2574c', '--coral-dim':'#5a2a26' },
  },
};

// Every variable a theme can set, in display order, with a human label -
// the Settings > Theme full editor uses this list to build one input per
// variable rather than hand-listing them a second time somewhere else.
const THEME_VAR_KEYS = [
  { key: '--bg', label: 'Background' },
  { key: '--bg-inset', label: 'Background (inset)' },
  { key: '--panel', label: 'Panel' },
  { key: '--panel-line', label: 'Panel border' },
  { key: '--text', label: 'Text' },
  { key: '--text-dim', label: 'Text (dim)' },
  { key: '--amber', label: 'Amber accent' },
  { key: '--amber-dim', label: 'Amber accent (dim)' },
  { key: '--teal', label: 'Teal accent' },
  { key: '--teal-dim', label: 'Teal accent (dim)' },
  { key: '--coral', label: 'Coral accent' },
  { key: '--coral-dim', label: 'Coral accent (dim)' },
];

const THEME_KEY = 'dashboard-theme';
const CUSTOM_THEMES_KEY = 'dashboard-custom-themes';
const HIDDEN_THEMES_KEY = 'dashboard-hidden-themes';

function applyThemeVars(vars){
  const root = document.documentElement.style;
  for (const [k, v] of Object.entries(vars)) root.setProperty(k, v);
}

function loadCustomThemes(){
  try { return JSON.parse(localStorage.getItem(CUSTOM_THEMES_KEY) || '{}'); } catch { return {}; }
}
function saveCustomThemes(themes){
  localStorage.setItem(CUSTOM_THEMES_KEY, JSON.stringify(themes));
}
function saveCustomTheme(key, label, vars){
  const themes = loadCustomThemes();
  themes[key] = { label, vars };
  saveCustomThemes(themes);
}
function deleteCustomTheme(key){
  const themes = loadCustomThemes();
  delete themes[key];
  saveCustomThemes(themes);
  setThemeHidden('custom:' + key, false); // don't leave an orphaned hidden-list entry behind
}

// Hiding applies to built-ins and custom themes alike - a preset can't be
// deleted (it's code, not data), but it can be kept out of the picker.
function loadHiddenThemes(){
  try { return new Set(JSON.parse(localStorage.getItem(HIDDEN_THEMES_KEY) || '[]')); } catch { return new Set(); }
}
function setThemeHidden(themeKey, hidden){
  const hidden_set = loadHiddenThemes();
  if (hidden) hidden_set.add(themeKey); else hidden_set.delete(themeKey);
  localStorage.setItem(HIDDEN_THEMES_KEY, JSON.stringify([...hidden_set]));
}
function isThemeHidden(themeKey){
  return loadHiddenThemes().has(themeKey);
}

// Every theme (built-in + custom) as one flat, uniformly-shaped list -
// {key, label, vars, isCustom, hidden} - so callers (the picker, the
// Settings > Theme list) don't need to know the built-in/custom split.
function listAllThemes(){
  const hidden = loadHiddenThemes();
  const builtins = Object.entries(THEME_PRESETS).map(([key, t]) => ({
    key, label: t.label, vars: t.vars, isCustom: false, hidden: hidden.has(key),
  }));
  const customs = Object.entries(loadCustomThemes()).map(([key, t]) => ({
    key: 'custom:' + key, label: t.label, vars: t.vars, isCustom: true, hidden: hidden.has('custom:' + key),
  }));
  return [...builtins, ...customs];
}

function themeVarsForKey(themeKey){
  if (themeKey.startsWith('custom:')){
    const t = loadCustomThemes()[themeKey.slice(7)];
    return t ? t.vars : null;
  }
  return THEME_PRESETS[themeKey] ? THEME_PRESETS[themeKey].vars : null;
}

// theme-select is index.html-only (settings.html has no picker yet), so
// this only touches it when present rather than assuming it exists.
function applyTheme(themeKey){
  let vars = themeVarsForKey(themeKey);
  if (!vars){ themeKey = 'midnight'; vars = THEME_PRESETS.midnight.vars; }
  applyThemeVars(vars);
  localStorage.setItem(THEME_KEY, themeKey);
  const sel = document.getElementById('theme-select');
  if (sel) sel.value = themeKey;
}

function applySavedTheme(){
  applyTheme(localStorage.getItem(THEME_KEY) || 'midnight');
}

applySavedTheme();
