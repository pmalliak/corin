import { newOpaqueSecret, sha256 } from "./crypto";
import type { DeviceAuthenticationRepository, Env, PairingCode, PairingCodeRepository } from "./types";

const pairingLifetimeMs = 10 * 60 * 1_000;

export class D1CoachRepository implements PairingCodeRepository, DeviceAuthenticationRepository {
  public constructor(private readonly db: Env["COACH_DB"]) {}

  public async create(discordUserId: string, now: Date): Promise<PairingCode> {
    const userId = crypto.randomUUID();
    const createdAt = now.toISOString();

    await this.db
      .prepare("INSERT INTO users (id, discord_user_id, created_at) VALUES (?, ?, ?) ON CONFLICT(discord_user_id) DO NOTHING")
      .bind(userId, discordUserId, createdAt)
      .run();

    const code = newOpaqueSecret(6).toUpperCase();
    const codeId = crypto.randomUUID();
    const expiresAt = new Date(now.getTime() + pairingLifetimeMs);

    await this.db
      .prepare(
        "INSERT INTO pairing_codes (id, user_id, code_hash, expires_at, created_at) SELECT ?, id, ?, ?, ? FROM users WHERE discord_user_id = ?",
      )
      .bind(codeId, await sha256(code), expiresAt.toISOString(), createdAt, discordUserId)
      .run();

    return { value: code, expiresAt };
  }

  public async redeem(code: string, deviceName: string, now: Date): Promise<{ deviceId: string; credential: string } | null> {
    const codeHash = await sha256(code.toUpperCase());
    const matching = await this.db
      .prepare("SELECT id, user_id FROM pairing_codes WHERE code_hash = ? AND expires_at > ? AND consumed_at IS NULL")
      .bind(codeHash, now.toISOString())
      .first<{ id: string; user_id: string }>();

    if (!matching) return null;

    const consumed = await this.db
      .prepare("UPDATE pairing_codes SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL")
      .bind(now.toISOString(), matching.id)
      .run();
    if (consumed.meta.changes !== 1) return null;

    const deviceId = crypto.randomUUID();
    const credential = newOpaqueSecret(32);
    await this.db
      .prepare("INSERT INTO devices (id, user_id, name, credential_hash, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind(deviceId, matching.user_id, deviceName, await sha256(credential), now.toISOString())
      .run();

    return { deviceId, credential };
  }

  public async getLatestDeviceIdForDiscordUser(discordUserId: string): Promise<string | null> {
    const device = await this.db
      .prepare("SELECT devices.id FROM devices INNER JOIN users ON users.id = devices.user_id WHERE users.discord_user_id = ? AND devices.revoked_at IS NULL ORDER BY devices.last_seen_at DESC, devices.created_at DESC LIMIT 1")
      .bind(discordUserId)
      .first<{ id: string }>();
    return device?.id ?? null;
  }

  public async authenticate(credential: string, now: Date): Promise<{ deviceId: string } | null> {
    const device = await this.db
      .prepare("SELECT id FROM devices WHERE credential_hash = ? AND revoked_at IS NULL")
      .bind(await sha256(credential))
      .first<{ id: string }>();
    if (!device) return null;
    await this.db.prepare("UPDATE devices SET last_seen_at = ? WHERE id = ?").bind(now.toISOString(), device.id).run();
    return { deviceId: device.id };
  }
}
