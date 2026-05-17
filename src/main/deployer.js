'use strict';

/**
 * Deploys an SSH public key, either:
 *   - direct  : SSH into each target host and append the key, or
 *   - proxmox : push the key from the Proxmox node via `pct exec` /
 *               `qm guest exec` — no guest login required.
 *
 * In all cases the key is appended to ~/.ssh/authorized_keys and duplicates
 * are skipped.
 */

const { Client } = require('ssh2');

/** Single-quote a string safely for POSIX shells. */
function shq(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function connect(auth) {
  return new Promise((resolve, reject) => {
    const client = new Client();
    let settled = false;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(arg);
    };
    const timer = setTimeout(() => {
      try {
        client.end();
      } catch {
        /* ignore */
      }
      finish(reject, new Error('Connection timed out'));
    }, (auth.readyTimeout || 25000) + 4000);

    client.on('ready', () => finish(resolve, client));
    client.on('error', (err) => finish(reject, err));
    client.on('keyboard-interactive', (_n, _i, _l, prompts, cb) =>
      cb(prompts.map(() => auth.password || ''))
    );
    try {
      client.connect({ ...auth, tryKeyboard: true });
    } catch (err) {
      finish(reject, err);
    }
  });
}

function exec(client, command, timeoutMs = 45000) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (fn, arg) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      fn(arg);
    };
    const timer = setTimeout(
      () => finish(reject, new Error('Remote command timed out')),
      timeoutMs
    );
    client.exec(command, (err, stream) => {
      if (err) return finish(reject, err);
      let stdout = '';
      let stderr = '';
      stream.on('close', (code) => finish(resolve, { code, stdout, stderr }));
      stream.on('data', (d) => (stdout += d));
      stream.stderr.on('data', (d) => (stderr += d));
    });
  });
}

/** Shell script that appends the key to the target user's authorized_keys. */
function appendScript(publicKey) {
  const k = shq(publicKey.trim());
  return (
    'mkdir -p ~/.ssh && chmod 700 ~/.ssh && ' +
    'touch ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys && ' +
    `if grep -qxF ${k} ~/.ssh/authorized_keys; then echo __ALREADY__; ` +
    `else printf '%s\\n' ${k} >> ~/.ssh/authorized_keys && echo __ADDED__; fi`
  );
}

function classify(text) {
  if (text.includes('__ALREADY__')) {
    return { status: 'skipped', message: 'Key was already present' };
  }
  if (text.includes('__ADDED__')) {
    return { status: 'added', message: 'Key added to authorized_keys' };
  }
  return null;
}

function cleanErr(s) {
  return String(s || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .join(' ')
    .slice(0, 220);
}

/** Run a worker over hosts with limited concurrency, emitting progress. */
async function runHosts(hosts, limit, worker, emit) {
  const results = [];
  let index = 0;
  const runner = async () => {
    while (index < hosts.length) {
      const host = hosts[index++];
      emit({ id: host.id, status: 'running' });
      let outcome;
      try {
        outcome = { id: host.id, ...(await worker(host)) };
      } catch (err) {
        outcome = {
          id: host.id,
          status: 'failed',
          message: (err && err.message) || String(err),
        };
      }
      emit(outcome);
      results.push(outcome);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, hosts.length) }, runner)
  );
  return { results };
}

/* ===================== DIRECT SSH ===================== */

async function deployOneDirect(auth, publicKey) {
  const client = await connect(auth);
  try {
    const r = await exec(client, appendScript(publicKey));
    if (r.code !== 0) {
      throw new Error(cleanErr(r.stderr) || 'remote command failed');
    }
    const res = classify(r.stdout);
    if (!res) throw new Error('Unexpected response from host');
    return res;
  } finally {
    client.end();
  }
}

async function deployViaDirect({ hosts, publicKey, creds, resolveAuth }, emit) {
  return runHosts(
    hosts,
    4,
    async (host) => {
      if (!host.address || !host.address.trim()) {
        throw new Error('No address — enter an IP or hostname for this host');
      }
      const auth = resolveAuth({ ...creds, host: host.address.trim() });
      return deployOneDirect(auth, publicKey);
    },
    emit
  );
}

/* ===================== VIA PROXMOX ===================== */

/** Wrap a command to run on `node`, hopping via SSH (by IP) if it is not local. */
function onNode(node, command, ctx) {
  if (node && ctx.connectedNode && node === ctx.connectedNode) return command;
  const target = (ctx.nodeIps && ctx.nodeIps[node]) || node;
  return (
    'ssh -o BatchMode=yes -o ConnectTimeout=10 ' +
    `-o StrictHostKeyChecking=accept-new ${shq('root@' + target)} ${shq(command)}`
  );
}

/** Interpret the JSON returned by `qm guest exec`. */
function classifyQemu(r) {
  if (r.code !== 0) {
    const e = cleanErr(r.stderr) || cleanErr(r.stdout) || 'qm guest exec failed';
    if (/agent/i.test(e)) {
      throw new Error(
        'QEMU guest agent is not available — switch this VM to Direct SSH'
      );
    }
    if (/not running/i.test(e)) throw new Error('VM is not running');
    throw new Error(e);
  }
  let data;
  try {
    data = JSON.parse(r.stdout);
  } catch {
    throw new Error('Could not read the guest agent response');
  }
  if (typeof data.exitcode === 'number' && data.exitcode !== 0) {
    throw new Error(
      cleanErr(data['err-data']) || `guest command exited with ${data.exitcode}`
    );
  }
  const res = classify((data['out-data'] || '') + (data['err-data'] || ''));
  if (!res) throw new Error('Unexpected response from guest');
  return res;
}

async function deployOneProxmox(client, host, script, ctx) {
  let command;
  if (host.kind === 'node') {
    command = onNode(host.node, script, ctx);
  } else if (host.kind === 'lxc') {
    command = onNode(
      host.node,
      `pct exec ${host.vmid} -- /bin/sh -c ${shq(script)}`,
      ctx
    );
  } else if (host.kind === 'qemu') {
    command = onNode(
      host.node,
      `qm guest exec ${host.vmid} --timeout 25 -- /bin/sh -c ${shq(script)}`,
      ctx
    );
  } else {
    throw new Error('Unsupported host type');
  }

  const r = await exec(client, command, 60000);

  if (host.kind === 'qemu') return classifyQemu(r);

  // node / lxc: the script's own exit code and output come straight back
  if (r.code !== 0) {
    const e = cleanErr(r.stderr) || 'command failed';
    if (/not running/i.test(e)) throw new Error('Container is not running');
    throw new Error(e);
  }
  const res = classify(r.stdout);
  if (!res) throw new Error('Unexpected response');
  return res;
}

async function deployViaProxmox(
  { hosts, publicKey, proxmoxAuth, connectedNode, nodeIps },
  emit
) {
  let client;
  try {
    client = await connect(proxmoxAuth);
  } catch (err) {
    const message =
      'Cannot connect to the Proxmox node: ' +
      ((err && err.message) || String(err));
    const results = hosts.map((h) => ({ id: h.id, status: 'failed', message }));
    results.forEach((r) => emit(r));
    return { results };
  }

  const script = appendScript(publicKey);
  const ctx = { connectedNode, nodeIps: nodeIps || {} };
  try {
    return await runHosts(
      hosts,
      3,
      (host) => deployOneProxmox(client, host, script, ctx),
      emit
    );
  } finally {
    client.end();
  }
}

module.exports = { deployViaDirect, deployViaProxmox };
