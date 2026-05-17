'use strict';

/* ======================================================================
   SSH Deployer — renderer logic
   ==================================================================== */

const $ = (id) => document.getElementById(id);
const backend = window.api;

const ENV_COLORS = [
  '#ff8c42', '#4aa3ff', '#3ecf8e', '#a78bfa',
  '#f472b6', '#2dd4bf', '#f5b042', '#ff6b6b',
];

const state = {
  // environments + per-environment cached sessions
  environments: [],
  sessions: {}, // id -> { node, hosts, selected:Set, proxmoxConn, ready }
  activeEnvId: null, // env shown in the workspace
  editingId: null, // env id open in the editor ('' = new, null = editor closed)
  view: 'editor', // 'editor' | 'workspace'
  formColor: ENV_COLORS[0],

  // flat working state — mirrors the ACTIVE environment's session
  connected: false,
  node: '',
  hosts: [],
  selected: new Set(),
  proxmoxConn: null,

  // global
  key: { valid: false },
  filter: 'all',
  search: '',
  runningOnly: false,
  cxAuth: 'password',
  dcAuth: 'password',
  cxKeyPath: '',
  dcKeyPath: '',
  deploying: false,
  verifying: false,
  verifyKeyPath: '',
  resolving: null,
  deployMode: 'proxmox',
  history: [],
  auditing: false,
  removing: false,
  audit: null,
};

const currentEnv = () =>
  state.environments.find((e) => e.id === state.activeEnvId) || null;

/* ---------- view switching ---------- */
function setView(v) {
  state.view = v;
  $('view-connect').classList.toggle('hidden', v !== 'editor');
  $('view-main').classList.toggle('hidden', v !== 'workspace');
}

/* ---------- segmented controls ---------- */
function wireSeg(segId, onChange) {
  const seg = document.querySelector(`.seg[data-seg="${segId}"]`);
  seg.querySelectorAll('.seg-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      seg.querySelectorAll('.seg-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      onChange(btn.dataset.auth);
    });
  });
}
function setSeg(segId, value) {
  document.querySelectorAll(`.seg[data-seg="${segId}"] .seg-btn`).forEach((b) =>
    b.classList.toggle('active', b.dataset.auth === value)
  );
}
function applyCxAuth(auth) {
  state.cxAuth = auth;
  $('cx-pass-row').classList.toggle('hidden', auth !== 'password');
  $('cx-key-row').classList.toggle('hidden', auth !== 'key');
}
function applyDcAuth(auth) {
  state.dcAuth = auth;
  $('dc-pass-row').classList.toggle('hidden', auth !== 'password');
  $('dc-key-row').classList.toggle('hidden', auth !== 'key');
}
function applyMode(mode) {
  state.deployMode = mode;
  $('mode-proxmox').classList.toggle('hidden', mode !== 'proxmox');
  $('mode-direct').classList.toggle('hidden', mode !== 'direct');
  updateDeployBar();
}

/* ======================================================================
   ENVIRONMENT TABS
   ==================================================================== */
function renderTabs() {
  $('tab-list').innerHTML = state.environments
    .map((e) => {
      const active = state.view === 'workspace' && state.activeEnvId === e.id;
      const editing = state.view === 'editor' && state.editingId === e.id;
      const live = state.sessions[e.id] && state.sessions[e.id].ready;
      return `<div class="tab${active ? ' active' : ''}${
        editing ? ' editing' : ''
      }" data-id="${e.id}" data-color="${escapeAttr(e.color)}" title="${escapeAttr(e.name)}">
        <span class="tab-dot${live ? ' live' : ''}"></span>
        <span class="tab-name">${escapeHtml(e.name)}</span>
        <button class="tab-edit" data-act="edit" title="Edit environment">✎</button>
      </div>`;
    })
    .join('');
  $('tab-list')
    .querySelectorAll('.tab')
    .forEach((el) => el.style.setProperty('--env', el.dataset.color));
  $('tab-new').classList.toggle(
    'active',
    state.view === 'editor' && state.editingId === ''
  );
}

const connecting = new Set();

function clickTab(id) {
  if (state.deploying) return;
  if (state.view === 'workspace' && state.activeEnvId === id) return;
  const sess = state.sessions[id];
  if (sess && sess.ready) {
    switchToSession(id);
    return;
  }
  if (connecting.has(id)) {
    // a background connect is already running — just bring its view forward
    const env = state.environments.find((e) => e.id === id);
    state.activeEnvId = id;
    state.connected = false;
    state.editingId = null;
    setView('workspace');
    renderTabs();
    showLoading('Connecting to ' + (env ? env.name : '') + '…');
    return;
  }
  connectEnv(id);
}

/* ---------- per-environment sessions ---------- */
function saveActiveSession() {
  const id = state.activeEnvId;
  if (id && state.sessions[id] && state.sessions[id].ready) {
    state.sessions[id] = {
      node: state.node,
      hosts: state.hosts,
      selected: state.selected,
      proxmoxConn: state.proxmoxConn,
      ready: true,
    };
  }
}

function activateSession(id) {
  const s = state.sessions[id];
  state.activeEnvId = id;
  state.node = s.node;
  state.hosts = s.hosts;
  state.selected = s.selected;
  state.proxmoxConn = s.proxmoxConn;
  state.connected = true;
}

