# Corin Local

An isolated Discord voice bot that bridges a private voice channel to the **locally running ChatGPT Voice app**. It never calls the OpenAI API and never needs an OpenAI key.

The existing `voice/` Corin host is not used or modified.

## Create and invite the bot

Corin Local is a **second, separate Discord application**, not the one `voice/` uses. Create it in the Developer Portal, then add a bot user and copy its token into `.env`.

Inviting it is a required step and it is easy to get wrong. The install link the Developer Portal offers by default carries `scopes=applications.commands` and `permissions=0`, which adds no bot user to the server and grants no voice permissions. The bridge then logs in fine and sits in zero guilds forever.

Use an invite URL with the `bot` scope and the three permissions the bridge checks:

```
https://discord.com/oauth2/authorize?client_id=YOUR_APPLICATION_ID&scope=bot&permissions=3146752
```

`3146752` is View Channel (1024) + Connect (1048576) + Speak (2097152), exactly the set in `needed` in `src/index.ts`. Nothing else is required: the bridge registers no slash commands and reads no message content.

While you are in the portal, set the same scope and permissions under **Installation**, so the next install link does not repeat the problem.

To confirm the invite landed, ask Discord which servers the bot is in:

```powershell
curl -H "Authorization: Bot $env:DISCORD_BOT_TOKEN" https://discord.com/api/v10/users/@me/guilds
```

An empty `[]` means the bot was never invited. The server you want must appear here with the same id you put in `DISCORD_GUILD_ID`.

## Per channel Connect permission

Being in the server is not enough. Discord resolves voice access **per channel**, and a channel level deny on `@everyone` beats a role that allows Connect everywhere else. A bot that looks correctly set up server wide can still be unable to enter the one channel you are sitting in.

In **One Knight Stands** the picture is:

| Channel | Bot may join | Why |
| --- | --- | --- |
| Gatehouse, Inn, Tavern | yes | no channel level deny |
| Place of Arms, The Great Hall, Armory, Stables | no | `@everyone` is denied Connect, and Connect is handed back only to `Knight`, `Royal Knight`, `Marshal`, `Sergeant`, `Friends` and `Music Bot` |
| The Secret Chamber | no | hidden and denied, only the `Corin` role is allowed in |
| AFK | never | the bridge skips the server's AFK channel on purpose |

The `Corin Local` role appears in none of those allow lists, so if you are talking in The Great Hall the bot stays online and follows nobody. Pick one fix:

- Give the bot the existing `Music Bot` role, which is already allowed in every channel the humans use.
- Or add an allow for Connect to the `Corin Local` role on each channel you want it to follow you into.

The older `voice/` Corin is a **different application** with its own `Corin` role, allowed only in The Secret Chamber. Corin Local inherits none of that.

## Install and start

```powershell
cd corin-local
npm install
Copy-Item .env.example .env
# fill DISCORD_BOT_TOKEN and DISCORD_GUILD_ID
npm start
```

Only one process should use the Corin Local bot token at a time. It follows the permitted voice channel containing the most people. To pin it to just one channel instead, set `CORIN_LOCAL_CHANNEL_ID`.

The bot joins only when a human is **already** in a voice channel it may enter. On an empty server it stays online without joining anything, which is the intended behaviour, not a fault. It leaves again when the last person goes.

## Voicemeeter Banana routing

Open **Menu → VBAN** and turn VBAN on. Keep both streams at **48 kHz, Stereo, PCM 16-bit**.

### Discord → ChatGPT

Create a VBAN **IN** stream:

| Setting | Value |
| --- | --- |
| Stream name | `CORIN_TO_GPT` |
| IP | `127.0.0.1` |
| Port | `6980` |
| Route | an unused input strip |

On that strip enable only **B1**. In ChatGPT Voice select **Voicemeeter Output (VB-Audio Voicemeeter VAIO)** as its microphone/input. Do not send this strip to your speakers.

### ChatGPT → Discord

In ChatGPT Voice select **Voicemeeter AUX Input (VB-Audio Voicemeeter AUX VAIO)** as its speakers/output. On the AUX virtual-input strip enable only **B2** (and disable B1).

Create a VBAN **OUT** stream:

