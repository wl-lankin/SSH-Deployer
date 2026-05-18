'use strict';

/* ======================================================================
   CONNECT
   ==================================================================== */
async function doConnect() {
  const env = buildEnvFromForm();
  if (!env.name) return showConnectError('Give this environment a name.');
  if (!env.host) return showConnectError('Enter the host or IP of a Proxmox node.');
  if (env.authType === 'key' && !env.privateKeyPath) {
    return showConnectError('Choose a private key file.');
  }

  $('cx-diag').classList.add('hidden');
  setBusy('cx-connect', true);
  showConnectError(null);

  const conn = connFromEnv(env);
  const res = await backend.connect(conn);
  setBusy('cx-connect', false);

  if (!res.ok) {
    showConnectError(res.error);
    doDiagnose(conn);
    return;
  }

  // persist the environment (create or update)
  const id = await backend.saveEnvironment(env);
  env.id = id;
  await backend.setLastEnvironment(id);
  state.environments = (await backend.listEnvironments()).environments;

  // build its session and switch to the workspace
  cancelResolution();
  saveActiveSession();
  state.sessions[id] = {
    node: res.node,
    hosts: res.hosts,
    selected: new Set(),
    proxmoxConn: conn,
    ready: true,
  };
  state.editingId = null;
  activateSession(id);
  hideLoading();
  setView('workspace');
  renderTabs();
  renderWorkspace();
  resolveGuestAddresses();
}

/** Connect to a saved environment (clicked tab with no live session). */
async function connectEnv(id) {
  const env = state.environments.find((e) => e.id === id);
  if (!env || connecting.has(id)) return;

  connecting.add(id);
  cancelResolution();
  saveActiveSession();
  state.activeEnvId = id;
  state.connected = false;
  setView('workspace');
  renderTabs();
  showLoading('Connecting to ' + env.name + '…');

  const conn = connFromEnv(env);
  let res;
  try {
    res = await backend.connect(conn);
  } catch (err) {
    res = { ok: false, error: (err && err.message) || String(err) };
  }
  connecting.delete(id);

  if (!res.ok) {
    // surface the failure only if the user is still looking at this tab
    if (state.activeEnvId === id) {
      hideLoading();
      openEditor(id);
      showConnectError(res.error);
      doDiagnose(conn);
    }
    return;
  }

  // cache the session whether or not this tab is still in front — once a
  // connect is started it always finishes, in the background if need be
  state.sessions[id] = {
    node: res.node,
    hosts: res.hosts,
    selected: new Set(),
    proxmoxConn: conn,
    ready: true,
  };
  backend.setLastEnvironment(id);
  renderTabs();

  if (state.activeEnvId === id) {
    activateSession(id);
    hideLoading();
    renderWorkspace();
    resolveGuestAddresses();
  }
  // otherwise: the session is cached; its IPs resolve when the tab is opened
}

function showConnectError(msg) {
  const box = $('cx-error');
  if (!msg) return box.classList.add('hidden');
  box.textContent = msg;
  box.classList.remove('hidden');
}

function setBusy(btnId, busy) {
  const btn = $(btnId);
  btn.disabled = busy;
  btn.querySelector('.btn-label').classList.toggle('hidden', busy);
  btn.querySelector('.spinner').classList.toggle('hidden', !busy);
}

function showLoading(text) {
  $('main-loading-text').textContent = text;
  $('main-loading').classList.remove('hidden');
}
function hideLoading() {
  $('main-loading').classList.add('hidden');
}

/* ---------- connection diagnostics ---------- */
const DIAG_ICON = { ok: '✓', fail: '✕', warn: '!' };

async function doDiagnose(conn) {
  conn = conn || buildConn();
  if (!conn.host) return showConnectError('Enter the host or IP first.');

  const panel = $('cx-diag');
  panel.classList.remove('hidden');
  panel.innerHTML =
    '<div class="diag-running"><span class="spinner"></span>' +
    '<span>Running connection checks…</span></div>';

  const btn = $('cx-diagnose');
  btn.disabled = true;
  btn.textContent = 'Running diagnostics…';

  let steps;
  try {
    steps = await backend.diagnose(conn);
  } catch (err) {
    steps = [{ name: 'Diagnostics', status: 'fail', detail: String(err) }];
  }

  btn.disabled = false;
  btn.textContent = 'Run diagnostics again';
  renderDiag(steps);
}

function renderDiag(steps) {
  $('cx-diag').innerHTML = steps
    .map(
      (s) => `<div class="diag-row ${s.status}">
        <span class="diag-icon">${DIAG_ICON[s.status] || '?'}</span>
        <div>
          <div class="diag-name">${escapeHtml(s.name)}</div>
          <div class="diag-detail">${escapeHtml(s.detail)}</div>
        </div>
      </div>`
    )
    .join('');
}

