'use strict';

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

