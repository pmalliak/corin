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

On that strip enable only **B1**. Point the ChatGPT app's **microphone** at **Voicemeeter Out B1 (VB-Audio Voicemeeter VAIO)**. Do not send this strip to your speakers.

### ChatGPT → Discord

Point the ChatGPT app's **speakers** at **Voicemeeter AUX Input (VB-Audio Voicemeeter VAIO)**. On the AUX virtual-input strip enable only **B2** (and disable B1).

Create a VBAN **OUT** stream:

| Setting | Value |
| --- | --- |
| Stream name | `GPT_TO_CORIN` |
| IP | `127.0.0.1` |
| Port | `6981`, and the panel has no field for it, see below |
| Source | B2 |
| Format | 48 kHz / Stereo / PCM 16-bit |

This separation keeps ChatGPT's answer out of its own microphone and avoids a feedback loop. Use headphones for your own Discord client, and tell channel members that their audio is passed to ChatGPT.

### Point the ChatGPT app at those devices

The exact endpoint names come from the installed VB-Audio driver and are worth reading off the machine rather than copying from a guide. This build of the VAIO driver exposes one capture endpoint per bus, which is a gift: pick `B1` by name instead of guessing which "Voicemeeter Output" is which.

```powershell
Get-PnpDevice -Class AudioEndpoint -Status OK | Select-Object -ExpandProperty FriendlyName | Sort-Object
```

Two settings, and they must not be the same device or ChatGPT hears itself:

| ChatGPT setting | Device | What it is |
| --- | --- | --- |
| Microphone | `Voicemeeter Out B1 (VB-Audio Voicemeeter VAIO)` | bus B1, fed by the VBAN IN strip, so it carries Discord |
| Speakers | `Voicemeeter AUX Input (VB-Audio Voicemeeter VAIO)` | the AUX strip, which is routed to B2 and out over VBAN |

The ChatGPT desktop app is a Store package running as a swarm of processes, so if it offers no device picker of its own, override it in Windows instead: **Settings → System → Sound → Volume mixer** (or `Win+Ctrl+V`) while a voice session is live, find ChatGPT in the app list, and set its input and output there. A per-app override survives the app restarting and leaves the system defaults alone, which matters because your own Discord client should stay on your headset.

### The destination port is not in the VBAN panel

The `UDP Port` box at the top of the VBAN window is the port Voicemeeter **listens on**. The port an outgoing stream **sends to** is a per stream value that the panel does not draw a column for, and it defaults to 6980. An out stream aimed at 127.0.0.1:6980 therefore talks to Voicemeeter's own receiver, and the panel gives the tell: the incoming header counts a stream you never configured, so `1 Streams Detected` becomes `2 Streams Detected`.

Two ways to reach that value.

**Through the Remote API**, which is scriptable and exact. `VoicemeeterRemote64.dll` ships with Voicemeeter and exposes `vban.outstream[i].port` alongside `.name`, `.ip`, `.on` and `.route`. Turn the stream off, set the values, turn it back on:

```powershell
$d = 'C:\Program Files (x86)\VB\Voicemeeter\VoicemeeterRemote64.dll'
Add-Type -TypeDefinition @"
using System.Runtime.InteropServices; using System.Text;
public static class VM {
  [DllImport(@"$d")] public static extern int VBVMR_Login();
  [DllImport(@"$d")] public static extern int VBVMR_Logout();
  [DllImport(@"$d", CharSet=CharSet.Ansi)] public static extern int VBVMR_SetParameterFloat(string n, float v);
  [DllImport(@"$d", CharSet=CharSet.Ansi)] public static extern int VBVMR_SetParameterStringA(string n, string v);
  [DllImport(@"$d", CharSet=CharSet.Ansi)] public static extern int VBVMR_GetParameterStringA(string n, StringBuilder v);
}
"@
[void][VM]::VBVMR_Login()
[void][VM]::VBVMR_SetParameterFloat("vban.outstream[0].on", 0)
[void][VM]::VBVMR_SetParameterStringA("vban.outstream[0].name", "GPT_TO_CORIN")
[void][VM]::VBVMR_SetParameterFloat("vban.outstream[0].port", 6981)
[void][VM]::VBVMR_SetParameterFloat("vban.outstream[0].on", 1)
[void][VM]::VBVMR_Logout()
```

**Or through the panel's own buttons.** `Save Config`, edit `port='6980'` to `port='6981'` on the `VBANStreamOut` line, `Load Config`.

The same API reads back, which is the only way to see what the GUI hides. It is worth doing after any hand edit, because the stream name is the other invisible trap: a name typed with a leading space arrives as `" GPT_TO_CORIN"`, the panel renders it identically to the correct one, and `#read` drops every packet because it compares the 16 byte name field exactly.

### Check the Voicemeeter side without clicking through the GUI

Voicemeeter writes its whole state to XML, so the VBAN panel can be read instead of eyeballed. `status='1'` means the stream is on, `status='0'` means it is off and nothing moves.

```bash
grep -oE "<VBANStream(In|Out)[^>]*status='1'[^>]*>" \
  "$USERPROFILE/Documents/Voicemeeter/VoicemeeterBanana_TodaySettings.xml"
```

Three things have to line up with `.env`, and each one fails silently on its own:

- **The names match exactly.** `sendPcm` stamps `CORIN_TO_GPT` into every packet it sends, and `#read` throws away any packet whose name is not `GPT_TO_CORIN`. A single transposed letter in the Voicemeeter stream name looks like total silence, with no error anywhere.
- **The out stream points at 6981, not 6980.** 6980 is Voicemeeter's own receiver. An out stream aimed there talks to itself and the bridge never sees a packet.
- **Both streams are on.** A stream that is configured perfectly but left at `status='0'` behaves exactly like a wrong one.

The file is the last saved state, not necessarily the live one. Treat a mismatch as a lead to check in the GUI, not as proof.

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
