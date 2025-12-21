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

      console.log(`Ready — ${client.user.tag}`);
    } catch (e) {
      console.error('ready.ticket error', e);
    }
  }
};
