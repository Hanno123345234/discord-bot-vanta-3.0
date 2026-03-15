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
- Alternative env vars (for hosting panels): `TOKEN`, `TOKENSP`, `DISCORD_BOT_TOKEN`, `BOT_TOKEN`, or `GIT_ACCESS_TOKEN`
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
- `joinLogChannelId` — Join logs
- `leaveLogChannelId` — Leave logs

Optional:
- `memberRoleId` — Auto role for new members
- `guilds.<guildId>.<key>` — Per-server overrides (e.g. different log channels per server)

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

## 📋 Commands

### General
- `!help` — Show all commands
- `!say <text>` — Bot repeats message
- `!rules` — Display server rules
- `!dash` — Open CYBRANCEE panel link

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
- `-destaffban` is treated the same as `-destaff` (no ban)

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

## 🌐 Deploy Scrims Website (GitHub + Render)

The Scrims UI is in `web/scrims` and is ready for Render Static hosting.

1. Push this project to GitHub.
2. In Render, click **New +** → **Blueprint**.
3. Select your GitHub repository.
4. Render will read `render.yaml` automatically and create the static site.
5. After deploy, open the generated Render URL.

### Git commands (example)

```bash
git add .
git commit -m "Add scrims dashboard and render deployment"
git branch -M main
git remote add origin <YOUR_GITHUB_REPO_URL>
git push -u origin main
```

### Local preview for Scrims page

```bash
npm run scrims:web
```

Then open: `http://localhost:4173`
- For Discord website login, also set these environment variables before starting:
	- `DISCORD_CLIENT_ID`
	- `DISCORD_CLIENT_SECRET`
	- `DISCORD_REDIRECT_URI=http://localhost:4173/auth/discord/callback`
- In the Discord Developer Portal, add the same callback URL under `OAuth2` -> `Redirects`.
- Never commit `config.json` with real IDs to public repos

## 📝 License

MIT License — CYBRANCEE Team 2026

---

**Made with 🔥 for CYBRANCEE**
