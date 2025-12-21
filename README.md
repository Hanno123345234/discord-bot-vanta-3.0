Nova Moderation Bot

Setup

1. Install dependencies:

```bash
npm install
```

2. Set environment variable `DISCORD_TOKEN` with your bot token.

3. (Optional) Set `PREFIX` environment variable (default is `!`).

Run

```bash
npm start
```

Commands

- `!warn <@user|id> [reason]` — warns a user and sends them a DM embed.
- `!ban <@user|id> [reason]` — bans a user (by mention or ID) and DMs them if possible.
- `!unban <id>` — unbans a user by ID.
- `!mute <@user|id> <minutes>` — timeouts a user for minutes (defaults to 1 minute).
- `!unmute <@user|id>` — removes timeout.
- `-blacklist <id> [reason]` — blacklists an ID and attempts to ban across current guild (records in `blacklist.json`).

Notes

- The bot requires the appropriate permissions: `Ban Members` for ban/unban/blacklist, `Moderate Members` for mute/unmute, and `Manage Messages` for warns (you can adjust checks in `index.js`).
- Keep your bot token secret. Use environment variables or a secrets manager.
