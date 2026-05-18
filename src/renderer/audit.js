'use strict';

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

