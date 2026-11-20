import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Keeps a secret (a pilot's API token) from sitting in the database in plain text: AES-256-GCM with a random key that lives in a file of its own beside
 * the database. A copy of the database alone (a backup, a file sent for support) then holds nothing that works. It does not protect against someone who
 * can read the whole folder, which is the same computer the bot runs on, and the people who use it are told so.
 *
 * A sealed value is `v1:<iv>:<tag>:<data>` (base64). Opening one that was tampered with, or sealed with another key, gives null, never a wrong value.
 */
const KEY_BYTES = 32;
const IV_BYTES = 12;
const PREFIX = 'v1';

export class SecretBox {
  private constructor(private readonly key: Buffer) {}

  /** A key that lives only as long as the program: what is sealed with it cannot be opened after a restart. For tests, and a fallback when no key file can be kept. */
  static inMemory(): SecretBox {
    return new SecretBox(randomBytes(KEY_BYTES));
  }

  /** The key in `path` (64 hex digits), made with random bytes if there is no such file yet. */
  static fromFile(path: string): SecretBox {
    if (existsSync(path)) {
      const hex = readFileSync(path, 'utf8').trim();
      if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error('The key file for stored tokens is not a key.');
      return new SecretBox(Buffer.from(hex, 'hex'));
    }
    mkdirSync(dirname(path), { recursive: true });
    const key = randomBytes(KEY_BYTES);
    try {
      writeFileSync(path, `${key.toString('hex')}\n`, { mode: 0o600, flag: 'wx' });
    } catch (e) {
      // Another start made it a moment ago: use theirs, not ours.
      if ((e as { code?: string }).code === 'EEXIST') return SecretBox.fromFile(path);
      throw e;
    }
    return new SecretBox(key);
  }

  seal(plain: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return [PREFIX, iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join(':');
  }

  /** The secret, or null if this is not something this key sealed (or it was changed). */
  open(sealed: string | null | undefined): string | null {
    if (!sealed) return null;
    const [prefix, iv, tag, data, extra] = sealed.split(':');
    if (prefix !== PREFIX || !iv || !tag || data === undefined || extra !== undefined) return null;
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64'));
      decipher.setAuthTag(Buffer.from(tag, 'base64'));
      return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
    } catch {
      return null;
    }
  }
}
