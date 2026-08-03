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

// Non-color vars, so none of these are in THEME_VAR_KEYS (the color-
// editor loop) - each gets its own control in the theme editor instead.
// Listed here with a fallback because most saved themes (all 6
// built-ins, any custom theme made before these existed) simply don't
// have these keys at all.
const THEME_RADIUS_KEY = '--radius-scale';
const THEME_RADIUS_DEFAULT = '1';
const THEME_CLOCK_KEY = '--clock-type';
const THEME_CLOCK_DEFAULT = 'flap';
const THEME_DATE_KEY = '--date-format';
const THEME_DATE_DEFAULT = 'long';

const THEME_CLOCK_TYPES = [
  { value: 'flap', label: 'Flap (boxed digits)' },
  { value: 'digital', label: 'Digital (plain text)' },
  { value: 'analog', label: 'Analog' },
  { value: 'minimal', label: 'Minimal (24h, no box)' },
];
const THEME_DATE_FORMATS = [
  { value: 'long', label: 'Monday, January 5' },
  { value: 'short', label: 'Mon, Jan 5' },
  { value: 'numeric', label: '01/05/2026' },
  { value: 'iso', label: '2026-01-05' },
];

const THEME_KEY = 'dashboard-theme';
const CUSTOM_THEMES_KEY = 'dashboard-custom-themes';
const HIDDEN_THEMES_KEY = 'dashboard-hidden-themes';

// Every apply sets EVERY known var explicitly (falling back to the
// default for anything the target theme doesn't specify) rather than
// only setting whatever keys happen to be in `vars` - otherwise a value
// from a previous theme (e.g. an edited radius-scale or clock type) would
// silently leak into the next theme applied, since a missing key just
// leaves :root's existing inline override sitting there untouched.
function applyThemeVars(vars){
  const root = document.documentElement.style;
  for (const { key } of THEME_VAR_KEYS) root.setProperty(key, vars[key] || THEME_PRESETS.midnight.vars[key]);
  root.setProperty(THEME_RADIUS_KEY, vars[THEME_RADIUS_KEY] || THEME_RADIUS_DEFAULT);
  root.setProperty(THEME_CLOCK_KEY, vars[THEME_CLOCK_KEY] || THEME_CLOCK_DEFAULT);
  root.setProperty(THEME_DATE_KEY, vars[THEME_DATE_KEY] || THEME_DATE_DEFAULT);
}

// Shared clock/date rendering - used both by the live dashboard clock
// (index.html, on its own 15s timer) and the Settings > Theme editor's
// live preview, so both always agree on what a given clock type/date
// format actually looks like instead of two hand-kept copies drifting.
function renderClockInto(el, clockType, now){
  now = now || new Date();
  if (clockType === 'digital') renderDigitalClockInto(el, now);
  else if (clockType === 'analog') renderAnalogClockInto(el, now);
  else if (clockType === 'minimal') renderMinimalClockInto(el, now);
  else renderFlapClockInto(el, now);
}
function renderFlapClockInto(el, now){
  el.className = 'flap-group';
  const h = String(now.getHours() % 12 || 12).padStart(2, '0');
  const m = String(now.getMinutes()).padStart(2, '0');
  const ampm = now.getHours() >= 12 ? 'PM' : 'AM';
  el.innerHTML = '';
  (h + m).split('').forEach(d => {
    const f = document.createElement('div');
    f.className = 'flap';
    f.textContent = d;
    el.appendChild(f);
  });
  const ampmEl = document.createElement('div');
  ampmEl.className = 'flap';
  ampmEl.style.fontSize = '1.1rem';
  ampmEl.style.color = 'var(--text-dim)';
  ampmEl.textContent = ampm;
  el.appendChild(ampmEl);
}
function renderDigitalClockInto(el, now){
  el.className = 'clock-digital';
  const h = String(now.getHours() % 12 || 12);
  const m = String(now.getMinutes()).padStart(2, '0');
  const ampm = now.getHours() >= 12 ? 'PM' : 'AM';
  el.innerHTML = `${h}:${m}<span class="clock-digital-ampm">${ampm}</span>`;
}
function renderMinimalClockInto(el, now){
  el.className = 'clock-minimal';
  const h = String(now.getHours()).padStart(2, '0');
  const m = String(now.getMinutes()).padStart(2, '0');
  el.textContent = `${h}:${m}`;
}
function renderAnalogClockInto(el, now){
  el.className = 'clock-analog';
  const hours = now.getHours() % 12, minutes = now.getMinutes();
  const minuteDeg = minutes * 6;
  const hourDeg = hours * 30 + minutes * 0.5;
  const ticks = Array.from({ length: 12 }, (_, i) =>
    `<line x1="50" y1="8" x2="50" y2="14" transform="rotate(${i * 30} 50 50)" stroke="var(--text-dim)" stroke-width="2"/>`
  ).join('');
  el.innerHTML = `
    <svg viewBox="0 0 100 100" width="100" height="100">
      <circle cx="50" cy="50" r="46" fill="var(--bg-inset)" stroke="var(--panel-line)" stroke-width="2"/>
      ${ticks}
      <line x1="50" y1="50" x2="50" y2="26" transform="rotate(${hourDeg} 50 50)" stroke="var(--amber)" stroke-width="4" stroke-linecap="round"/>
      <line x1="50" y1="50" x2="50" y2="16" transform="rotate(${minuteDeg} 50 50)" stroke="var(--text)" stroke-width="3" stroke-linecap="round"/>
      <circle cx="50" cy="50" r="3" fill="var(--amber)"/>
    </svg>
  `;
}
function formatDashboardDate(now, format){
  if (format === 'short') return now.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  if (format === 'numeric') return now.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' });
  if (format === 'iso') return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  return now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }); // 'long', the default
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
