'use strict';

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

