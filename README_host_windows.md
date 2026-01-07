Windows 24/7 hosting (local, free) — quick guide

This repository includes a Windows Service installer using `node-windows` so you can run the bot 24/7 on your PC.

Prerequisites
- Node.js installed (LTS recommended).
- A Windows account with Administrator privileges to install services.

Steps
1. Install dependencies (in project root):

```powershell
npm install
```

2. Configure environment variables (recommended):
- Set `DISCORD_TOKEN` and any other env vars the bot needs. You can use Windows System Environment variables, or create a `.env` file and use `dotenv` (already in dependencies).

3. Install service (run as Administrator in PowerShell/Command Prompt):

```powershell
# from project root
npm run install-service
```

This will install a Windows service named `VantaBot` and start it. The service will auto-restart on system boot and when the process crashes.

4. Uninstall service (if needed, run as Administrator):

```powershell
npm run uninstall-service
```

Notes and troubleshooting
- Logs: by default `node-windows` writes to Windows Event Log. You can also check the bot's own logs if you add file logging.
- If the service fails to start, run `node index.js` manually to see any errors, then fix env/config.
- Make sure the bot user has `Send Messages` permission in the Discord channel where you expect logs.

Alternative: If you prefer not to install a service, you can use Task Scheduler or run the bot in WSL with `pm2`. If you want one of those, tell me and I'll add instructions.
