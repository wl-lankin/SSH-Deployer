'use strict';

/* ======================================================================
   ENVIRONMENT EDITOR
   ==================================================================== */
function blankEnv() {
  return {
    id: '',
    name: '',
    color: ENV_COLORS[state.environments.length % ENV_COLORS.length],
    host: '',
    port: 22,
    username: 'root',
    authType: 'password',
    password: '',
    passphrase: '',
    privateKeyPath: '',
  };
}

function openEditor(id) {
  cancelResolution();
  state.editingId = id || '';
  const env = id
    ? state.environments.find((e) => e.id === id) || blankEnv()
    : blankEnv();
  fillEditor(env);
  $('cx-form-title').textContent = id ? 'Edit environment' : 'New environment';
  $('cx-delete').classList.toggle('hidden', !id);
  $('cx-diag').classList.add('hidden');
  $('cx-diagnose').textContent = 'Run connection diagnostics';
  showConnectError(null);
  setView('editor');
  renderTabs();
}

function fillEditor(env) {
  $('cx-name').value = env.name || '';
  $('cx-host').value = env.host || '';
  $('cx-port').value = env.port || 22;
  $('cx-user').value = env.username || 'root';
  $('cx-pass').value = env.password || '';
  $('cx-passphrase').value = env.passphrase || '';
  state.formColor = env.color || ENV_COLORS[0];
  state.cxKeyPath = env.privateKeyPath || '';
  $('cx-keyname').textContent = env.privateKeyPath
    ? env.privateKeyPath.split(/[\\/]/).pop()
    : 'No file selected';
  const auth = env.authType === 'key' ? 'key' : 'password';
  setSeg('cx', auth);
  applyCxAuth(auth);
  renderColorRow();
}

function renderColorRow() {
  $('cx-colors').innerHTML = ENV_COLORS.map(
    (c) =>
      `<button type="button" class="swatch${
        c === state.formColor ? ' active' : ''
      }" data-color="${c}" aria-label="${c}"></button>`
  ).join('');
  $('cx-colors')
    .querySelectorAll('.swatch')
    .forEach((el) => el.style.setProperty('--sw', el.dataset.color));
}

function buildEnvFromForm() {
  return {
    id: state.editingId || '',
    name: $('cx-name').value.trim(),
    color: state.formColor,
    host: $('cx-host').value.trim(),
    port: $('cx-port').value || 22,
    username: $('cx-user').value.trim() || 'root',
    authType: state.cxAuth,
    password: $('cx-pass').value,
    privateKeyPath: state.cxKeyPath,
    passphrase: $('cx-passphrase').value,
  };
}

function connFromEnv(env) {
  return {
    host: env.host,
    port: env.port,
    username: env.username,
    authType: env.authType,
    password: env.password,
    privateKeyPath: env.privateKeyPath,
    passphrase: env.passphrase,
  };
}

function buildConn() {
  return {
    host: $('cx-host').value.trim(),
    port: $('cx-port').value || 22,
    username: $('cx-user').value.trim() || 'root',
    authType: state.cxAuth,
    password: $('cx-pass').value,
    privateKeyPath: state.cxKeyPath,
    passphrase: $('cx-passphrase').value,
  };
}

async function deleteEnv() {
  const id = state.editingId;
  if (!id) return;
  const env = state.environments.find((e) => e.id === id);
  if (!confirm(`Delete environment "${env ? env.name : ''}"? This cannot be undone.`)) {
    return;
  }
  await backend.deleteEnvironment(id);
  delete state.sessions[id];
  if (state.activeEnvId === id) {
    state.activeEnvId = null;
    state.connected = false;
  }
  state.environments = (await backend.listEnvironments()).environments;
  goHome();
}

/** Pick a sensible screen after startup / deletion. */
function goHome() {
  const liveId = state.environments
    .map((e) => e.id)
    .find((id) => state.sessions[id] && state.sessions[id].ready);
  if (liveId) {
    activateSession(liveId);
    setView('workspace');
    renderTabs();
    renderWorkspace();
    return;
  }
  openEditor(state.environments.length ? state.environments[0].id : '');
}

