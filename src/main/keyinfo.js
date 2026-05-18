'use strict';

const crypto = require('crypto');

const KNOWN_TYPES = [
  'ssh-ed25519',
  'ssh-ed448',
  'ssh-rsa',
  'ssh-dss',
  'ecdsa-sha2-nistp256',
  'ecdsa-sha2-nistp384',
  'ecdsa-sha2-nistp521',
  'sk-ssh-ed25519@openssh.com',
  'sk-ecdsa-sha2-nistp256@openssh.com',
];

const LABELS = {
  'ssh-ed25519': 'Ed25519',
  'ssh-ed448': 'Ed448',
  'ssh-rsa': 'RSA',
  'ssh-dss': 'DSA',
  'ecdsa-sha2-nistp256': 'ECDSA P-256',
  'ecdsa-sha2-nistp384': 'ECDSA P-384',
  'ecdsa-sha2-nistp521': 'ECDSA P-521',
  'sk-ssh-ed25519@openssh.com': 'Ed25519 (FIDO)',
  'sk-ecdsa-sha2-nistp256@openssh.com': 'ECDSA (FIDO)',
};

/**
 * Validate and describe a single SSH public key line.
 * Returns { valid, type, label, comment, fingerprint, b64, normalized } or
 * { valid:false, error }.
 */
function describeKeyLine(line) {
  const parts = String(line || '').trim().split(/\s+/);
  if (parts.length < 2) {
    return { valid: false, error: 'This does not look like a public key' };
  }

  const [type, b64, ...rest] = parts;
  if (!KNOWN_TYPES.includes(type)) {
    return { valid: false, error: `Unsupported key type "${type}"` };
  }

  let blob;
  try {
    blob = Buffer.from(b64, 'base64');
  } catch {
    return { valid: false, error: 'Key data is not valid base64' };
  }
  if (!blob.length) return { valid: false, error: 'Key data is empty' };

  // The blob must begin with its own type string.
  try {
    const len = blob.readUInt32BE(0);
    const embedded = blob.slice(4, 4 + len).toString('utf8');
    if (embedded !== type) {
      return { valid: false, error: 'Key data is corrupt or truncated' };
    }
  } catch {
    return { valid: false, error: 'Key data is corrupt or truncated' };
  }

  const fingerprint =
    'SHA256:' +
    crypto.createHash('sha256').update(blob).digest('base64').replace(/=+$/, '');

  const comment = rest.join(' ');

  return {
    valid: true,
    type,
    label: LABELS[type] || type,
    comment,
    fingerprint,
    b64,
    normalized: `${type} ${b64}${comment ? ' ' + comment : ''}`,
  };
}

/** Describe the first key in a pasted block of text. */
function parsePublicKey(text) {
  if (!text || !text.trim()) return { valid: false, error: 'No key entered' };
  const line =
    text.trim().split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0] || '';
  return describeKeyLine(line);
}

module.exports = { parsePublicKey, describeKeyLine };
