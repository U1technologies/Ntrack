import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * AES-256-GCM for secrets at rest (MFA secrets, publisher tax/payment details, integration
 * credentials). Format: v1.<iv>.<tag>.<ciphertext>, base64url parts. The version prefix allows
 * key rotation later without a data migration.
 */
export class SecretBox {
  private readonly key: Buffer;

  constructor(base64Key: string) {
    this.key = Buffer.from(base64Key, 'base64');
    if (this.key.length !== 32) throw new Error('Encryption key must be 32 bytes');
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ciphertext.toString('base64url')].join('.');
  }

  decrypt(payload: string): string {
    const [version, iv, tag, ciphertext] = payload.split('.');
    if (version !== 'v1' || !iv || !tag || !ciphertext) throw new Error('Unsupported encrypted payload');
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString('utf8');
  }

  encryptJson(value: unknown): string {
    return this.encrypt(JSON.stringify(value));
  }

  decryptJson<T>(payload: string | null | undefined): T | null {
    return payload ? (JSON.parse(this.decrypt(payload)) as T) : null;
  }
}

export const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

export const safeEqual = (a: string, b: string): boolean => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};
