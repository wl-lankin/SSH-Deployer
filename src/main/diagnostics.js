'use strict';

/**
 * Connection diagnostics. Probes a target step by step so a failure can be
 * pinned to a specific layer instead of a vague "timed out".
 *
 * Returns an ordered array of { name, status, detail } where status is one of
 * 'ok' | 'fail' | 'warn'. The sequence stops at the first hard failure.
 */

const net = require('net');
const dns = require('dns').promises;
const { Client } = require('ssh2');

/** Open a TCP socket and also capture the SSH banner if one arrives. */
function sshPortProbe(host, port, timeout = 7000) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const start = Date.now();
    let done = false;
    let connectedMs = null;

    const finish = (r) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(r);
    };

    socket.setTimeout(timeout);
    socket.once('connect', () => {
      connectedMs = Date.now() - start;
    });
    socket.once('data', (d) => {
      const text = d.toString('latin1', 0, 96);
      finish({
        tcp: true,
        ms: connectedMs,
        banner: /^SSH-/.test(text) ? text.split(/\r?\n/)[0].trim() : null,
        gotData: true,
      });
    });
    socket.once('timeout', () =>
      finish(
        connectedMs != null
          ? { tcp: true, ms: connectedMs, banner: null, gotData: false }
          : { tcp: false, reason: 'timeout' }
      )
    );
    socket.once('error', (err) =>
      finish({ tcp: false, reason: err.code || err.message })
    );
    socket.connect(port, host);
  });
}

function execOnce(client, command, timeout = 8000) {
  return new Promise((resolve, reject) => {
    let done = false;
    const t = setTimeout(() => {
      if (!done) {
        done = true;
        reject(new Error('command timed out'));
      }
    }, timeout);
    client.exec(command, (err, stream) => {
      if (err) {
        if (!done) {
          done = true;
          clearTimeout(t);
          reject(err);
        }
        return;
      }
      let out = '';
      stream.on('data', (d) => (out += d));
      stream.stderr.on('data', () => {});
      stream.on('close', () => {
        if (!done) {
          done = true;
          clearTimeout(t);
          resolve(out.trim());
        }
      });
    });
  });
}

/** Attempt a real SSH login; on success also probe for `pvesh`. */
function sshProbe(auth) {
  return new Promise((resolve) => {
    const client = new Client();
    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        client.end();
      } catch {
        /* ignore */
      }
      resolve(r);
    };
    const timer = setTimeout(
      () => finish({ ok: false, error: new Error('Handshake timed out') }),
      15000
    );

    client.on('ready', async () => {
      let pvesh = '';
      try {
        pvesh = await execOnce(
          client,
          'command -v pvesh >/dev/null 2>&1 && ' +
            '(pveversion 2>/dev/null | head -n1 || echo "Proxmox VE") || echo NO_PVESH'
        );
      } catch {
        /* ignore */
      }
      finish({ ok: true, pvesh });
    });
    client.on('error', (err) => finish({ ok: false, error: err }));
    client.on('keyboard-interactive', (_n, _i, _l, prompts, cb) =>
      cb(prompts.map(() => auth.password || ''))
    );

    try {
      client.connect({ ...auth, readyTimeout: 13000, tryKeyboard: true });
    } catch (err) {
      finish({ ok: false, error: err });
    }
  });
}

function tcpFailDetail(reason, port) {
  switch (reason) {
    case 'timeout':
      return `No response on port ${port}. The host is unreachable from this PC, or a firewall is dropping the connection.`;
    case 'ECONNREFUSED':
      return `Connection refused — the host is reachable but nothing is listening on port ${port}.`;
    case 'EHOSTUNREACH':
      return 'Host unreachable — there is no network route to this address.';
    case 'ENETUNREACH':
      return 'Network unreachable — check your network or VPN connection.';
    case 'ENOTFOUND':
      return 'Host name could not be found.';
    default:
      return `Could not open a connection (${reason}).`;
  }
}

function friendlyAuthError(err) {
  const msg = (err && err.message) || String(err);
  const level = err && err.level;
  if (level === 'client-authentication' || /authentication methods failed/i.test(msg)) {
    return 'Reached the SSH server, but login was rejected. Wrong password, or this key is not in the node’s authorized_keys.';
  }
  if (/Encrypted private key|bad passphrase|integrity check failed/i.test(msg)) {
    return 'The private key is encrypted and the passphrase is missing or wrong.';
  }
  if (/parse privateKey|Cannot parse|Unsupported key|Malformed/i.test(msg)) {
    return 'The selected file could not be read as a private key. Make sure it is the private key (not the .pub file).';
  }
  if (/handshake/i.test(msg) || /timed out/i.test(msg)) {
    return 'The SSH handshake did not complete — the server stopped responding mid-negotiation.';
  }
  return msg;
}

async function diagnose(auth) {
  const steps = [];
  const host = auth.host;
  const port = Number(auth.port) || 22;

  // 1 — address / DNS
  if (net.isIP(host)) {
    steps.push({ name: 'Address', status: 'ok', detail: `${host} (IP address)` });
  } else {
    try {
      const r = await dns.lookup(host);
      steps.push({
        name: 'DNS resolution',
        status: 'ok',
        detail: `"${host}" resolves to ${r.address}`,
      });
    } catch (e) {
      steps.push({
        name: 'DNS resolution',
        status: 'fail',
        detail: `Cannot resolve host name "${host}" (${e.code || e.message}).`,
      });
      return steps;
    }
  }

  // 2 + 3 — TCP reachability and SSH banner
  const probe = await sshPortProbe(host, port);
  if (!probe.tcp) {
    steps.push({
      name: `TCP port ${port}`,
      status: 'fail',
      detail: tcpFailDetail(probe.reason, port),
    });
    return steps;
  }
  steps.push({
    name: `TCP port ${port}`,
    status: 'ok',
    detail: `Reachable (${probe.ms} ms round-trip).`,
  });

  if (probe.banner) {
    steps.push({ name: 'SSH service', status: 'ok', detail: probe.banner });
  } else if (probe.gotData) {
    steps.push({
      name: 'SSH service',
      status: 'fail',
      detail: `Port ${port} is open, but the service answering is not SSH.`,
    });
    return steps;
  } else {
    steps.push({
      name: 'SSH service',
      status: 'warn',
      detail: 'Port is open but no SSH banner arrived in time — continuing anyway.',
    });
  }

  // 4 — SSH login
  const ssh = await sshProbe(auth);
  if (!ssh.ok) {
    steps.push({
      name: 'SSH login',
      status: 'fail',
      detail: friendlyAuthError(ssh.error),
    });
    return steps;
  }
  steps.push({
    name: 'SSH login',
    status: 'ok',
    detail: `Authenticated as "${auth.username}".`,
  });

  // 5 — Proxmox
  if (ssh.pvesh && ssh.pvesh !== 'NO_PVESH') {
    steps.push({ name: 'Proxmox', status: 'ok', detail: ssh.pvesh });
  } else {
    steps.push({
      name: 'Proxmox',
      status: 'warn',
      detail: '`pvesh` was not found — this may not be a Proxmox node, or the user lacks permission.',
    });
  }

  return steps;
}

module.exports = { diagnose };
