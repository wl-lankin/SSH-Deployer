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

