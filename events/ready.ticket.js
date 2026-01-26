const fs = require('fs');
const path = require('path');

module.exports = {
  name: 'ready.ticket',
  once: true,
  async execute(client) {
    try {
      const DATA_DIR = path.resolve(__dirname, '..');
      const cfgPath = path.join(DATA_DIR, 'config.json');
      const examplePath = path.join(DATA_DIR, 'config.example.json');
      let config = {};
      if (fs.existsSync(cfgPath)) config = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      else if (fs.existsSync(examplePath)) config = JSON.parse(fs.readFileSync(examplePath, 'utf8'));

      // ensure transcript folder exists
      const tFolder = config.transcriptFolder || 'transcripts';
      const tPath = path.join(DATA_DIR, tFolder);
      if (!fs.existsSync(tPath)) fs.mkdirSync(tPath, { recursive: true });

      // Register slash commands.
      // - Guild registration appears instantly.
      // - Global registration can take up to ~1 hour to show up.
      const ticketCmd = require(path.join(DATA_DIR, 'commands', 'ticket.js'));
      const adminCmd = require(path.join(DATA_DIR, 'commands', 'admin.js'));
      const saCmd = require(path.join(DATA_DIR, 'commands', 'sa.js'));
      // session command (creates Duo Practice Session announcements)
      let sessionCmd = null;
      try { sessionCmd = require(path.join(DATA_DIR, 'commands', 'session.js')); } catch (e) { /* ignore if missing */ }
      let createCmd = null;
      try { createCmd = require(path.join(DATA_DIR, 'commands', 'create.js')); } catch (e) { /* ignore */ }
      const slashCommands = [ticketCmd.data, adminCmd.data, saCmd.data].concat(sessionCmd && sessionCmd.data ? [sessionCmd.data] : []).concat(createCmd && createCmd.data ? [createCmd.data] : []);
      const testGuildId = process.env.TEST_GUILD_ID || config.testGuildId || null;

      async function upsertGuildSlashCommands(guild) {
        if (!guild || !guild.commands) return;
        const existing = await guild.commands.fetch().catch(() => null);
        for (const cmd of slashCommands) {
          try {
            const found = existing ? existing.find(c => c && c.name === cmd.name) : null;
            if (found) await guild.commands.edit(found.id, cmd);
            else await guild.commands.create(cmd);
          } catch (e) {
            console.warn(`Failed to upsert guild command ${cmd && cmd.name ? cmd.name : 'unknown'} in ${guild.id}`, e);
          }
        }
      }

      const immediateGuildIds = new Set();
      if (testGuildId) immediateGuildIds.add(String(testGuildId));
      if (config && config.guilds && typeof config.guilds === 'object') {
        for (const gid of Object.keys(config.guilds)) immediateGuildIds.add(String(gid));
      }

      // Also include the fixed target servers used for cross-server commands.
      const targetGuildIds = [
        '1459330497938325676',
        '1459345285317791917',
        '1368527215343435826',
        '1339662600903983154',
      ];
      for (const gid of targetGuildIds) immediateGuildIds.add(String(gid));

      // Also upsert to all currently cached guilds (so commands show up immediately everywhere).
      if (client.guilds && client.guilds.cache) {
        for (const [gid] of client.guilds.cache) immediateGuildIds.add(String(gid));
      }

      // Guild deploy for immediate visibility.
      for (const gid of immediateGuildIds) {
        try {
          const guild = client.guilds.cache.get(gid) || await client.guilds.fetch(gid).catch(() => null);
          if (!guild) continue;
          await upsertGuildSlashCommands(guild);
          console.log(`Slash commands upserted to guild ${guild.id}.`);
        } catch (e) {
          console.warn(`Failed to upsert slash commands to guild ${gid}`, e);
        }
      }

      // Optional global deploy (slow to propagate).
      if (client.application) {
        try {
          await client.application.commands.set(slashCommands);
          console.log('Slash commands registered globally (may take some time to appear).');
        } catch (e) {
          console.warn('Failed to register slash commands via application.commands.set()', e);
        }
      }

      // Optional: send ticket announcement to a configured channel ID
      const announceChannelId = process.env.TICKET_ANNOUNCE_CHANNEL || config.announceChannelId || config.ticketAnnounceChannelId || null;
      if (announceChannelId) {
        try {
          const ch = await client.channels.fetch(announceChannelId).catch(() => null);
          const isText = ch && (typeof ch.isTextBased === 'function' ? ch.isTextBased() : (ch.isText && ch.isText()));
          if (isText) {
            const { EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder } = require('discord.js');
            const embed = new EmbedBuilder()
              .setTitle('Support Tickets')
              .setDescription('Choose a ticket type to open a ticket.')
              .setColor(0x8A2BE2);

            const menu = new StringSelectMenuBuilder()
              .setCustomId('ticket_create')
              .setPlaceholder('Choose a ticket type')
              .addOptions([
                { label: 'Support', value: 'support', description: 'General help', emoji: '🛠️' },
                { label: 'Bug', value: 'bug', description: 'Report a bug', emoji: '🐛' },
                { label: 'Application', value: 'apply', description: 'Submit an application', emoji: '💼' }
              ]);

            const row = new ActionRowBuilder().addComponents(menu);
            const pingRoleId = process.env.TICKET_PING_ROLE || config.pingRoleId || '1344391422954176634';
            const content = `Please create a ticket by selecting a type below. <@&${pingRoleId}>`;
            await ch.send({ content, embeds: [embed], components: [row], allowedMentions: { roles: [String(pingRoleId)] } }).catch((err) => console.error('Failed to send ticket announcement (send):', err));
            console.log(`Ticket announcement sent to channel ${announceChannelId}.`);
          } else {
            console.warn('Announce channel not found, not text-based, or no permission:', announceChannelId);
          }
        } catch (e) {
          console.error('Failed to send ticket announcement (exception):', e);
        }
      }

      console.log(`Ready — ${client.user.tag}`);
    } catch (e) {
      console.error('ready.ticket error', e);
    }
  }
};
