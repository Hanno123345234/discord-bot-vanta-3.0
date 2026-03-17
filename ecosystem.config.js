module.exports = {
  apps: [{
    name: "VantaBot",
    script: "./index.js",
    cwd: "/opt/vantabot",
    env: {
      NODE_ENV: "production",
      // Do NOT put your real token here in the repo.
      // Set DISCORD_TOKEN in the VM environment before starting pm2.
      DISCORD_TOKEN: "REPLACE_WITH_ENV",
      DISCORD_CLIENT_ID: "REPLACE_WITH_ENV",
      DISCORD_CLIENT_SECRET: "REPLACE_WITH_ENV",
      DISCORD_REDIRECT_URI: "REPLACE_WITH_ENV",
      SCRIMS_GUILD_ID: "REPLACE_WITH_ENV"
    },
    watch: false,
    max_restarts: 10,
    autorestart: true
  }]
};
