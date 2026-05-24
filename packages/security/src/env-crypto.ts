import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

/**
 * v726 — EnvCryptoService
 *
 * AES-256-GCM Encryption für sensible Project-ENV-Variablen.
 * Master-Key kommt aus Config (`security.envEncryptionKey`, base64-encoded 32 bytes)
 * oder wird per `deriveKey(passphrase)` aus einem Passphrase abgeleitet (scrypt).
 *
 * Format pro Verschlüsselung:
 *  - ciphertext: Buffer (encrypted payload)
 *  - iv: 12-byte random nonce
 *  - authTag: 16-byte GCM auth tag (Integrität)
 *
 * Schema-Annahme: ciphertext + iv + authTag werden separat in der DB gespeichert
 * (in unserem Fall: project_environments.vars_encrypted/iv/auth_tag).
 */
export class EnvCryptoService {
  private readonly key: Buffer;

  constructor(keyOrPassphrase: Buffer | string, options?: { isPassphrase?: boolean; salt?: Buffer }) {
    if (typeof keyOrPassphrase === 'string' && options?.isPassphrase) {
      const salt = options.salt ?? Buffer.from('alfred-env-crypto-v1', 'utf8');
      this.key = scryptSync(keyOrPassphrase, salt, 32);
    } else if (typeof keyOrPassphrase === 'string') {
      // base64-encoded raw key
      const buf = Buffer.from(keyOrPassphrase, 'base64');
      if (buf.length !== 32) throw new Error(`envEncryptionKey must decode to 32 bytes (got ${buf.length})`);
      this.key = buf;
    } else {
      if (keyOrPassphrase.length !== 32) throw new Error(`envEncryptionKey buffer must be 32 bytes (got ${keyOrPassphrase.length})`);
      this.key = keyOrPassphrase;
    }
  }

  /** Verschlüsselt ein Plaintext-JSON-Object zu (ciphertext, iv, authTag). */
  encrypt(plain: Record<string, string>): { ciphertext: Buffer; iv: Buffer; authTag: Buffer } {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const json = JSON.stringify(plain);
    const ciphertext = Buffer.concat([cipher.update(json, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return { ciphertext, iv, authTag };
  }

  /** Entschlüsselt eine (ciphertext, iv, authTag)-Triple zurück zu einem JSON-Object. */
  decrypt(ciphertext: Buffer, iv: Buffer, authTag: Buffer): Record<string, string> {
    const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAuthTag(authTag);
    const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    const parsed = JSON.parse(plain) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === 'string') out[k] = v;
    }
    return out;
  }

  /** Helper: erzeugt einen neuen 32-byte random Key (für initiale Config-Seeds). */
  static generateMasterKey(): string {
    return randomBytes(32).toString('base64');
  }
}
