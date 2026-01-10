# 🔥 CYBRANCEE Discord Bot

> Professional moderation bot with comprehensive logging, case management, and fun commands.

## 🚀 Setup

### 1. Install Dependencies
```bash
npm install
```

### 2. Configure Environment
Set a bot token via **one** of these options:
- Environment variable: `DISCORD_TOKEN` (preferred)
- Alternative env vars (for hosting panels): `TOKEN`, `DISCORD_BOT_TOKEN`, `BOT_TOKEN`, or `GIT_ACCESS_TOKEN`
- Upload `token.txt` into the project root (file must contain **only** the token)

Optional: Set `PREFIX` (default: `!`)

### 3. Configure Channels
Edit `config.json` with your Discord channel IDs:
- `logChannelId` — General logs
- `moderationLogChannelId` — Moderation logs (preferred)
- `modLogChannelId` — Moderation logs (fallback)
- `auditLogChannelId` — Audit logs
- `rejectedLogChannelId` — Rejected actions
- `welcomeChannelId` — Welcome/leave messages

## ▶️ Run
```bash
npm start
```

## 🖥️ Cybrancee / Pterodactyl Panel

- Startup command: `npm start` (or `node index.js`)
- Put your Discord bot token into the panel variable you have available:
	- If the panel only provides **"GIT ACCESS TOKEN"**, paste your Discord bot token there (it becomes `GIT_ACCESS_TOKEN`).
	- Otherwise use `DISCORD_TOKEN` (or `TOKEN`).
- Restart the server after changing Startup variables.

### Quick Deploy Steps

1) **Upload/Clone the repo** into your server (Git option in the panel).
2) **Install deps** (most Node eggs do this automatically on first start). If not, run: `npm install`.
3) **Set token in Startup/Environment** (one of these):
	 - `DISCORD_TOKEN` (preferred)
	 - `TOKEN`, `DISCORD_BOT_TOKEN`, `BOT_TOKEN`
	 - If your panel only shows **"GIT ACCESS TOKEN"**, use that (becomes `GIT_ACCESS_TOKEN`).
4) **Configure channels** in `config.json` (server file manager):
	 - `welcomeChannelId`, `rulesChannelId`
	 - `joinLogChannelId`, `leaveLogChannelId`, `messageLogChannelId`
	 - `moderationLogChannelId` (moderation logs)
5) **Start/Restart** the server.

### Required Discord Setup

- Enable **Privileged Gateway Intents** in the Discord Developer Portal (Bot settings):
	- Server Members Intent
	- Message Content Intent
- Ensure the bot role has permissions in the target log channels (Send Messages, Embed Links).

### Security Notes

- Never put your bot token into `config.json` and never commit/push `.env`.
- If a token was ever pasted in chat or leaked, regenerate it in the Developer Portal.

## 📋 Commands

### General
- `!help` — Show all commands
- `!say <text>` — Bot repeats message
- `!rules` — Display server rules

### Moderation
- `!warn <user> [reason]` — Warn a user
- `!ban <user> [reason]` — Ban a user
- `!unban <id>` — Unban a user
- `!mute <user> <minutes>` — Timeout user
- `!unmute <user>` — Remove timeout
- `!role <user> <role>` — Assign role

### Logs & History
- `!md <user> [page]` — View modlogs (5/page)
- `!mds <user> [page]` — View destaff logs (8/page)

### Management
- `-purg <count> [user]` — Purge messages
- `!del <channel>` — Delete channel (with confirmation)

### Blacklist
- `-blacklist <id> [reason]` — Add to blacklist
- `-unbll <id>` — Remove from blacklist
- `-bll` — View blacklist logs

### Destaff
- `-destaff <user> [reason]` — Remove staff roles
- `-destaffban <user> [reason]` — Remove staff roles + ban

### Modlog Editing
- `*reason <caseId> <text>` — Update case reason
- `*duration <caseId> <time>` — Update case duration
- `*moderations <userId>` — Show all moderations
- `*case <caseId>` — Show case details

### Fun Commands
- `!8ball` — Magic 8Ball
- `!flip` — Coin flip
- `!dice [1-100]` — Roll dice
- `!rate [@user]` — Rate someone
- `!joke` — Dev jokes
- `!compliment [@user]` — Give compliments

### Tickets
- `!ticket` — Create support ticket
- `!close` — Close ticket (staff only)

## 🔒 Permissions

- **Ban/Unban/Blacklist:** Requires `Ban Members`
- **Mute/Unmute:** Requires `Moderate Members`
- **Warn:** Requires `Manage Messages`
- **Role Management:** Requires `Manage Roles`
- **Channel Deletion:** Requires `Manage Channels`
- **Modlog Editing:** Requires `Manage Guild`

## 📁 File Structure

- `modlogs.json` — Case tracking (warns, bans, mutes)
- `destaffs.json` — Destaff action logs
- `blacklist.json` — Blacklisted users
- `config.json` — Channel IDs and settings
- `utils/logger.js` — Multi-channel logging system
- `utils/transcript.js` — Ticket transcript generator

## 🛡️ Security

- Keep your bot token secret
- Use environment variables or `.env` file
- Never commit `config.json` with real IDs to public repos

## 📝 License

MIT License — CYBRANCEE Team 2026

---

**Made with 🔥 for CYBRANCEE**
