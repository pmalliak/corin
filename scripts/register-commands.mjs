const applicationId = process.env.DISCORD_APPLICATION_ID;
const botToken = process.env.DISCORD_BOT_TOKEN;
const guildId = process.env.DISCORD_GUILD_ID;

if (!applicationId || !botToken || !guildId) {
  throw new Error("Set DISCORD_APPLICATION_ID, DISCORD_BOT_TOKEN, and DISCORD_GUILD_ID before registering commands.");
}

const response = await fetch(`https://discord.com/api/v10/applications/${applicationId}/guilds/${guildId}/commands`, {
  method: "PUT",
  headers: { Authorization: `Bot ${botToken}`, "Content-Type": "application/json" },
  body: JSON.stringify([
    {
      name: "coach",
      description: "Manage your League voice coach",
      // Guild install, guild context. The coach is not a direct message bot; which
      // channels it may be used in is set in the guild's integration settings.
      integration_types: [0],
      contexts: [0],
      options: [
        { type: 1, name: "setup", description: "Install the LoL Coach Agent on your PC, step by step" },
        { type: 1, name: "connect", description: "Create a code to pair your local LoL Coach Agent" },
        { type: 1, name: "status", description: "Show your LoL Coach Agent and League status" },
      ],
    },
  ]),
});

if (!response.ok) throw new Error(`Discord command registration failed: ${response.status} ${await response.text()}`);
console.log("Registered /coach setup, /coach connect and /coach status for the configured guild.");
