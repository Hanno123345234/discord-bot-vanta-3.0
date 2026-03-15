const { EmbedBuilder, ApplicationCommandOptionType } = require('discord.js');
const path = require('path');
const fs = require('fs');
const CLAIMING_CONFIG = require('../claiming.config');

const DATA_DIR = path.join(__dirname, '..');
const SESSIONS_REMINDERS_PATH = path.join(DATA_DIR, 'sessions_reminders.json');
const SQLITE_DB_PATH = path.join(DATA_DIR, 'vanta_bot.sqlite');

function loadJson(p, fallback) {
  try { if (!fs.existsSync(p)) return fallback; return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return fallback; }
}
function saveJson(p, obj) { fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8'); }

function listPersistedReminders() {
  // prefer sqlite if present
  try {
    const sqlite3 = require('sqlite3').verbose();
    if (fs.existsSync(SQLITE_DB_PATH)) {
      const db = new sqlite3.Database(SQLITE_DB_PATH);
      return new Promise((resolve) => db.all('SELECT * FROM reminders', [], (err, rows) => { if (err) return resolve([]); resolve(rows || []); }));
    }
  } catch (e) {}
  return Promise.resolve(loadJson(SESSIONS_REMINDERS_PATH, []));
}

function removePersistedReminder(id) {
  try {
    const sqlite3 = require('sqlite3').verbose();
    if (fs.existsSync(SQLITE_DB_PATH)) {
      const db = new sqlite3.Database(SQLITE_DB_PATH);
      db.run('DELETE FROM reminders WHERE id = ?', [id]);
      return true;
    }
  } catch (e) {}
  const all = loadJson(SESSIONS_REMINDERS_PATH, []);
  const filtered = all.filter(r => r.id !== id);
  saveJson(SESSIONS_REMINDERS_PATH, filtered);
  return true;
}

module.exports = {
  name: 'session',
  description: 'Session system: create/list/cancel/remindnow/watch/simulate/panel/logs/migrate',
  data: {
    name: 'session',
    description: 'Session system commands',
    options: [
      { name: 'create', type: ApplicationCommandOptionType.Subcommand, description: 'Create a session announcement', options: [
        { name: 'type', type: ApplicationCommandOptionType.String, description: 'alpha|beta', required: true, choices: [{name:'alpha',value:'alpha'},{name:'beta',value:'beta'}] },
        { name: 'registration_time', type: ApplicationCommandOptionType.String, description: 'Unix timestamp', required: true },
        { name: 'game_time', type: ApplicationCommandOptionType.String, description: 'Unix timestamp', required: true },
        { name: 'staff', type: ApplicationCommandOptionType.User, description: 'Staff in charge', required: true },
        { name: 'links', type: ApplicationCommandOptionType.String, description: 'Rule links', required: false }
      ] },
      { name: 'list', type: ApplicationCommandOptionType.Subcommand, description: 'List scheduled reminders' },
      { name: 'cancel', type: ApplicationCommandOptionType.Subcommand, description: 'Remove a reminder', options: [ { name: 'id', type: ApplicationCommandOptionType.String, description: 'Reminder ID', required: true } ] },
      { name: 'remindnow', type: ApplicationCommandOptionType.Subcommand, description: 'Send a reminder immediately', options: [ { name: 'id', type: ApplicationCommandOptionType.String, description: 'Reminder ID', required: true } ] },
      { name: 'watch', type: ApplicationCommandOptionType.SubcommandGroup, description: 'Manage watched channels', options: [
        { name: 'add', type: ApplicationCommandOptionType.Subcommand, description: 'Add channel to watch', options: [ { name: 'channel', type: ApplicationCommandOptionType.Channel, description: 'Channel', required: true } ] },
        { name: 'remove', type: ApplicationCommandOptionType.Subcommand, description: 'Remove channel from watch', options: [ { name: 'channel', type: ApplicationCommandOptionType.Channel, description: 'Channel', required: true } ] }
      ] },
      { name: 'simulate', type: ApplicationCommandOptionType.Subcommand, description: 'Simulate a channel message for E2E testing', options: [
        { name: 'channel', type: ApplicationCommandOptionType.Channel, description: 'Channel', required: true },
        { name: 'content', type: ApplicationCommandOptionType.String, description: 'Message content', required: true }
      ] }
      ,{ name: 'panel', type: ApplicationCommandOptionType.Subcommand, description: 'Post an admin panel to manage sessions', options: [
        { name: 'channel', type: ApplicationCommandOptionType.Channel, description: 'Channel to post panel into', required: false }
      ] },
      { name: 'logs', type: ApplicationCommandOptionType.Subcommand, description: 'Show recent session logs', options: [
        { name: 'count', type: ApplicationCommandOptionType.Integer, description: 'How many entries (1-20)', required: false, min_value: 1, max_value: 20 }
      ] },
      { name: 'migrate', type: ApplicationCommandOptionType.Subcommand, description: 'Migrate reminders between sqlite and json', options: [
        { name: 'target', type: ApplicationCommandOptionType.String, description: 'Target storage', required: true, choices: [{ name: 'sqlite', value: 'sqlite' }, { name: 'json', value: 'json' }] }
      ] }
    ]
  },

  async execute(interaction) {
    try {
      // If no subcommand provided, show help
      const maybeSub = (() => { try { return interaction.options.getSubcommand(false); } catch (e) { return null; } })();
      if (!maybeSub) {
        const help = new EmbedBuilder()
          .setTitle('Session System — Help')
          .setColor(0x87CEFA)
          .setDescription('Available commands:')
          .addFields(
            { name: '/session create', value: 'Create a session announcement (Admin)', inline: false },
            { name: '/session list', value: 'List scheduled reminders (Staff/Admin)', inline: false },
            { name: '/session cancel <id>', value: 'Remove a reminder (Admin)', inline: false },
            { name: '/session remindnow <id>', value: 'Send a reminder immediately (Admin)', inline: false },
            { name: '/session watch add/remove <channel>', value: 'Manage watched channels (Admin)', inline: false },
            { name: '/session migrate sqlite|json', value: 'Migrate persistence between SQLite and JSON (Admin)', inline: false },
            { name: '/session logs [count]', value: 'Show recent log entries (Staff/Admin)', inline: false },
            { name: '/session simulate', value: 'Simulate a channel message for E2E testing (Admin)', inline: false }
          )
          .setTimestamp();
        return interaction.reply({ embeds: [help], ephemeral: true });
      }

      if (interaction.options.getSubcommand(false) === 'create') {
        const type = interaction.options.getString('type', true);
        const regTime = interaction.options.getString('registration_time', true);
        const gameTime = interaction.options.getString('game_time', true);
        const staff = interaction.options.getUser('staff', true);
        const linksRaw = interaction.options.getString('links') || 'See session rules channels in server.';
        const links = linksRaw.split(',').map(l => l.trim()).slice(0, 3).join(', ');
        const regTs = parseInt(regTime, 10);
        const gameTs = parseInt(gameTime, 10);
        if (isNaN(regTs) || isNaN(gameTs)) return interaction.reply({ content: 'Invalid timestamps.', ephemeral: true });
        const sessionLabel = type === 'alpha' ? '<:alpha:1433978499601006725>' : ':beta~1:';
        // prefer the shared announcement builder to keep formatting consistent
        let saBuilder = null;
        try { saBuilder = require(path.join(DATA_DIR, 'commands', 'sa.js')); } catch (e) { saBuilder = null; }
        let content = `### Duo Practice Session ${sessionLabel}\n\n> * **Registration Opens:** <t:${regTs}:t>\n> * **Game 1/3:** <t:${gameTs}:t>\n\nStaff in charge: <@${staff.id}>\n\n${links}`;
        if (saBuilder && typeof saBuilder.buildAnnouncement === 'function') {
          try {
            content = saBuilder.buildAnnouncement({ mode: type, regTs, gameTs, staffMentions: `<@${staff.id}>`, includeEveryone: true });
          } catch (e) {}
        } else {
          // append everyone mention as original behaviour
          content = content + "\n\n@everyone";
        }
        await interaction.reply({ content, allowedMentions: { parse: ['users','roles'], everyone: true } });
        // Also emit a fake message into the default alpha/beta channel so the messageCreate handler
        // will parse it and post the claim/announce embed there.
        try {
          const targetId = String(CLAIMING_CONFIG.channels.announceNormal);
          const targetCh = await interaction.client.channels.fetch(targetId).catch(()=>null);
          const fakeChannel = targetCh || interaction.channel;
          const fakeMsg = {
            id: `slash_sim_${Date.now()}`,
            author: interaction.user,
            content,
            channel: fakeChannel,
            guildId: (fakeChannel && fakeChannel.guild && fakeChannel.guild.id) ? String(fakeChannel.guild.id) : (interaction.guildId || null),
            createdAt: new Date(),
            react: async () => {}
          };
          fakeMsg._isSeed = true;
          // emit so index.js handler treats it the same as a posted announcement
          interaction.client.emit('messageCreate', fakeMsg);
        } catch (e) {}
        return;
      }

      const sub = interaction.options.getSubcommand(true);
        if (sub === 'list') {
        const rows = await listPersistedReminders();
        if (!rows || !rows.length) return interaction.reply({ content: 'No scheduled reminders found.', ephemeral: true });
        const parts = (rows||[]).slice(0, 20).map(r => `• ${r.id} — <@${r.userId}> — <t:${Math.floor(r.sendAt/1000)}:t> — session ${r.sessionIndex}`);
        return interaction.reply({ content: parts.join('\n'), ephemeral: true });
      }
      if (sub === 'cancel') {
        const id = interaction.options.getString('id', true);
        const ok = removePersistedReminder(id);
        return interaction.reply({ content: ok ? `Reminder ${id} removed.` : `Reminder ${id} not found.`, ephemeral: true });
      }
      if (sub === 'remindnow') {
        const id = interaction.options.getString('id', true);
        const rows = await listPersistedReminders();
        const rem = (rows||[]).find(r => r.id === id);
        if (!rem) return interaction.reply({ content: 'Reminder not found.', ephemeral: true });
        try {
          const u = await interaction.client.users.fetch(String(rem.userId)).catch(()=>null);
          if (u) await u.send(rem.content || `Reminder for session ${rem.sessionIndex}`);
        } catch (e) {}
        return interaction.reply({ content: `Reminder ${id} sent.`, ephemeral: true });
      }
      if (sub === 'add' || sub === 'remove') {
        // these are inside the group, fetch parent option group
        const group = interaction.options.getSubcommandGroup(false);
      }

      // watch add/remove handled via getting the nested subcommands
      const group = interaction.options.getSubcommandGroup(false);
      if (group === 'watch') {
        const op = interaction.options.getSubcommand(true); // add/remove
        const ch = interaction.options.getChannel('channel', true);
        // call index.js helper via client: we can send a small internal signal by writing the file directly
        const sessionsWatchPath = path.join(DATA_DIR, 'sessions_watch.json');
        let all = loadJson(sessionsWatchPath, {});
        const gid = String(interaction.guildId || 'global');
        if (!all[gid]) all[gid] = [];
          if (op === 'add') {
          if (!all[gid].includes(String(ch.id))) all[gid].push(String(ch.id));
          saveJson(sessionsWatchPath, all);
          return interaction.reply({ content: `Channel <#${ch.id}> is now being watched.`, ephemeral: true });
        } else {
          all[gid] = all[gid].filter(x => x !== String(ch.id));
          saveJson(sessionsWatchPath, all);
          return interaction.reply({ content: `Channel <#${ch.id}> removed from watch.`, ephemeral: true });
        }
      }

      if (sub === 'simulate') {
        const ch = interaction.options.getChannel('channel', true);
        const content = interaction.options.getString('content', true);
        // Build a lightweight fake message object and emit it so index.js handler processes it
        const fakeMsg = {
          id: `sim_${Date.now()}`,
          author: interaction.user,
          content,
          channel: ch,
          createdAt: new Date(),
          react: async () => {},
          _isSeed: true
        };
        try {
          interaction.client.emit('messageCreate', fakeMsg);
          return interaction.reply({ content: 'Simulation sent — check DMs/Logs.', ephemeral: true });
        } catch (e) {
          return interaction.reply({ content: 'Simulation failed: ' + String(e), ephemeral: true });
        }
      }

      if (sub === 'panel') {
        // Post an admin control panel embed with buttons into the configured channel (or default)
        const ch = interaction.options.getChannel('channel') || null;
        const targetId = ch ? ch.id : '1465130887716012117';
        try {
          const target = await interaction.client.channels.fetch(targetId).catch(()=>null);
          if (!target || !target.isTextBased()) return interaction.reply({ content: 'Target channel not accessible or not a text channel.', ephemeral: true });
          const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
          const embed = new EmbedBuilder()
            .setTitle('Session Admin Panel')
            .setColor(0x87CEFA)
            .setDescription('Controls to manage scheduled session reminders and posts. Use the buttons below.\n\n- **List Reminders** shows upcoming scheduled reminders.\n- **Reschedule All** re-schedules persisted reminders into timeouts.\n- **Purge JSON** clears JSON reminders storage (does not touch SQLite).\n- **Close Panel** removes this panel message.')
            .setTimestamp();
          const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('admin_list').setLabel('List Reminders').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('admin_reschedule').setLabel('Reschedule All').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId('admin_purge_json').setLabel('Purge JSON Reminders').setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId('admin_close').setLabel('Close Panel').setStyle(ButtonStyle.Secondary)
          );
          await target.send({ embeds: [embed], components: [row] });
          return interaction.reply({ content: `Admin panel posted in ${target}.`, ephemeral: true });
        } catch (e) {
          console.error('failed to post admin panel', e);
          return interaction.reply({ content: 'Failed to post admin panel.', ephemeral: true });
        }
      }

      // logs support via textual subcommand: /session logs count:nn (not defined as option earlier) - fallback
      if (sub === 'logs') {
        const count = 10;
        try {
          const LOG_CHANNEL_ID = '1461475110761533451';
          const ch = await interaction.client.channels.fetch(LOG_CHANNEL_ID).catch(()=>null);
          if (!ch || !ch.isTextBased()) return interaction.reply({ content: 'Log-Kanal nicht zugreifbar.', ephemeral: true });
          const msgs = await ch.messages.fetch({ limit: count });
          const out = Array.from(msgs.values()).slice(0, count).map(m => `• ${m.author?.tag || m.author?.id || 'bot'} — ${m.createdAt.toISOString()} — ${m.embeds?.[0]?.title || m.content || '[embed]'}`);
          return interaction.reply({ content: out.join('\n') || 'No logs found.', ephemeral: true });
        } catch (e) {
          return interaction.reply({ content: 'Failed to read logs.', ephemeral: true });
        }
      }
      return interaction.reply({ content: 'Unknown subcommand.', ephemeral: true });
    } catch (e) {
      console.error('commands/session execute failed', e);
      try { await interaction.reply({ content: 'Error executing the command.', ephemeral: true }); } catch (e) {}
    }
  }
};