function switchToSession(id) {
  cancelResolution();
  saveActiveSession();
  activateSession(id);
  state.editingId = null;
  hideLoading();
  setView('workspace');
  renderTabs();
  renderWorkspace();
  resolveGuestAddresses(); // resume IP resolution for any unresolved guests
}

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

/* ======================================================================
   WORKSPACE
   ==================================================================== */
function renderWorkspace() {
  const env = currentEnv();
  $('conn-node').textContent = state.node;
  const color = env ? env.color : 'var(--ok)';
  $('conn-pill').style.setProperty('--env', color);
  renderHosts();
  updateDeployBar();
}

async function refreshHosts() {
  if (!state.proxmoxConn) return;
  cancelResolution();
  $('btn-refresh').disabled = true;
  $('btn-refresh').textContent = 'Refreshing…';
  const res = await backend.connect(state.proxmoxConn);
  $('btn-refresh').disabled = false;
  $('btn-refresh').textContent = 'Refresh';
  if (!res.ok) {
    alert('Refresh failed: ' + res.error);
    return;
  }
  const prev = new Map(state.hosts.map((h) => [h.id, h.address]));
  res.hosts.forEach((h) => {
    if (!h.address && prev.get(h.id)) h.address = prev.get(h.id);
  });
  state.hosts = res.hosts;
  state.node = res.node;
  for (const id of [...state.selected]) {
    if (!state.hosts.some((h) => h.id === id)) state.selected.delete(id);
  }
  saveActiveSession();
  renderWorkspace();
  resolveGuestAddresses();
}

function disconnect() {
  const id = state.activeEnvId;
  cancelResolution();
  if (id) delete state.sessions[id];
  state.connected = false;
  if (id) openEditor(id);
  else goHome();
}

/* ---------- background guest-IP resolution ---------- */
let addrDetach = null;
let resolveGen = 0;

function cancelResolution() {
  resolveGen++;
  if (addrDetach) {
    addrDetach();
    addrDetach = null;
  }
  state.hosts.forEach((h) => (h.resolving = false));
  state.resolving = null;
}

function updateHostCount() {
  let txt = `${state.hosts.length} host${state.hosts.length === 1 ? '' : 's'}`;
  if (state.resolving && state.resolving.done < state.resolving.total) {
    txt += ` · resolving IPs ${state.resolving.done}/${state.resolving.total}`;
  }
  $('host-count').textContent = txt;
}

async function resolveGuestAddresses() {
  const gen = ++resolveGen;
  if (addrDetach) {
    addrDetach();
    addrDetach = null;
  }

  // every running guest, and the ones still awaiting a resolution attempt
  const allGuests = state.hosts.filter(
    (h) => h.kind !== 'node' && h.status === 'running'
  );
  const guests = allGuests.filter((h) => !h.address && !h.resolved);
  if (!guests.length) {
    state.resolving = null;
    updateHostCount();
    return;
  }

  guests.forEach((g) => (g.resolving = true));
  // count already-resolved guests so the progress carries on rather than restarting
  state.resolving = {
    total: allGuests.length,
    done: allGuests.length - guests.length,
  };
  renderHosts();

  addrDetach = backend.onAddressProgress((upd) => {
    if (gen !== resolveGen) return;
    const host = state.hosts.find((h) => h.id === upd.id);
    if (!host) return;
    host.resolving = false;
    host.resolved = true; // attempted — don't re-resolve when switching tabs
    if (upd.address && !host.address) host.address = upd.address;
    if (state.resolving) state.resolving.done++;
    applyAddressUpdate(host);
    updateHostCount();
    updateDeployBar();
  });

  try {
    await backend.resolveAddresses({
      conn: state.proxmoxConn,
      guests: guests.map((g) => ({
        id: g.id,
        kind: g.kind,
        node: g.node,
        vmid: g.vmid,
      })),
    });
  } catch {
    /* leave unresolved hosts for manual entry */
  }

  if (gen !== resolveGen) return;
  if (addrDetach) {
    addrDetach();
    addrDetach = null;
  }
  state.hosts.forEach((h) => (h.resolving = false));
  state.resolving = null;
  renderHosts();
  updateDeployBar();
}

function applyAddressUpdate(host) {
  const row = document.querySelector(`.host-row[data-id="${host.id}"]`);
  if (!row) return;
  const input = row.querySelector('.host-addr');
  if (!input) return;
  input.classList.remove('resolving');
  if (input.value) return;
  if (host.address) {
    input.value = host.address;
    input.classList.remove('empty');
  } else {
    input.classList.add('empty');
    input.placeholder = 'IP / hostname';
  }
}

/* ---------- host list ---------- */
const KIND_LABEL = { node: 'Node', qemu: 'VM', lxc: 'LXC' };
const KIND_GLYPH = { node: '▢', qemu: '◈', lxc: '▣' };

const VERIFY = {
  ok: { glyph: '✓', cls: 'ok', title: 'Key works — login succeeded' },
  rejected: { glyph: '✕', cls: 'rejected', title: 'Key rejected by the host' },
  unreachable: { glyph: '!', cls: 'unreachable', title: 'Host unreachable' },
};

