export interface Env extends Cloudflare.Env {
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

/** The connection flags plus, when a game is under way, what is happening in it. */
export interface DeviceSnapshot {
  status: DeviceStatus;
  game: import("./agent-contract").AgentGame | null;
}

export interface DeviceStatusRepository {
  getForDiscordUser(discordUserId: string, now: Date): Promise<DeviceSnapshot>;
}

export interface DeviceAuthenticationRepository {
  authenticate(credential: string, now: Date): Promise<{ deviceId: string } | null>;
}
