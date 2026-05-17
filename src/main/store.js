'use strict';

/**
 * Persistence layer.
 *  - environments.json : non-secret environment records
 *  - env-secrets.bin   : passwords / passphrases, encrypted with the OS keychain
 *  - app-state.json    : misc state (last used environment)
 *  - window.json       : window size / position
 *  - history.json      : deployment history
 */

const { app, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const f = (name) => path.join(app.getPath('userData'), name);

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  } catch {
    /* ignore */
  }
}

/* ---------------- environment secrets ---------------- */
function readSecrets() {
  try {
    const buf = fs.readFileSync(f('env-secrets.bin'));
    if (safeStorage.isEncryptionAvailable()) {
      return JSON.parse(safeStorage.decryptString(buf)) || {};
    }
  } catch {
    /* none stored */
  }
  return {};
}

function writeSecrets(map) {
  try {
    if (safeStorage.isEncryptionAvailable()) {
      fs.writeFileSync(
        f('env-secrets.bin'),
        safeStorage.encryptString(JSON.stringify(map || {}))
      );
    }
  } catch {
    /* ignore */
  }
}

/* ---------------- environments ---------------- */
function readEnvList() {
  const data = readJson(f('environments.json'), []);
  return Array.isArray(data) ? data : [];
}

function listEnvironments() {
  const secrets = readSecrets();
  const environments = readEnvList().map((e) => ({
    ...e,
    password: (secrets[e.id] && secrets[e.id].password) || '',
    passphrase: (secrets[e.id] && secrets[e.id].passphrase) || '',
  }));
  const appState = readJson(f('app-state.json'), {});
  return { environments, lastEnvId: appState.lastEnvId || '' };
}

function saveEnvironment(env) {
  const list = readEnvList();
  const id = env.id || 'env_' + crypto.randomBytes(6).toString('hex');

  const record = {
    id,
    name: (env.name || 'Untitled').trim(),
    color: env.color || '#ff8c42',
    host: (env.host || '').trim(),
    port: Number(env.port) || 22,
    username: (env.username || 'root').trim(),
    authType: env.authType === 'key' ? 'key' : 'password',
    privateKeyPath: env.privateKeyPath || '',
  };

  const idx = list.findIndex((e) => e.id === id);
  if (idx >= 0) list[idx] = record;
  else list.push(record);
  writeJson(f('environments.json'), list);

  const secrets = readSecrets();
  secrets[id] = {
    password: env.password || '',
    passphrase: env.passphrase || '',
  };
  writeSecrets(secrets);

  return id;
}

function deleteEnvironment(id) {
  writeJson(
    f('environments.json'),
    readEnvList().filter((e) => e.id !== id)
  );
  const secrets = readSecrets();
  delete secrets[id];
  writeSecrets(secrets);
  return true;
}

function setLastEnvironment(id) {
  const appState = readJson(f('app-state.json'), {});
  appState.lastEnvId = id || '';
  writeJson(f('app-state.json'), appState);
  return true;
}

/* ---------------- window state ---------------- */
function loadWindowState() {
  return readJson(f('window.json'), {});
}
function saveWindowState(s) {
  writeJson(f('window.json'), s);
  return true;
}

/* ---------------- deployment history ---------------- */
const HISTORY_LIMIT = 200;

function loadHistory() {
  const data = readJson(f('history.json'), []);
  return Array.isArray(data) ? data : [];
}
function saveHistory(list) {
  writeJson(f('history.json'), (list || []).slice(0, HISTORY_LIMIT));
  return true;
}
function addHistory(entry) {
  const list = loadHistory();
  list.unshift(entry);
  saveHistory(list);
  return true;
}

module.exports = {
  listEnvironments,
  saveEnvironment,
  deleteEnvironment,
  setLastEnvironment,
  loadWindowState,
  saveWindowState,
  loadHistory,
  saveHistory,
  addHistory,
};
