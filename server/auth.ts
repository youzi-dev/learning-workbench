import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { transaction } from './database';

export type DeviceIdentity = { accountId: string; deviceId: string };
export type DeviceCredential = DeviceIdentity & { token: string };
const hash = (secret: string) => createHash('sha256').update(secret).digest('hex');
const token = () => randomBytes(32).toString('base64url');
export class AuthService {
  private readonly now: () => number;
  private readonly pairingLifetimeMs: number;
  private readonly maxPairAttempts: number;
  constructor(private readonly db: DatabaseSync, options: { now?: () => number; pairingLifetimeMs?: number; maxPairAttempts?: number } = {}) {
    this.now = options.now ?? Date.now; this.pairingLifetimeMs = options.pairingLifetimeMs ?? 600_000; this.maxPairAttempts = options.maxPairAttempts ?? 5;
  }
  async provisionOwner(): Promise<string> {
    return transaction(this.db, () => {
      const existing = this.db.prepare('SELECT id FROM accounts WHERE owner_slot=1').get() as { id: string } | undefined;
      if (existing) return existing.id;
      const id = randomUUID(); this.db.prepare('INSERT INTO accounts(id,created_at) VALUES (?,?)').run(id, this.now()); return id;
    });
  }
  async createPairingCode(accountId: string): Promise<string> {
    if (!this.db.prepare('SELECT id FROM accounts WHERE id=?').get(accountId)) throw new Error('UNKNOWN_ACCOUNT');
    // 80 random bits, copied by the administrator; no fixed/default credential.
    const code = randomBytes(10).toString('hex');
    this.db.prepare('INSERT INTO pairing_codes(code_hash,account_id,expires_at) VALUES (?,?,?)').run(hash(code), accountId, this.now() + this.pairingLifetimeMs);
    return code;
  }
  pair(code: string, name: string, source: string, requestedDeviceId?: string, replaceExistingDevice = false): DeviceCredential {
    if (typeof replaceExistingDevice !== 'boolean' || (replaceExistingDevice && !requestedDeviceId)) throw new Error('INVALID_DEVICE_RECOVERY');
    if (requestedDeviceId !== undefined && (typeof requestedDeviceId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestedDeviceId))) throw new Error('INVALID_DEVICE_ID');
    if (typeof name !== 'string' || !name.trim() || name.length > 100) throw new Error('INVALID_DEVICE_NAME');
    // Persist rate limits before checking the secret, including failed attempts. Never trust forwarded IP headers.
    transaction(this.db, () => {
      for (const scope of ['global', `source:${hash(source)}`]) {
        const existing = this.db.prepare('SELECT window_start,attempts FROM pairing_attempts WHERE scope=?').get(scope) as { window_start: number; attempts: number } | undefined;
        const window = existing && this.now() - existing.window_start < 600_000 ? existing : { window_start: this.now(), attempts: 0 };
        if (window.attempts >= this.maxPairAttempts * (scope === 'global' ? 10 : 1)) throw new Error('RATE_LIMITED');
        this.db.prepare('INSERT INTO pairing_attempts(scope,window_start,attempts) VALUES (?,?,?) ON CONFLICT(scope) DO UPDATE SET window_start=excluded.window_start,attempts=excluded.attempts').run(scope, window.window_start, window.attempts + 1);
      }
    });
    return transaction(this.db, () => {
      const row = typeof code === 'string' && code.length <= 128 ? this.db.prepare('SELECT account_id FROM pairing_codes WHERE code_hash=? AND used_at IS NULL AND expires_at>?').get(hash(code), this.now()) as { account_id: string } | undefined : undefined;
      if (!row) throw new Error('INVALID_PAIRING_CODE');
      const deviceId = requestedDeviceId ?? randomUUID();
      const existing = this.db.prepare('SELECT id,account_id FROM devices WHERE lower(id)=lower(?)').get(deviceId) as {id: string; account_id: string} | undefined;
      if (existing && (!replaceExistingDevice || existing.account_id !== row.account_id)) throw new Error('DEVICE_ID_IN_USE');
      if (!existing && replaceExistingDevice) throw new Error('INVALID_DEVICE_RECOVERY');
      this.db.prepare('UPDATE pairing_codes SET used_at=? WHERE code_hash=?').run(this.now(), hash(code));
      const credential = { accountId: row.account_id, deviceId: existing?.id ?? deviceId, token: token() };
      if (existing) {
        this.db.prepare('UPDATE devices SET name=?, token_hash=?, revoked_at=NULL WHERE id=?').run(name.trim(), hash(credential.token), existing.id);
        return credential;
      }
      this.db.prepare('INSERT INTO devices(id,account_id,name,token_hash,created_at) VALUES (?,?,?,?,?)').run(credential.deviceId, credential.accountId, name.trim(), hash(credential.token), this.now());
      return credential;
    });
  }
  authenticate(credential: string): DeviceIdentity {
    if (typeof credential !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(credential)) throw new Error('UNAUTHORIZED');
    const device = this.db.prepare('SELECT id,account_id FROM devices WHERE token_hash=? AND revoked_at IS NULL').get(hash(credential)) as { id: string; account_id: string } | undefined;
    if (!device) throw new Error('UNAUTHORIZED');
    return { accountId: device.account_id, deviceId: device.id };
  }
  refresh(credential: string): DeviceCredential {
    return transaction(this.db, () => {
      const identity = this.authenticate(credential); const next = token();
      this.db.prepare('UPDATE devices SET token_hash=? WHERE id=?').run(hash(next), identity.deviceId);
      return { ...identity, token: next };
    });
  }
  revoke(accountId: string, deviceId: string): void {
    this.db.prepare('UPDATE devices SET revoked_at=? WHERE account_id=? AND id=?').run(this.now(), accountId, deviceId);
  }
}
