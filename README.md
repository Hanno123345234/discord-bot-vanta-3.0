# 🔥 CYBRANCEE Discord Bot

> Professional moderation bot with comprehensive logging, case management, and fun commands.

## 🚀 Setup

### 1. Install Dependencies
```bash
npm install
```

### 2. Configure Environment
Set `DISCORD_TOKEN` environment variable with your bot token.

Optional: Set `PREFIX` (default: `!`)

### 3. Configure Channels
Edit `config.json` with your Discord channel IDs:
- `logChannelId` — General logs
- `modLogChannelId` — Moderation logs
- `auditLogChannelId` — Audit logs
- `rejectedLogChannelId` — Rejected actions
- `welcomeChannelId` — Welcome/leave messages

## ▶️ Run
```bash
npm start
```

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
- `!md <user> [page]` — View modlogs (8/page)
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
