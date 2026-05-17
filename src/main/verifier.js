'use strict';

/**
 * Verifies that a private key is accepted by a host: opens an SSH session,
 * checks authentication succeeds, then closes it immediately. Nothing is
 * changed on the host — this is a read-only login test.
 */

const { Client } = require('ssh2');

function verifyOne(auth) {
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
      () => finish({ status: 'unreachable', message: 'Connection timed out' }),
      9000
    );

    client.on('ready', () =>
      finish({ status: 'ok', message: 'Key accepted — login succeeded' })
    );
    client.on('error', (err) => {
      const m = (err && err.message) || String(err);
      const level = err && err.level;
      if (
        level === 'client-authentication' ||
        /authentication methods failed/i.test(m)
      ) {
        finish({ status: 'rejected', message: 'Key was rejected by the host' });
      } else if (/encrypted/i.test(m)) {
        finish({ status: 'unreachable', message: 'Private key needs a passphrase' });
      } else if (/ECONNREFUSED/.test(m)) {
        finish({ status: 'unreachable', message: 'Connection refused on this port' });
      } else if (/EHOSTUNREACH|ENETUNREACH|ENOTFOUND|timed out|handshake/i.test(m)) {
        finish({ status: 'unreachable', message: 'Host unreachable' });
      } else {
        finish({ status: 'unreachable', message: m });
      }
    });

    try {
      client.connect({
        host: auth.host,
        port: Number(auth.port) || 22,
        username: (auth.username || 'root').trim() || 'root',
        privateKey: auth.privateKey,
        passphrase: auth.passphrase || undefined,
        readyTimeout: 7000,
      });
    } catch (err) {
      const m = (err && err.message) || String(err);
      finish({
        status: /encrypted/i.test(m) ? 'unreachable' : 'rejected',
        message: /encrypted/i.test(m) ? 'Private key needs a passphrase' : m,
      });
    }
  });
}

async function verifyAll({ hosts, privateKey, passphrase }, emit) {
  const results = [];
  let index = 0;
  const limit = 20;
  const runner = async () => {
    while (index < hosts.length) {
      const h = hosts[index++];
      emit({ id: h.id, status: 'running' });
      let r;
      if (!h.address || !String(h.address).trim()) {
        r = { status: 'unreachable', message: 'No address set for this host' };
      } else {
        r = await verifyOne({
          host: String(h.address).trim(),
          port: h.port,
          username: h.username,
          privateKey,
          passphrase,
        });
      }
      emit({ id: h.id, ...r });
      results.push({ id: h.id, ...r });
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, hosts.length) }, runner)
  );
  return { results };
}

module.exports = { verifyAll };
