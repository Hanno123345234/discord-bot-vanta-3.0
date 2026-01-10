Windows 24/7 hosting (local, free) — quick guide

This repository includes a Windows Service installer using **NSSM** so you can run the bot 24/7 on your PC (auto-start on boot + auto-restart on crash).

Prerequisites
- Node.js installed (LTS recommended).
- A Windows account with Administrator privileges to install services.
- NSSM installed (recommended via Chocolatey).

Install NSSM (one-time)
```powershell
# Run PowerShell as Administrator
choco install nssm -y
```

Steps
1. Install dependencies (in project root):

```powershell
npm install
```

2. Configure environment variables (recommended):
- Set `DISCORD_TOKEN` (preferred) or `TOKEN` / `TOKENSP` / `DISCORD_BOT_TOKEN` / `BOT_TOKEN` / `GIT_ACCESS_TOKEN`.
- You can use Windows System Environment variables, or create a `.env` file (dotenv is already included).
- Copy `config.example.json` to `config.json` and fill in your channel IDs.

3. Install service (run as Administrator in PowerShell/Command Prompt):

```powershell
# from project root
npm run install-service
```

This will:
- Copy the bot to `C:\VantaBot`
- Run `npm install` in `C:\VantaBot`
- Install a Windows service named `VantaBot`
- Prompt you for `DISCORD_TOKEN` (hidden input)
- Start the service (auto-start on boot + auto-restart on crash)

4. Uninstall service (if needed, run as Administrator):

```powershell
npm run uninstall-service
```

Notes and troubleshooting
- Logs: check `C:\VantaBot\logs\out.log` and `C:\VantaBot\logs\err.log`.
- If the service fails to start, run `node index.js` manually to see any errors, then fix env/config.
- Make sure the bot user has `Send Messages` permission in the Discord channel where you expect logs.

Alternative: If you prefer not to install a service, you can use Task Scheduler or run the bot in WSL with `pm2`. If you want one of those, tell me and I'll add instructions.

Cybrancee / Pterodactyl Panel
- Startup command: `npm start` (or `node index.js`)
- Put your Discord bot token into the panel variable you have available:
	- If the panel only provides **"GIT ACCESS TOKEN"**, paste your Discord bot token there (it becomes `GIT_ACCESS_TOKEN`).
	- Otherwise use `DISCORD_TOKEN` (or `TOKEN`).
- Restart the server after changing Startup variables.
