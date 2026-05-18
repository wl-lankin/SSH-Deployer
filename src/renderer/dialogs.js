'use strict';

/* ======================================================================
   HELPERS
   ==================================================================== */
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])
  );
}
function escapeAttr(s) {
  return escapeHtml(s).replace(/'/g, '&#39;');
}

async function pickKeyInto(which) {
  const r = await backend.pickKey();
  if (!r) return;
  if (which === 'cx') {
    state.cxKeyPath = r.path;
    $('cx-keyname').textContent = r.name;
  } else {
    state.dcKeyPath = r.path;
    $('dc-keyname').textContent = r.name;
  }
}

/* ======================================================================
   WIRE UP
   ==================================================================== */
async function openAbout() {
  try {
    const info = await backend.getAppInfo();
    $('about-version').textContent = 'v' + (info.version || '?');
    $('about-runtime').textContent =
      `Electron ${info.electron} · Node ${info.node} · Chromium ${info.chrome}`;
  } catch {
    $('about-version').textContent = '';
    $('about-runtime').textContent = '';
  }
  $('about-overlay').classList.remove('hidden');
}

/* ---------------- options dialog ---------------- */
function setUpdateUI(kind, status, sub) {
  $('opt-update-dot').className =
    'opt-update-dot' + (kind && kind !== 'idle' ? ' ' + kind : '');
  $('opt-update-status').textContent = status;
  $('opt-update-sub').textContent = sub || '';
  $('opt-check').disabled = kind === 'checking';
  $('opt-get').classList.toggle('hidden', kind !== 'available');
}

function applyUpdateInfo(r) {
  if (!r) return;
  if (r.error) {
    setUpdateUI('error', "Couldn't check for updates", r.error);
  } else if (r.updateAvailable) {
    setUpdateUI(
      'available',
      'Update available — v' + r.latest,
      'You have v' + r.current + '. Get the new version from GitHub.'
    );
    $('win-options').classList.add('has-update');
  } else {
    setUpdateUI(
      'ok',
      "You're up to date",
      'Version ' + r.current + ' is the latest release.'
    );
    $('win-options').classList.remove('has-update');
  }
}

async function runUpdateCheck() {
  setUpdateUI('checking', 'Checking for updates…', '');
  const r = await backend.checkForUpdate();
  state.updateInfo = r;
  applyUpdateInfo(r);
}

async function openOptions() {
  try {
    const s = await backend.getSettings();
    $('opt-autostart').checked = !!s.autostart;
    $('opt-updatecheck').checked = s.updateCheckOnStartup !== false;
  } catch {
    /* ignore */
  }
  if (state.updateInfo) applyUpdateInfo(state.updateInfo);
  else setUpdateUI('idle', 'Not checked yet', '');
  $('options-overlay').classList.remove('hidden');
}