function verifyIconHtml(h) {
  if (h.verify === 'running') {
    return '<div class="host-verify running"><span class="spinner"></span></div>';
  }
  const v = VERIFY[h.verify];
  if (v) {
    return `<div class="host-verify ${v.cls}" title="${escapeAttr(
      h.verifyMsg || v.title
    )}">${v.glyph}</div>`;
  }
  return '<div class="host-verify" title="Not verified — click to test"></div>';
}

function visibleHosts() {
  const q = state.search.toLowerCase();
  return state.hosts.filter((h) => {
    if (state.filter !== 'all' && h.kind !== state.filter) return false;
    if (state.runningOnly && !['running', 'online'].includes(h.status)) return false;
    if (q) {
      const hay = `${h.name} ${h.address} ${h.vmid || ''} ${h.node}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

function updateSelectAllLabel() {
  const visible = visibleHosts();
  const all =
    visible.length > 0 && visible.every((h) => state.selected.has(h.id));
  $('host-selectall').textContent = all ? 'Unselect all' : 'Select all';
}

function renderHosts() {
  const list = $('host-list');
  const hosts = visibleHosts();

  updateHostCount();
  updateSelectAllLabel();
  $('host-empty').classList.toggle('hidden', hosts.length > 0);

  const groups = new Map();
  for (const h of hosts) {
    if (!groups.has(h.node)) groups.set(h.node, []);
    groups.get(h.node).push(h);
  }

  list.innerHTML = '';
  for (const [node, items] of [...groups.entries()].sort()) {
    items.sort((a, b) => {
      if (a.kind === 'node') return -1;
      if (b.kind === 'node') return 1;
      return a.name.localeCompare(b.name);
    });
    const group = document.createElement('div');
    group.className = 'host-group';
    const head = document.createElement('div');
    head.className = 'host-group-head';
    head.innerHTML = `<span>${escapeHtml(node)}</span>
      <span class="gcount">· ${items.length}</span>`;
    group.appendChild(head);
    for (const h of items) group.appendChild(hostRow(h));
    list.appendChild(group);
  }
}

function hostRow(h) {
  const row = document.createElement('div');
  row.className = 'host-row' + (state.selected.has(h.id) ? ' selected' : '');
  row.dataset.id = h.id;

  const checked = state.selected.has(h.id) ? 'checked' : '';
  const meta =
    h.kind === 'node'
      ? `Proxmox node · ${h.status}`
      : `${KIND_LABEL[h.kind]} ${h.vmid} · ${h.status}`;
  const addrState = h.address ? '' : h.resolving ? 'resolving' : 'empty';
  const addrPlaceholder =
    h.resolving && !h.address ? 'resolving…' : 'IP / hostname';

  row.innerHTML = `
    <input type="checkbox" ${checked} />
    <div class="host-icon ${h.kind}">${KIND_GLYPH[h.kind]}</div>
    <div class="host-main">
      <div class="host-name">
        <span class="name-text">${escapeHtml(h.name)}</span>
        <span class="badge ${h.kind}">${KIND_LABEL[h.kind]}</span>
        <span class="status-dot ${h.status}"></span>
      </div>
      <div class="host-meta">${escapeHtml(meta)}</div>
    </div>
    <input class="host-addr ${addrState}" type="text"
      value="${escapeAttr(h.address)}" placeholder="${escapeAttr(addrPlaceholder)}" />
    ${verifyIconHtml(h)}
  `;

  const checkbox = row.querySelector('input[type="checkbox"]');
  const addr = row.querySelector('.host-addr');

  const toggle = () => {
    if (state.selected.has(h.id)) state.selected.delete(h.id);
    else state.selected.add(h.id);
    checkbox.checked = state.selected.has(h.id);
    row.classList.toggle('selected', state.selected.has(h.id));
    updateDeployBar();
  };

  row.addEventListener('click', (e) => {
    if (e.target === addr || e.target === checkbox) return;
    if (e.target.closest('.host-verify')) return;
    toggle();
  });
  checkbox.addEventListener('click', (e) => {
    e.stopPropagation();
    toggle();
  });
  addr.addEventListener('click', (e) => e.stopPropagation());
  addr.addEventListener('input', () => {
    h.address = addr.value.trim();
    addr.classList.toggle('empty', !h.address);
    updateDeployBar();
  });

  return row;
}

/* ---------- key verification ---------- */
function applyVerifyIcon(host) {
  const row = document.querySelector(`.host-row[data-id="${host.id}"]`);
  if (!row) return;
  const slot = row.querySelector('.host-verify');
  if (slot) slot.outerHTML = verifyIconHtml(host);
}

function setVerifyKey(path) {
  state.verifyKeyPath = path || '';
  $('verify-key-name').textContent = path
    ? path.split(/[\\/]/).pop()
    : 'not set';
  $('verify-key-pick').textContent = path ? 'Change' : 'Choose…';
}

async function verifyHosts(hosts) {
  if (!hosts.length || state.verifying) return;

  if (!state.verifyKeyPath) {
    const r = await backend.pickKey();
    if (!r) return;
    setVerifyKey(r.path);
  }

  state.verifying = true;
  $('btn-verify').textContent = 'Verifying…';
  updateDeployBar();
  hosts.forEach((h) => {
    h.verify = 'running';
    h.verifyMsg = '';
    applyVerifyIcon(h);
  });

  const detach = backend.onVerifyProgress((msg) => {
    const host = state.hosts.find((h) => h.id === msg.id);
    if (!host) return;
    host.verify = msg.status;
    if (msg.status !== 'running') host.verifyMsg = msg.message || '';
    applyVerifyIcon(host);
  });

  const direct = state.deployMode === 'direct';
  const creds = direct ? deployCreds() : {};
  const username = direct ? creds.username || 'root' : 'root';
  const port = direct ? creds.port || 22 : 22;

  const res = await backend.verify({
    privateKeyPath: state.verifyKeyPath,
    hosts: hosts.map((h) => ({ id: h.id, address: h.address, username, port })),
  });

  detach();
  state.verifying = false;
  $('btn-verify').textContent = 'Verify key';

  // Apply the authoritative results — a dot must never be left spinning,
  // even if a streamed progress event was missed.
  const byId = {};
  if (res && Array.isArray(res.results)) {
    for (const r of res.results) byId[r.id] = r;
  }
  hosts.forEach((h) => {
    const r = byId[h.id];
    if (r) {
      h.verify = r.status;
      h.verifyMsg = r.message || '';
    } else if (h.verify === 'running') {
      h.verify = 'unreachable';
      h.verifyMsg = (res && res.error) || 'No result was returned';
    }
    applyVerifyIcon(h);
  });
  updateDeployBar();

  if (res && res.error) alert('Verification failed: ' + res.error);
}

/* ======================================================================
   KEY AUDIT  ·  read & remove keys across hosts
   ==================================================================== */
function auditPayload(hosts) {
  const hostList = hosts.map((h) => ({
    id: h.id,
    kind: h.kind,
    node: h.node,
    vmid: h.vmid,
    address: h.address,
    name: h.name,
  }));
  if (state.deployMode === 'proxmox') {
    const nodeIps = {};
    for (const h of state.hosts) {
      if (h.kind === 'node' && h.address) nodeIps[h.node] = h.address;
    }
    return {
      mode: 'proxmox',
      hosts: hostList,
      proxmoxConn: state.proxmoxConn,
      connectedNode: state.node,
      nodeIps,
    };
  }
  return { mode: 'direct', hosts: hostList, creds: deployCreds() };
}

async function auditHostList(hosts) {
  if (!hosts.length || state.auditing || state.removing) return;
  state.auditing = true;
  updateDeployBar();
  $('btn-audit').textContent = 'Auditing…';
  $('audit-title').textContent = 'Key Audit';
  $('audit-progress').textContent = `0 / ${hosts.length}`;
  $('audit-body').innerHTML =
    '<div class="audit-loading"><span class="spinner"></span><span>Reading ' +
    `authorized_keys from ${hosts.length} host${
      hosts.length === 1 ? '' : 's'
    }…</span></div>`;
  $('audit-overlay').classList.remove('hidden');

  let done = 0;
  const detach = backend.onAuditProgress((msg) => {
    if (msg && msg.status && msg.status !== 'running') {
      done++;
      $('audit-progress').textContent = `${done} / ${hosts.length}`;
    }
  });

  let res;
  try {
    res = await backend.audit(auditPayload(hosts));
  } catch (err) {
    res = { error: (err && err.message) || String(err) };
  }
  detach();

  state.auditing = false;
  $('btn-audit').textContent = 'Audit keys';
  updateDeployBar();
  renderAuditResults(hosts, res);
}

function renderAuditResults(hosts, res) {
  const hostById = {};
  hosts.forEach((h) => (hostById[h.id] = h));

  const keyMap = {};
  const order = [];
  const errored = [];

  for (const r of (res && res.results) || []) {
    if (r.status === 'ok') {
      for (const k of r.keys || []) {
        if (!keyMap[k.b64]) {
          keyMap[k.b64] = { info: k, hostIds: [] };
          order.push(k.b64);
        }
        keyMap[k.b64].hostIds.push(r.id);
      }
    } else {
      errored.push(r.id);
    }
  }
  order.sort((a, b) => keyMap[b].hostIds.length - keyMap[a].hostIds.length);

  state.audit = {
    auditedHosts: hosts,
    keyMap,
    order,
    errored,
    hostById,
    total: hosts.length,
  };
  $('audit-progress').textContent =
    res && res.error
      ? 'error'
      : `${hosts.length - errored.length} / ${hosts.length} read`;
  drawAuditBody();
}

/** A host chip that always carries the VMID, so same-named guests are distinct. */
function auditHostChip(host, id) {
  if (!host) return `<span class="audit-host">${escapeHtml(id)}</span>`;
  const tag = host.kind === 'node' ? '' : ` · ${host.vmid}`;
  const title =
    host.kind === 'node'
      ? `Proxmox node ${host.name}`
      : `${KIND_LABEL[host.kind] || host.kind} ${host.vmid} · on ${host.node}`;
  return `<span class="audit-host" title="${escapeAttr(title)}">${escapeHtml(
    host.name
  )}${escapeHtml(tag)}</span>`;
}

function drawAuditBody() {
  const a = state.audit;
  const body = $('audit-body');
  if (!a || (!a.order.length && !a.errored.length)) {
    body.innerHTML =
      '<div class="empty-state audit-empty">No authorized keys found ' +
      'on the selected hosts.</div>';
    return;
  }

  const ok = a.total - a.errored.length;
  let html =
    `<div class="audit-summary">${a.order.length} distinct key` +
    `${a.order.length === 1 ? '' : 's'} across ${ok} host${ok === 1 ? '' : 's'}` +
    `${a.errored.length ? ' · ' + a.errored.length + ' unreadable' : ''}</div>`;

  for (const b64 of a.order) {
    const e = a.keyMap[b64];
    const k = e.info;
    const isCurrent = !!(state.key && state.key.valid && state.key.b64 === b64);
    const hostChips = e.hostIds
      .map((id) => auditHostChip(a.hostById[id], id))
      .join('');
    html += `<div class="audit-key${isCurrent ? ' is-current' : ''}">
      <div class="audit-key-head">
        <div class="key-chips">
          <span class="chip chip-ok">${escapeHtml(k.label)}</span>
          ${k.comment ? `<span class="chip">${escapeHtml(k.comment)}</span>` : ''}
          <span class="chip chip-fp">${escapeHtml(k.fingerprint)}</span>
          ${isCurrent ? '<span class="chip chip-current">your current key</span>' : ''}
        </div>
        <div class="audit-actions">
          <button class="audit-use" data-b64="${escapeAttr(b64)}">Use</button>
          <button class="audit-remove" data-b64="${escapeAttr(b64)}">Remove…</button>
        </div>
      </div>
      <div class="audit-key-hosts">
        <span class="audit-count">on ${e.hostIds.length} / ${a.total}</span>
        ${hostChips}
      </div>
    </div>`;
  }

  if (a.errored.length) {
    html +=
      `<div class="audit-errors">Couldn't read ${a.errored.length} host` +
      `${a.errored.length === 1 ? '' : 's'}: ` +
      a.errored
        .map((id) => auditHostChip(a.hostById[id], id))
        .join('') +
      '</div>';
  }
  body.innerHTML = html;
}

/** Load an audited key into the deploy key field so it can be rolled out elsewhere. */
function useAuditKey(b64) {
  const a = state.audit;
  if (!a || !a.keyMap[b64]) return;
  const k = a.keyMap[b64].info;
  $('key-input').value =
    `${k.type} ${k.b64}${k.comment ? ' ' + k.comment : ''}`;
  parseKeyNow();
  $('audit-overlay').classList.add('hidden');
}

async function removeAuditKey(b64) {
  const a = state.audit;
  if (!a || !a.keyMap[b64] || state.auditing || state.removing) return;

  const entry = a.keyMap[b64];
  const hosts = a.auditedHosts.filter((h) => entry.hostIds.includes(h.id));
  const label = entry.info.comment || entry.info.fingerprint;
  if (
    !confirm(
      `Remove this key from ${hosts.length} host${
        hosts.length === 1 ? '' : 's'
      }?\n\n${label}\n\nIt will be deleted from authorized_keys — ` +
        'this cannot be undone.'
    )
  ) {
    return;
  }

  state.removing = true;
  updateDeployBar();
  $('audit-progress').textContent = 'removing…';
  $('audit-body').innerHTML =
    '<div class="audit-loading"><span class="spinner"></span><span>Removing ' +
    `key from ${hosts.length} host${hosts.length === 1 ? '' : 's'}…</span></div>`;

  const detach = backend.onRemoveProgress(() => {});
  let res;
  try {
    res = await backend.removeKey({ ...auditPayload(hosts), keyB64: b64 });
  } catch (err) {
    res = { error: (err && err.message) || String(err) };
  }
  detach();
  state.removing = false;

  if (res && res.error) alert('Removal failed: ' + res.error);

  // re-audit the original host set so the view reflects the change
  auditHostList(a.auditedHosts);
}

/* ======================================================================
   SSH KEY parsing
   ==================================================================== */
let keyTimer = null;
function onKeyInput() {
  clearTimeout(keyTimer);
  keyTimer = setTimeout(parseKeyNow, 220);
}

async function loadPublicKeyFile() {
  const r = await backend.pickPublicKey();
  if (!r) return;
  if (r.error) {
    alert('Could not read the file: ' + r.error);
    return;
  }
  $('key-input').value = (r.content || '').trim();
  if (r.privateKeyPath) setVerifyKey(r.privateKeyPath);
  parseKeyNow();
}

async function parseKeyNow() {
  const text = $('key-input').value;
  const box = $('key-status');
  if (!text.trim()) {
    state.key = { valid: false };
    box.innerHTML = '';
    updateDeployBar();
    return;
  }
  const res = await backend.parseKey(text);
  state.key = res;
  if (res.valid) {
    box.innerHTML = `<div class="key-chips">
      <span class="chip chip-ok">✓ ${escapeHtml(res.label)}</span>
      ${res.comment ? `<span class="chip">${escapeHtml(res.comment)}</span>` : ''}
      <span class="chip chip-fp">${escapeHtml(res.fingerprint)}</span>
    </div>`;
  } else {
    box.innerHTML = `<div class="key-error">✕ ${escapeHtml(res.error)}</div>`;
  }
  updateDeployBar();
}

/* ======================================================================
   DEPLOY
   ==================================================================== */
function deployCreds() {
  if ($('dc-same').checked) return { ...state.proxmoxConn };
  return {
    port: $('dc-port').value || 22,
    username: $('dc-user').value.trim() || 'root',
    authType: state.dcAuth,
    password: $('dc-pass').value,
    privateKeyPath: state.dcKeyPath,
    passphrase: $('dc-passphrase').value,
  };
}

function updateDeployBar() {
  updateSelectAllLabel();
  const sel = selectedHosts();
  const summary = $('deploy-summary');
  const needAddr = state.deployMode === 'direct';
  const missingAddr = needAddr ? sel.filter((h) => !h.address).length : 0;

  const visibleIds = new Set(visibleHosts().map((h) => h.id));
  const hidden = sel.filter((h) => !visibleIds.has(h.id)).length;

  let txt;
  if (sel.length === 0) {
    txt = 'Select one or more hosts to deploy to.';
  } else {
    txt = `<strong>${sel.length}</strong> host${sel.length === 1 ? '' : 's'} selected`;
    if (hidden > 0) {
      txt += ` · <span class="reveal-hidden">${hidden} hidden by filter</span>`;
    }
    if (!state.key.valid) txt += ' · <span class="warn">key not valid</span>';
    else if (missingAddr) {
      txt += ` · <span class="warn">${missingAddr} missing an address</span>`;
    }
  }
  summary.innerHTML = txt;

  $('btn-deploy').disabled =
    state.deploying || sel.length === 0 || !state.key.valid || missingAddr > 0;
  $('btn-verify').disabled = state.verifying || sel.length === 0;
  // Audit works on the whole cluster when nothing is selected.
  $('btn-audit').disabled =
    state.auditing || state.removing || state.hosts.length === 0;
}

function selectedHosts() {
  return state.hosts.filter((h) => state.selected.has(h.id));
}

function revealSelected() {
  state.search = '';
  state.filter = 'all';
  state.runningOnly = false;
  $('host-search').value = '';
  $('host-running').checked = false;
  document.querySelectorAll('#host-filters .seg-btn').forEach((b) =>
    b.classList.toggle('active', b.dataset.filter === 'all')
  );
  renderHosts();
  updateDeployBar();
}

async function doDeploy() {
  const hosts = selectedHosts();
  if (!hosts.length || !state.key.valid) return;

  state.deploying = true;
  setBusy('btn-deploy', true);
  openOverlay(hosts);

  const detach = backend.onDeployProgress((msg) => updateOverlayRow(msg));

  const hostPayload = hosts.map((h) => ({
    id: h.id,
    kind: h.kind,
    node: h.node,
    vmid: h.vmid,
    name: h.name,
    address: h.address,
  }));

  let res;
  if (state.deployMode === 'proxmox') {
    const nodeIps = {};
    for (const h of state.hosts) {
      if (h.kind === 'node' && h.address) nodeIps[h.node] = h.address;
    }
    res = await backend.deploy({
      mode: 'proxmox',
      hosts: hostPayload,
      publicKey: state.key.normalized,
      proxmoxConn: state.proxmoxConn,
      connectedNode: state.node,
      nodeIps,
    });
  } else {
    res = await backend.deploy({
      mode: 'direct',
      hosts: hostPayload,
      publicKey: state.key.normalized,
      creds: deployCreds(),
    });
  }

  detach();
  state.deploying = false;
  setBusy('btn-deploy', false);

  if (res && res.error) $('ov-title').textContent = 'Deployment error';

  if (res && Array.isArray(res.results)) {
    // Apply the authoritative results so no overlay row is left spinning.
    for (const r of res.results) updateOverlayRow(r);
    recordHistory(hosts, res.results);
    for (const r of res.results) {
      if (r.status === 'added' || r.status === 'skipped') {
        state.selected.delete(r.id);
      }
    }
    renderHosts();
  } else {
    // Whole deployment failed before per-host results — fail every row.
    for (const id of Object.keys(ovRows)) {
      updateOverlayRow({
        id,
        status: 'failed',
        message: (res && res.error) || 'Deployment failed',
      });
    }
  }
  finishOverlay();
  updateDeployBar();
}

/* ---------- results overlay ---------- */
let ovRows = {};
let ovTotal = 0;

function openOverlay(hosts) {
  ovRows = {};
  ovTotal = hosts.length;
  $('ov-title').textContent = 'Deploying…';
  $('btn-ov-close').disabled = true;
  $('ov-progress').textContent = `0 / ${ovTotal}`;

  const list = $('ov-list');
  list.innerHTML = '';
  for (const h of hosts) {
    const row = document.createElement('div');
    row.className = 'ov-row';
    row.innerHTML = `
      <div class="ov-icon running"><span class="spinner"></span></div>
      <div class="ov-info">
        <div class="ov-host">${escapeHtml(h.name)}</div>
        <div class="ov-msg">${h.address ? escapeHtml(h.address) + ' · ' : ''}waiting…</div>
      </div>`;
    list.appendChild(row);
    ovRows[h.id] = row;
  }
  $('overlay').classList.remove('hidden');
}

const OV_GLYPH = { added: '✓', skipped: '↻', failed: '✕' };

function updateOverlayRow(msg) {
  const row = ovRows[msg.id];
  if (!row) return;
  const icon = row.querySelector('.ov-icon');
  const msgEl = row.querySelector('.ov-msg');

  if (msg.status === 'running') {
    icon.className = 'ov-icon running';
    icon.innerHTML = '<span class="spinner"></span>';
    msgEl.textContent = 'Connecting…';
    return;
  }
  icon.className = 'ov-icon ' + msg.status;
  icon.textContent = OV_GLYPH[msg.status] || '?';
  msgEl.textContent = msg.message || msg.status;

  const done = Object.values(ovRows).filter((r) =>
    r.querySelector('.ov-icon:not(.running)')
  ).length;
  $('ov-progress').textContent = `${done} / ${ovTotal}`;
}

function finishOverlay() {
  const rows = Object.values(ovRows);
  const failed = rows.filter((r) => r.querySelector('.ov-icon.failed')).length;
  const added = rows.filter((r) => r.querySelector('.ov-icon.added')).length;
  const skipped = rows.filter((r) => r.querySelector('.ov-icon.skipped')).length;

  $('ov-title').textContent = failed
    ? `Done — ${failed} failed`
    : 'Deployment complete';
  $('ov-progress').textContent =
    `${added} added · ${skipped} skipped · ${failed} failed`;
  $('btn-ov-close').disabled = false;
}

/* ======================================================================
   DEPLOYMENT HISTORY
   ==================================================================== */
function recordHistory(hosts, results) {
  const byId = {};
  for (const r of results) byId[r.id] = r;

  const counts = { added: 0, skipped: 0, failed: 0 };
  const entryHosts = hosts.map((h) => {
    const r = byId[h.id] || { status: 'failed', message: 'no result' };
    if (counts[r.status] !== undefined) counts[r.status]++;
    return {
      name: h.name,
      kind: h.kind,
      status: r.status,
      message: r.message || '',
    };
  });

  const env = currentEnv();
  backend.addHistory({
    ts: Date.now(),
    mode: state.deployMode,
    proxmoxNode: state.node,
    environment: env ? { name: env.name, color: env.color } : null,
    key: {
      label: state.key.label || 'key',
      comment: state.key.comment || '',
      fingerprint: state.key.fingerprint || '',
    },
    counts,
    hosts: entryHosts,
  });
}

async function openHistory() {
  state.history = (await backend.getHistory()) || [];
  $('history-search').value = '';
  renderHistory('');
  $('history-overlay').classList.remove('hidden');
}

function renderHistory(query) {
  const q = (query || '').trim().toLowerCase();
  const entries = state.history.filter((e) => {
    if (!q) return true;
    const hay = [
      e.key && e.key.fingerprint,
      e.key && e.key.comment,
      e.key && e.key.label,
      e.environment && e.environment.name,
      ...(e.hosts || []).map((h) => h.name),
    ]
      .join(' ')
      .toLowerCase();
    return hay.includes(q);
  });

  const empty = $('history-empty');
  empty.classList.toggle('hidden', entries.length > 0);
  empty.textContent = state.history.length
    ? 'No entries match your filter.'
    : 'No deployments recorded yet.';

  $('history-list').innerHTML = entries.map(historyEntryHtml).join('');
  $('history-list')
    .querySelectorAll('.hist-env')
    .forEach((el) => el.style.setProperty('--env', el.dataset.color));
}

function historyEntryHtml(e) {
  const when = new Date(e.ts).toLocaleString();
  const c = e.counts || { added: 0, skipped: 0, failed: 0 };
  const counts = [
    c.added ? `${c.added} added` : '',
    c.skipped ? `${c.skipped} skipped` : '',
    c.failed ? `${c.failed} failed` : '',
  ]
    .filter(Boolean)
    .join(' · ');
  const key = e.key || {};
  const env = e.environment;
  const hosts = (e.hosts || [])
    .map(
      (h) =>
        `<span class="hist-host ${h.status}">${OV_GLYPH[h.status] || ''} ` +
        `${escapeHtml(h.name)}</span>`
    )
    .join('');
  return `<div class="hist-entry">
    <div class="hist-head">
      ${
        env
          ? `<span class="hist-env" data-color="${escapeAttr(env.color)}">` +
            `<i></i>${escapeHtml(env.name)}</span>`
          : ''
      }
      <span class="hist-time">${escapeHtml(when)}</span>
      <span class="badge ${e.mode === 'direct' ? 'qemu' : 'node'}">${
        e.mode === 'direct' ? 'Direct SSH' : 'Proxmox'
      }</span>
      <span class="hist-counts">${escapeHtml(counts)}</span>
    </div>
    <div class="hist-key">
      <span class="chip chip-ok">${escapeHtml(key.label || 'key')}</span>
      ${key.comment ? `<span class="chip">${escapeHtml(key.comment)}</span>` : ''}
      ${
        key.fingerprint
          ? `<span class="chip chip-fp">${escapeHtml(key.fingerprint)}</span>`
          : ''
      }
    </div>
    <div class="hist-hosts">${hosts}</div>
  </div>`;
}

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

async function init() {
  document.body.classList.add('platform-' + (backend.platform || 'other'));

  // title bar window controls
  $('win-min').addEventListener('click', () => backend.windowControl('minimize'));
  $('win-max').addEventListener('click', () => backend.windowControl('maximize'));
  $('win-close').addEventListener('click', () => backend.windowControl('close'));
  $('win-info').addEventListener('click', openAbout);
  $('about-close').addEventListener('click', () =>
    $('about-overlay').classList.add('hidden')
  );
  $('about-overlay').addEventListener('click', (e) => {
    const link = e.target.closest('.ext-link');
    if (link) backend.openExternal(link.dataset.url);
  });
  $('titlebar').addEventListener('dblclick', (e) => {
    if (!e.target.closest('.tb-controls')) backend.windowControl('maximize');
  });
  backend.onWindowState((isMax) =>
    document.body.classList.toggle('win-maximized', isMax)
  );

  wireSeg('cx', applyCxAuth);
  wireSeg('dc', applyDcAuth);
  wireSeg('mode', applyMode);

  // environment tabs
  $('tab-new').addEventListener('click', () => openEditor(''));
  $('tab-list').addEventListener('click', (e) => {
    const tab = e.target.closest('.tab');
    if (!tab) return;
    const id = tab.dataset.id;
    if (e.target.closest('.tab-edit')) openEditor(id);
    else clickTab(id);
  });

  // editor
  $('cx-colors').addEventListener('click', (e) => {
    const sw = e.target.closest('.swatch');
    if (!sw) return;
    state.formColor = sw.dataset.color;
    renderColorRow();
  });
  $('cx-keybtn').addEventListener('click', () => pickKeyInto('cx'));
  $('cx-connect').addEventListener('click', doConnect);
  $('cx-diagnose').addEventListener('click', () => doDiagnose());
  $('cx-delete').addEventListener('click', deleteEnv);
  ['cx-name', 'cx-host', 'cx-port', 'cx-user', 'cx-pass', 'cx-passphrase'].forEach(
    (id) => {
      $(id).addEventListener('keydown', (e) => {
        if (e.key === 'Enter') doConnect();
      });
    }
  );

  // workspace
  $('dc-keybtn').addEventListener('click', () => pickKeyInto('dc'));
  $('btn-refresh').addEventListener('click', refreshHosts);
  $('btn-disconnect').addEventListener('click', disconnect);
  $('key-input').addEventListener('input', onKeyInput);
  $('key-loadfile').addEventListener('click', loadPublicKeyFile);
  $('dc-same').addEventListener('change', (e) => {
    $('dc-fields').classList.toggle('hidden', e.target.checked);
  });

  document.querySelectorAll('#host-filters .seg-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document
        .querySelectorAll('#host-filters .seg-btn')
        .forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      state.filter = btn.dataset.filter;
      renderHosts();
    });
  });
  $('host-search').addEventListener('input', (e) => {
    state.search = e.target.value;
    renderHosts();
  });
  $('host-running').addEventListener('change', (e) => {
    state.runningOnly = e.target.checked;
    renderHosts();
  });
  $('host-selectall').addEventListener('click', () => {
    const hosts = visibleHosts();
    const allSelected = hosts.every((h) => state.selected.has(h.id));
    hosts.forEach((h) => {
      if (allSelected) state.selected.delete(h.id);
      else state.selected.add(h.id);
    });
    renderHosts();
    updateDeployBar();
  });

  $('btn-deploy').addEventListener('click', doDeploy);
  $('btn-verify').addEventListener('click', () => verifyHosts(selectedHosts()));
  $('btn-audit').addEventListener('click', () => {
    const sel = selectedHosts();
    auditHostList(sel.length ? sel : state.hosts);
  });
  $('audit-close').addEventListener('click', () =>
    $('audit-overlay').classList.add('hidden')
  );
  $('audit-body').addEventListener('click', (e) => {
    const rm = e.target.closest('.audit-remove');
    if (rm) return removeAuditKey(rm.dataset.b64);
    const use = e.target.closest('.audit-use');
    if (use) useAuditKey(use.dataset.b64);
  });
  $('verify-key-pick').addEventListener('click', async () => {
    const r = await backend.pickKey();
    if (r) setVerifyKey(r.path);
  });
  $('host-list').addEventListener('click', (e) => {
    const v = e.target.closest('.host-verify');
    if (!v) return;
    const row = v.closest('.host-row');
    if (!row) return;
    const host = state.hosts.find((h) => h.id === row.dataset.id);
    if (host) verifyHosts([host]);
  });
  $('deploy-summary').addEventListener('click', (e) => {
    if (e.target.closest('.reveal-hidden')) revealSelected();
  });
  $('btn-ov-close').addEventListener('click', () => {
    $('overlay').classList.add('hidden');
  });

  $('btn-history').addEventListener('click', openHistory);
  $('history-close').addEventListener('click', () =>
    $('history-overlay').classList.add('hidden')
  );
  $('history-search').addEventListener('input', (e) =>
    renderHistory(e.target.value)
  );
  $('history-clear').addEventListener('click', async () => {
    if (!state.history.length) return;
    if (confirm('Clear all deployment history?')) {
      await backend.clearHistory();
      state.history = [];
      renderHistory('');
    }
  });

  // load environments — auto-connect to the last one, else open the editor
  const data = await backend.listEnvironments();
  state.environments = data.environments || [];
  renderTabs();
  if (state.environments.length) {
    const last =
      state.environments.find((e) => e.id === data.lastEnvId) ||
      state.environments[0];
    connectEnv(last.id);
  } else {
    openEditor('');
  }
}

init();
