import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { secretKeyFile } from '../config.js';

let cachedKey: Buffer | null = null;

/**
 * Local key used to encrypt stored database passwords. It lives next to the
 * connection file, so this protects against accidental sharing of the config
 * file rather than against an attacker who already has full disk access.
 */
function secretKey(): Buffer {
  if (cachedKey) return cachedKey;
  if (existsSync(secretKeyFile)) {
    const raw = readFileSync(secretKeyFile, 'utf8').trim();
    const key = Buffer.from(raw, 'hex');
    if (key.length === 32) {
      cachedKey = key;
      return key;
    }
  }
  const key = randomBytes(32);
  writeFileSync(secretKeyFile, key.toString('hex'), { mode: 0o600 });
  cachedKey = key;
  return key;
}

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', secretKey(), iv);
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64'), tag.toString('base64'), body.toString('base64')].join(':');
}

export function decryptSecret(payload: string): string {
  const parts = payload.split(':');
  if (parts.length !== 4 || parts[0] !== 'v1') throw new Error('Unsupported secret format');
  const iv = Buffer.from(parts[1]!, 'base64');
  const tag = Buffer.from(parts[2]!, 'base64');
  const body = Buffer.from(parts[3]!, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', secretKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
}
