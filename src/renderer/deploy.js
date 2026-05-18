'use strict';

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

