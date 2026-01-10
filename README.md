# 🔥 CYBRANCEE Discord Bot

> Minimal Discord bot (ping command).

## 🚀 Setup

### 1. Install Dependencies
```bash
npm install
```

### 2. Configure Environment
Set your bot token via:
- Environment variable: `TOKEN`

Optional: Set `PREFIX` (default: `!`).

### 3. Configure Channels
Not required for the minimal ping bot.

## ▶️ Run
```bash
npm start
```

## 🖥️ Cybrancee / Pterodactyl Panel

- Startup command: `npm start` (or `node index.js`)
- Set `TOKEN` in Startup/Environment to your Discord bot token
- Restart the server after changing Startup variables

### Quick Deploy Steps

1) **Upload/Clone the repo** into your server (Git option in the panel).
2) **Install deps** (most Node eggs do this automatically on first start). If not, run: `npm install`.
3) **Set token in Startup/Environment**:
	 - `TOKEN`
4) **Start/Restart** the server.

### Required Discord Setup

- Enable **Message Content Intent** in the Discord Developer Portal (Bot settings)

### Security Notes

- Never put your bot token into `config.json` and never commit/push `.env`.
- If a token was ever pasted in chat or leaked, regenerate it in the Developer Portal.

## 📋 Commands

- `!ping` — Replies with `Pong!`

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
