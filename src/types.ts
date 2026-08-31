export interface Env {
  COACH_DB: D1Database;
  DISCORD_PUBLIC_KEY: string;
}

export interface PairingCode {
  value: string;
  expiresAt: Date;
}

export interface DeviceStatus {
  agent: "Connected" | "Disconnected" | "Not paired";
  league: "Running" | "Not detected" | "Unknown";
  liveApi: "Available" | "Unavailable" | "Unknown";
  currentGame: "Active" | "Inactive" | "Unknown";
}

export interface PairingCodeRepository {
  create(discordUserId: string, now: Date): Promise<PairingCode>;
  redeem(code: string, deviceName: string, now: Date): Promise<{ deviceId: string; credential: string } | null>;
}

export interface DeviceStatusRepository {
  getForDiscordUser(discordUserId: string, now: Date): Promise<DeviceStatus>;
}
