'use strict';

/**
 * Reads the Proxmox cluster inventory over SSH using `pvesh`.
 * Works from any machine — no Proxmox API token required.
 *
 * Every remote command is bounded by a timeout so a single unresponsive
 * call (e.g. a stuck QEMU guest agent) can never hang the whole connect.
 */

const { Client } = require('ssh2');

const CLUSTER_CMD_TIMEOUT = 20000; // /cluster/* queries
const GUEST_CMD_TIMEOUT = 7000; // per-guest IP lookups (agent may be slow)

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
      finish(
        reject,
        new Error(`Connection to ${auth.host}:${auth.port || 22} timed out`)
      );
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

function exec(client, command, timeoutMs = CLUSTER_CMD_TIMEOUT) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (fn, arg) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      fn(arg);
    };
    const timer = setTimeout(
      () => finish(reject, new Error(`Remote command timed out: ${command}`)),
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

async function pveshJson(client, apiPath, timeoutMs) {
  const r = await exec(
    client,
    `pvesh get ${apiPath} --output-format json 2>/dev/null`,
    timeoutMs
  );
  if (r.code !== 0) throw new Error(`Command failed: pvesh get ${apiPath}`);
  return JSON.parse(r.stdout || 'null');
}

function ipFromLxcNet(value) {
  if (!value) return '';
  const m = /(?:^|,)ip=([0-9.]+)/.exec(String(value));
  return m && m[1] !== '0.0.0.0' ? m[1] : '';
}

/** Best-effort IP discovery for a single guest. Never throws, never hangs. */
async function resolveGuestIp(client, host) {
  try {
    if (host.kind === 'lxc') {
      const cfg = await pveshJson(
        client,
        `/nodes/${host.node}/lxc/${host.vmid}/config`,
        GUEST_CMD_TIMEOUT
      );
      for (const key of Object.keys(cfg || {})) {
        if (/^net\d+$/.test(key)) {
          const ip = ipFromLxcNet(cfg[key]);
          if (ip) return ip;
        }
      }
    } else if (host.kind === 'qemu') {
      const data = await pveshJson(
        client,
        `/nodes/${host.node}/qemu/${host.vmid}/agent/network-get-interfaces`,
        GUEST_CMD_TIMEOUT
      );
      const ifaces = data && (data.result || data);
      if (Array.isArray(ifaces)) {
        for (const iface of ifaces) {
          if (iface.name && /^(lo|docker|veth|tap|fwbr|fwln)/.test(iface.name)) {
            continue;
          }
          for (const addr of iface['ip-addresses'] || []) {
            const ip = addr['ip-address'];
            if (
              addr['ip-address-type'] === 'ipv4' &&
              ip &&
              !ip.startsWith('127.') &&
              !ip.startsWith('169.254.')
            ) {
              return ip;
            }
          }
        }
      }
    }
  } catch {
    /* agent missing / slow / no permission — leave the address blank */
  }
  return '';
}

/** Run `worker` over `items` with limited concurrency. */
async function pool(items, limit, worker) {
  let index = 0;
  const runners = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (index < items.length) {
        const i = index++;
        await worker(items[i]);
      }
    }
  );
  await Promise.all(runners);
}

async function fetchHosts(auth) {
  const client = await connect(auth);
  try {
    const probe = await exec(
      client,
      'command -v pvesh >/dev/null 2>&1 && echo HAVE_PVESH || echo NO_PVESH',
      10000
    );
    if (!probe.stdout.includes('HAVE_PVESH')) {
      throw new Error(
        '`pvesh` was not found on this host — is it really a Proxmox node?'
      );
    }

    const [resources, status] = await Promise.all([
      pveshJson(client, '/cluster/resources'),
      pveshJson(client, '/cluster/status').catch(() => []),
    ]);

    const nodeIp = {};
    let localNode = '';
    for (const s of status || []) {
      if (s.type === 'node') {
        if (s.ip) nodeIp[s.name] = s.ip;
        if (s.local) localNode = s.name;
      }
    }

    const hosts = [];
    for (const r of resources || []) {
      if (r.type === 'node') {
        hosts.push({
          id: `node:${r.node}`,
          kind: 'node',
          name: r.node,
          node: r.node,
          vmid: null,
          status: r.status || 'unknown',
          address: nodeIp[r.node] || '',
        });
      } else if (r.type === 'qemu' || r.type === 'lxc') {
        hosts.push({
          id: `${r.type}:${r.vmid}`,
          kind: r.type,
          name: r.name || `${r.type}-${r.vmid}`,
          node: r.node,
          vmid: r.vmid,
          status: r.status || 'unknown',
          address: '',
        });
      }
    }

    // Guest IP addresses are resolved separately, in the background, so the
    // host list can be shown instantly (see resolveAddresses below).
    return { hosts, node: localNode || auth.host };
  } finally {
    client.end();
  }
}

/**
 * Resolve IP addresses for a batch of guests over a fresh connection,
 * invoking `onResolved({ id, address })` as each one completes.
 */
async function resolveAddresses(auth, guests, onResolved) {
  if (!guests || !guests.length) return;
  const client = await connect(auth);
  try {
    await pool(guests, 8, async (g) => {
      let address = '';
      try {
        address = await resolveGuestIp(client, g);
      } catch {
        /* best effort */
      }
      onResolved({ id: g.id, address });
    });
  } finally {
    client.end();
  }
}

module.exports = { fetchHosts, resolveAddresses };