| Setting | Value |
| --- | --- |
| Stream name | `GPT_TO_CORIN` |
| IP | `127.0.0.1` |
| Port | `6981` |
| Source | B2 |
| Format | 48 kHz / Stereo / PCM 16-bit |

This separation keeps ChatGPT's answer out of its own microphone and avoids a feedback loop. Use headphones for your own Discord client, and tell channel members that their audio is passed to ChatGPT.

## What the process does

`Discord audio → PCM mix → VBAN IN → ChatGPT input`

`ChatGPT output → Voicemeeter B2 → VBAN OUT → Discord audio`

The bridge only accepts PCM 16-bit, 48 kHz stereo from Voicemeeter. Those settings are intentional: they match Discord's native decoded audio and avoid resampling.

## When it does not join

Work down this list in order.

**`Corin Local has not been invited to guild <id>.`** The bot is in no server, or not in that one. See "Create and invite the bot" above. This throw happens on ready, so the process dies immediately.

**It is online but never joins a channel.** Check, in this order:

1. Somebody has to be in a voice channel. The bridge picks the permitted channel with the most humans and ignores empty ones.
2. The channel must not be the server's AFK channel. Those are skipped on purpose.
3. The bot needs View Channel, Connect and Speak **on that channel**, not just server wide. This is the usual culprit: see "Per channel Connect permission" above.
4. If `CORIN_LOCAL_CHANNEL_ID` is set, only that one channel is ever considered, and it is ignored unless it is a normal voice channel the bot may enter.
5. `DISCORD_GUILD_ID` has to be the server id, not a channel id. Turn on Developer Mode, right click the server icon, Copy Server ID.

**It joins, then silence in both directions.** That is Voicemeeter, not Discord. Confirm VBAN is on, the stream names match `.env` exactly, and both streams are 48 kHz stereo PCM 16-bit.

**The process starts and exits without a message.** Another copy is probably already logged in with the same token. Discord allows one gateway session per bot token, so stop the old one first.

### Audit what the bot may actually join

This resolves the same three permissions the bridge checks, straight from the API, and prints one line per voice channel. Run it from `corin-local` with `.env` filled in. Git Bash on Windows, so the `tr` strips the CRLF that Notepad leaves behind.

```bash
T=$(grep '^DISCORD_BOT_TOKEN=' .env | cut -d= -f2- | tr -d '\r')
G=$(grep '^DISCORD_GUILD_ID=' .env | cut -d= -f2- | tr -d '\r')
B=$(curl -s -H "Authorization: Bot $T" https://discord.com/api/v10/users/@me | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).id')

for p in "" /channels /roles "/members/$B"; do
  curl -s -H "Authorization: Bot $T" "https://discord.com/api/v10/guilds/$G$p"
  echo
done | node -e '
const [g, ch, roles, me] = require("fs").readFileSync(0, "utf8").split(/\r?\n/).filter(Boolean).map(JSON.parse);
const VIEW = 1n << 10n, CONNECT = 1n << 20n, SPEAK = 1n << 21n, ADMIN = 1n << 3n;
const need = VIEW | CONNECT | SPEAK;
const byId = new Map(roles.map((r) => [r.id, BigInt(r.permissions)]));
const mine = new Set([...(me.roles || []), g.id]);
let base = 0n;
for (const id of mine) base |= byId.get(id) ?? 0n;
for (const c of ch.filter((c) => c.type === 2)) {
  let p = base;
  if (!(base & ADMIN)) {
    const ow = new Map((c.permission_overwrites || []).map((o) => [o.id, o]));
    const every = ow.get(g.id);
    if (every) { p &= ~BigInt(every.deny); p |= BigInt(every.allow); }
    let allow = 0n, deny = 0n;
    for (const id of mine) {
      const o = ow.get(id);
      if (o && id !== g.id) { deny |= BigInt(o.deny); allow |= BigInt(o.allow); }
    }
    p &= ~deny; p |= allow;
    const own = ow.get(me.user.id);
    if (own) { p &= ~BigInt(own.deny); p |= BigInt(own.allow); }
  } else p = -1n;
  const afk = c.id === g.afk_channel_id ? "   (AFK, always skipped)" : "";
  console.log(((p & need) === need ? "OK  #" : "NO  #") + c.name + afk);
}
'
```

`NO` on the channel you actually sit in is the whole answer: fix it in Discord under **Edit Channel → Permissions**, not in this repo.
