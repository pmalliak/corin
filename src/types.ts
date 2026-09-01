export interface Env extends Cloudflare.Env {
  DISCORD_PUBLIC_KEY: string;
  /** Lets the voice coach read player game state. Absent means the route does not exist. */
  COACH_SERVICE_TOKEN?: string;
}

/** The Discord identity behind a pairing. The handle is what a person recognises. */
export interface DiscordAccount {
  id: string;
  username: string | null;
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
  create(account: DiscordAccount, now: Date): Promise<PairingCode>;
  redeem(code: string, deviceName: string, now: Date): Promise<RedeemedPairing | null>;
}

/** What the agent learns at pairing: its own credential, and whose account it now serves. */
export interface RedeemedPairing {
  deviceId: string;
  credential: string;
  discordUsername: string | null;
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
