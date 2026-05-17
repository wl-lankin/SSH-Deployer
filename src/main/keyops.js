'use strict';

/**
 * Reads and removes SSH keys from cluster hosts — the data layer behind the
 * audit view. Works through the Proxmox node (pct exec / qm guest exec) or
 * by direct SSH, mirroring the deploy paths. Read-only audit never changes a
 * host; removal only deletes the matching authorized_keys line.
 */

const { Client } = require('ssh2');
const { describeKeyLine } = require('./keyinfo');

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

function cleanErr(s) {
  return String(s || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .join(' ')
    .slice(0, 200);
}

function onNode(node, command, ctx) {
  if (node && ctx.connectedNode && node === ctx.connectedNode) return command;
  const target = (ctx.nodeIps && ctx.nodeIps[node]) || node;
  return (
    'ssh -o BatchMode=yes -o ConnectTimeout=10 ' +
    `-o StrictHostKeyChecking=accept-new ${shq('root@' + target)} ${shq(command)}`
  );
}

/**
 * Run a /bin/sh script inside a host via the Proxmox node. Throws on an
 * infrastructure failure; otherwise returns the script's { code, stdout }.
 */
async function runViaProxmox(client, host, script, ctx) {
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

  if (host.kind === 'qemu') {
    if (r.code !== 0) {
      const e = cleanErr(r.stderr) || cleanErr(r.stdout) || 'qm guest exec failed';
      if (/agent/i.test(e)) {
        throw new Error('QEMU guest agent is not available — use Direct SSH');
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
    return { code: data.exitcode || 0, stdout: data['out-data'] || '' };
  }

  if (r.code !== 0) {
    const e = cleanErr(r.stderr) || 'command failed';
    if (/not running/i.test(e)) throw new Error('Container is not running');
    throw new Error(e);
  }
  return r;
}

/* ---- scripts ---- */
const READ_SCRIPT = 'cat ~/.ssh/authorized_keys 2>/dev/null || true';

function removeScript(b64) {
  const k = shq(b64);
  return (
    'f=~/.ssh/authorized_keys; ' +
    'if [ ! -f "$f" ]; then echo __ABSENT__; ' +
    `elif ! grep -qF ${k} "$f"; then echo __ABSENT__; ` +
    `else grep -vF ${k} "$f" > "$f.new" && mv "$f.new" "$f" && ` +
    'chmod 600 "$f" && echo __REMOVED__; fi'
  );
}

/** Parse authorized_keys text into distinct key descriptors. */
function parseKeys(text) {
  const keys = [];
  let unreadable = 0;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const d = describeKeyLine(line);
    if (d.valid) {
      keys.push({
        type: d.type,
        label: d.label,
        comment: d.comment,
        fingerprint: d.fingerprint,
        b64: d.b64,
      });
    } else {
      unreadable++;
    }
  }
  return { keys, unreadable };
}

function classifyRemove(stdout) {
  if (stdout.includes('__REMOVED__')) {
    return { status: 'removed', message: 'Key removed' };
  }
  if (stdout.includes('__ABSENT__')) {
    return { status: 'absent', message: 'Key was not present' };
  }
  return { status: 'failed', message: 'Unexpected response from host' };
}

/* ---- limited-concurrency runner ---- */
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

/** Run an operation across hosts, choosing the Proxmox or direct transport. */
async function runOperation(payload, perProxmoxHost, perDirectHost, emit) {
  if (payload.mode === 'proxmox') {
    let client;
    try {
      client = await connect(payload.proxmoxAuth);
    } catch (err) {
      const message =
        'Cannot connect to the Proxmox node: ' + ((err && err.message) || err);
      const results = payload.hosts.map((h) => ({
        id: h.id,
        status: 'failed',
        message,
      }));
      results.forEach((r) => emit(r));
      return { results };
    }
    const ctx = {
      connectedNode: payload.connectedNode,
      nodeIps: payload.nodeIps || {},
    };
    try {
      return await runHosts(
        payload.hosts,
        3,
        (host) => perProxmoxHost(client, host, ctx),
        emit
      );
    } finally {
      client.end();
    }
  }

  return runHosts(
    payload.hosts,
    6,
    async (host) => {
      if (!host.address || !host.address.trim()) {
        throw new Error('No address — set an IP or hostname for this host');
      }
      const auth = payload.resolveAuth({
        ...payload.creds,
        host: host.address.trim(),
      });
      const client = await connect(auth);
      try {
        return await perDirectHost(client);
      } finally {
        client.end();
      }
    },
    emit
  );
}

/* ====================== AUDIT ====================== */
async function auditHosts(payload, emit) {
  return runOperation(
    payload,
    async (client, host, ctx) => {
      const r = await runViaProxmox(client, host, READ_SCRIPT, ctx);
      return { status: 'ok', ...parseKeys(r.stdout) };
    },
    async (client) => {
      const r = await exec(client, READ_SCRIPT);
      return { status: 'ok', ...parseKeys(r.stdout) };
    },
    emit
  );
}

/* ====================== REMOVE ====================== */
async function removeKey(payload, emit) {
  const script = removeScript(payload.keyB64);
  return runOperation(
    payload,
    async (client, host, ctx) => {
      const r = await runViaProxmox(client, host, script, ctx);
      return classifyRemove(r.stdout);
    },
    async (client) => {
      const r = await exec(client, script);
      return classifyRemove(r.stdout);
    },
    emit
  );
}

module.exports = { auditHosts, removeKey };
