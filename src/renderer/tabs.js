'use strict';

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
      }" draggable="true" data-id="${e.id}" data-color="${escapeAttr(e.color)}" title="${escapeAttr(e.name)}">
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

/* ---------- drag tabs to reorder ---------- */
let draggedTab = null;
let dragStartX = 0;
let dragMoved = false;

function tabBeforeCursor(x) {
  let closest = null;
  let closestOffset = -Infinity;
  for (const tab of $('tab-list').querySelectorAll('.tab:not(.tab-dragging)')) {
    const box = tab.getBoundingClientRect();
    const offset = x - (box.left + box.width / 2);
    if (offset < 0 && offset > closestOffset) {
      closestOffset = offset;
      closest = tab;
    }
  }
  return closest;
}

function wireTabDragging() {
  const list = $('tab-list');
  list.addEventListener('dragstart', (e) => {
    const tab = e.target.closest('.tab');
    if (!tab) return;
    draggedTab = tab;
    dragStartX = e.clientX;
    dragMoved = false;
    tab.classList.add('tab-dragging');
    e.dataTransfer.effectAllowed = 'move';
    try {
      e.dataTransfer.setData('text/plain', tab.dataset.id);
    } catch {
      /* ignore */
    }
  });
  list.addEventListener('dragover', (e) => {
    if (!draggedTab) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';

    // ignore the first few pixels so a click that registers as a tiny
    // drag never nudges the tab order
    if (!dragMoved) {
      if (Math.abs(e.clientX - dragStartX) < 6) return;
      dragMoved = true;
    }

    const before = tabBeforeCursor(e.clientX);
    const willMove = before
      ? draggedTab.nextElementSibling !== before
      : list.lastElementChild !== draggedTab;
    if (!willMove) return;

    // FLIP: note where the other tabs sit, move, then glide them to the new spot
    const others = [...list.querySelectorAll('.tab:not(.tab-dragging)')];
    const firstLeft = new Map(
      others.map((t) => [t, t.getBoundingClientRect().left])
    );

    if (before) list.insertBefore(draggedTab, before);
    else list.appendChild(draggedTab);

    for (const t of others) {
      const dx = firstLeft.get(t) - t.getBoundingClientRect().left;
      if (!dx) continue;
      t.style.transition = 'none';
      t.style.transform = `translateX(${dx}px)`;
      requestAnimationFrame(() => {
        t.style.transition = 'transform .18s ease';
        t.style.transform = '';
      });
    }
  });
  // persist on drop (reliable) with dragend as a fallback — Chromium does not
  // always fire dragend once the dragged element has been moved mid-drag
  const finishDrag = () => {
    if (!draggedTab) return;
    draggedTab.classList.remove('tab-dragging');
    draggedTab = null;
    const ids = [...list.querySelectorAll('.tab')].map((t) => t.dataset.id);
    state.environments.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
    renderTabs();
    backend.reorderEnvironments(ids);
  };
  list.addEventListener('drop', (e) => {
    e.preventDefault();
    finishDrag();
  });
  list.addEventListener('dragend', finishDrag);
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
  backend.setLastEnvironment(id); // remember it as the tab to reopen on launch
  state.editingId = null;
  hideLoading();
  setView('workspace');
  renderTabs();
  renderWorkspace();
  resolveGuestAddresses(); // resume IP resolution for any unresolved guests
}

