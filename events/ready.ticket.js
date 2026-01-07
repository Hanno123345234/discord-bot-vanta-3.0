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

      // Register ticket command. If TEST_GUILD_ID or config.testGuildId is set, register to that guild (fast); otherwise register globally (may take up to 1 hour).
      const ticketCmd = require(path.join(DATA_DIR, 'commands', 'ticket.js'));
      const testGuildId = process.env.TEST_GUILD_ID || config.testGuildId || null;
      if (client.application) {
        if (testGuildId) {
          try {
            const guild = await client.guilds.fetch(testGuildId);
            await guild.commands.set([ticketCmd.data]);
            console.log(`Ticket command registered to test guild ${testGuildId}.`);
          } catch (e) {
            console.warn('Failed to register ticket command to test guild', testGuildId, e);
          }
        } else {
          try {
            await client.application.commands.set([ticketCmd.data]);
            console.log('Ticket command registered globally (may take some time to appear).');
          } catch (e) {
            console.warn('Failed to register ticket command via application.commands.set()', e);
          }
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
              .setDescription('Wähle den Ticket-Typ aus, um ein Ticket zu öffnen.')
              .setColor(0x8A2BE2);

            const menu = new StringSelectMenuBuilder()
              .setCustomId('ticket_create')
              .setPlaceholder('Wähle einen Ticket-Typ')
              .addOptions([
                { label: 'Support', value: 'support', description: 'Allgemeine Hilfe', emoji: '🛠️' },
                { label: 'Bug', value: 'bug', description: 'Fehler melden', emoji: '🐛' },
                { label: 'Bewerbung', value: 'apply', description: 'Bewerbung einreichen', emoji: '💼' }
              ]);

            const row = new ActionRowBuilder().addComponents(menu);
            const pingRoleId = process.env.TICKET_PING_ROLE || config.pingRoleId || '1344391422954176634';
            const content = `Bitte erstelle ein Ticket, indem du unten den Typ auswählst. <@&${pingRoleId}>`;
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
