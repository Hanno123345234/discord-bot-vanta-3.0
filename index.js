const fs = require('fs');
const path = require('path');
// Load .env into process.env when present (safe if dotenv isn't installed)
try { require('dotenv').config(); } catch (e) {}
const { Client, GatewayIntentBits, Partials, EmbedBuilder, PermissionsBitField, ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { joinVoiceChannel, getVoiceConnection, createAudioPlayer, createAudioResource, AudioPlayerStatus, StreamType } = require('@discordjs/voice');
let ffmpegPath = null;
try { ffmpegPath = require('ffmpeg-static'); } catch (e) { ffmpegPath = 'ffmpeg'; }
const { spawn } = require('child_process');

const musicPlayers = new Map(); // guildId -> { player, files, index, connection, playNext }

const DATA_DIR = __dirname;
const MODLOGS_PATH = path.join(DATA_DIR, 'modlogs.json');
const BLACKLIST_PATH = path.join(DATA_DIR, 'blacklist.json');

function loadJson(p, fallback) {
  try {
    if (!fs.existsSync(p)) return fallback;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    console.error('Failed to load JSON', p, e);
    return fallback;
  }
}
function saveJson(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8');
}

function appendActionMd(guild, moderatorTag, title, details) {
  try {
    const mdPath = path.join(DATA_DIR, 'actions.md');
    const now = new Date().toISOString();
    const guildInfo = guild ? `${guild.name} (${guild.id})` : 'Direct Message';
    const entry = [
      `## ${title} — ${now}`,
      `- Server: ${guildInfo}`,
      `- Moderator: ${moderatorTag}`,
      `- Details: ${details}`,
      '',
    ].join('\n');
    fs.appendFileSync(mdPath, entry, 'utf8');
  } catch (e) {
    console.error('Failed to write actions.md', e);
  }
}

let modlogs = loadJson(MODLOGS_PATH, { lastCase: 10000, cases: [] });
let blacklist = loadJson(BLACKLIST_PATH, { blacklisted: [] });

// Automod configuration (env vars override file)
const DEFAULT_AUTOMOD = {
  blockedRoles: ['Member'],
  allowedRoles: [],
  muteMinutes: 2,
  logChannelNames: ['discord-logs', 'mod-logs', 'logs']
};

function loadAutomodConfig() {
  const cfg = Object.assign({}, DEFAULT_AUTOMOD);
  if (process.env.AUTOMOD_BLOCKED_ROLES) cfg.blockedRoles = process.env.AUTOMOD_BLOCKED_ROLES.split(',').map(s => s.trim()).filter(Boolean);
  if (process.env.AUTOMOD_ALLOWED_ROLES) cfg.allowedRoles = process.env.AUTOMOD_ALLOWED_ROLES.split(',').map(s => s.trim()).filter(Boolean);
  if (process.env.AUTOMOD_MUTE_MINUTES) { const n = parseInt(process.env.AUTOMOD_MUTE_MINUTES, 10); if (!isNaN(n)) cfg.muteMinutes = n; }
  if (process.env.AUTOMOD_LOG_CHANNELS) cfg.logChannelNames = process.env.AUTOMOD_LOG_CHANNELS.split(',').map(s => s.trim()).filter(Boolean);
  try {
    const p = path.join(DATA_DIR, 'automod.json');
    if (fs.existsSync(p)) {
      const fileCfg = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (Array.isArray(fileCfg.blockedRoles)) cfg.blockedRoles = fileCfg.blockedRoles;
      if (Array.isArray(fileCfg.allowedRoles)) cfg.allowedRoles = fileCfg.allowedRoles;
      if (typeof fileCfg.muteMinutes === 'number') cfg.muteMinutes = fileCfg.muteMinutes;
      if (Array.isArray(fileCfg.logChannelNames)) cfg.logChannelNames = fileCfg.logChannelNames;
    }
  } catch (e) { console.error('Failed to load automod.json', e); }
  return cfg;
}

const AUTOMOD_CONFIG = loadAutomodConfig();

function nextCase() {
  modlogs.lastCase += 1;
  saveJson(MODLOGS_PATH, modlogs);
  return modlogs.lastCase;
}

const PREFIX = process.env.PREFIX || '!';
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages
  ],
  partials: [Partials.Channel]
});

function parseId(arg) {
  if (!arg) return null;
  const mention = arg.replace(/[<@!>]/g, '');
  if (/^\d+$/.test(mention)) return mention;
  return null;
}

function pad(n) { return String(n).padStart(2, '0'); }
function formatHammertime(input) {
  const d = (typeof input === 'number') ? new Date(input) : new Date(input);
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  return `${pad(d.getDate())} ${months[d.getMonth()]} ${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function parseDurationToMs(s) {
  if (!s) return null;
  s = String(s).toLowerCase().trim();
  const map = { d: 86400000, h: 3600000, m: 60000, s: 1000 };
  const re = /(\d+)(d|h|m|s)/g;
  let m; let total = 0; let matched = false;
  while ((m = re.exec(s)) !== null) {
    matched = true;
    const n = parseInt(m[1], 10);
    const unit = m[2];
    total += n * (map[unit] || 0);
  }
  if (matched) return total;
  // fallback: plain number -> minutes
  const num = parseFloat(s.replace(',', '.'));
  if (!isNaN(num)) return Math.round(num * 60000);
  return null;
}

function humanDuration(ms) {
  if (!ms || ms <= 0) return '0s';
  const parts = [];
  const days = Math.floor(ms / 86400000); if (days) { parts.push(days + 'd'); ms -= days * 86400000; }
  const hours = Math.floor(ms / 3600000); if (hours) { parts.push(hours + 'h'); ms -= hours * 3600000; }
  const mins = Math.floor(ms / 60000); if (mins) { parts.push(mins + 'm'); ms -= mins * 60000; }
  const secs = Math.floor(ms / 1000); if (secs) { parts.push(secs + 's'); }
  return parts.join(' ');
}

function startMusicForGuild(guildId, connection) {
  const folder = path.join(DATA_DIR, 'music', 'christmas');
  if (!fs.existsSync(folder)) return false;
  const files = fs.readdirSync(folder).filter(f => /\.(mp3|wav|ogg|m4a)$/i.test(f)).map(f => path.join(folder, f));
  if (!files.length) return false;

  let entry = musicPlayers.get(guildId);
  if (!entry) {
    const player = createAudioPlayer();
    entry = { player, files, index: 0, connection, playNext: null, volume: 1.0 };
    musicPlayers.set(guildId, entry);
    connection.subscribe(player);

    const playNext = () => {
      const e = musicPlayers.get(guildId);
      if (!e) return;
      const file = e.files[e.index];
      let ffmpeg = null;
      try {
        const volArg = `volume=${e.volume || 1.0}`;
        ffmpeg = spawn(ffmpegPath, ['-re', '-i', file, '-analyzeduration', '0', '-loglevel', '0', '-af', volArg, '-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1']);
      } catch (err) {
        console.error('Failed to spawn ffmpeg for', file, err);
        e.index = (e.index + 1) % e.files.length;
        setTimeout(playNext, 1000);
        return;
      }
      ffmpeg.on('error', (err) => console.error('ffmpeg error', err));
      if (!ffmpeg.stdout) { e.index = (e.index + 1) % e.files.length; setTimeout(playNext, 1000); return; }
      const resource = createAudioResource(ffmpeg.stdout, { inputType: StreamType.Raw });
      e.player.play(resource);
      e.index = (e.index + 1) % e.files.length;
    };

    entry.playNext = playNext;
    player.on('stateChange', (oldState, newState) => { if (newState.status === AudioPlayerStatus.Idle) setImmediate(playNext); });
    player.on('error', (err) => { console.error('Music player error', err); setTimeout(() => { if (musicPlayers.has(guildId)) entry.playNext(); }, 1000); });
    setImmediate(playNext);
    return true;
  } else {
    entry.connection = connection;
    entry.files = files;
    if (entry.index >= entry.files.length) entry.index = 0;
    if (entry.playNext) setImmediate(entry.playNext);
    return true;
  }
}

client.on('interactionCreate', async (interaction) => {
  // Handle select menu and pagination buttons
  const folder = path.join(DATA_DIR, 'music', 'christmas');
  const files = fs.existsSync(folder) ? fs.readdirSync(folder).filter(f => /\.(mp3|wav|ogg|m4a)$/i.test(f)) : [];

  if (interaction.isStringSelectMenu() && interaction.customId.startsWith('music_select_')) {
    await interaction.deferReply({ ephemeral: true });
    const guildId = interaction.guildId;
    const selection = interaction.values[0];
    const index = parseInt(selection, 10);
    if (isNaN(index) || index < 0 || index >= files.length) return interaction.editReply('Invalid selection.');
    const member = interaction.member;
    const targetChannel = member.voice.channel;
    if (!targetChannel) return interaction.editReply('You must be in a voice channel to use this.');
    try {
      const connection = joinVoiceChannel({ channelId: targetChannel.id, guildId, adapterCreator: interaction.guild.voiceAdapterCreator });
      const started = startMusicForGuild(guildId, connection);
      if (!started) return interaction.editReply('No music files found.');
      const entry = musicPlayers.get(guildId);
      if (entry) { entry.index = index; if (entry.playNext) setImmediate(entry.playNext); }
      return interaction.editReply(`Playing **${files[index]}** in ${targetChannel.name}`);
    } catch (e) {
      console.error('interaction play error', e);
      return interaction.editReply('Failed to join voice channel.');
    }
  }

  if (interaction.isButton() && interaction.customId.startsWith('music_page_')) {
    await interaction.deferUpdate();
    // customId format: music_page_<guildId>_<page>
    const parts = interaction.customId.split('_');
    const guildId = parts[2];
    const page = parseInt(parts[3], 10) || 0;
    const pageSize = 25;
    const start = page * pageSize;
    const pageFiles = files.slice(start, start + pageSize);
    const embed = new EmbedBuilder()
      .setColor(0x8A2BE2)
      .setTitle('🎄 Christmas Music')
      .setDescription(pageFiles.map((f, i) => `${start + i + 1}. ${f.length > 90 ? f.substring(0, 87) + '...' : f}`).join('\n'))
      .setFooter({ text: `Page ${page + 1} / ${Math.max(1, Math.ceil(files.length / pageSize))}` });

    const options = pageFiles.map((f, i) => ({ label: `${start + i + 1}. ${f.length > 80 ? f.substring(0, 77) + '...' : f}`, value: String(start + i), emoji: '🎵' }));
    const select = new StringSelectMenuBuilder().setCustomId(`music_select_${guildId}`).setPlaceholder('🎄 Wähle einen Titel...').addOptions(options);
    const row1 = new ActionRowBuilder().addComponents(select);

    // pagination buttons
    const totalPages = Math.max(1, Math.ceil(files.length / pageSize));
    const prevPage = Math.max(0, page - 1);
    const nextPage = Math.min(totalPages - 1, page + 1);
    const prevBtn = new ButtonBuilder().setCustomId(`music_page_${guildId}_${prevPage}`).setLabel('◀️ Prev').setStyle(ButtonStyle.Primary).setDisabled(page === 0);
    const nextBtn = new ButtonBuilder().setCustomId(`music_page_${guildId}_${nextPage}`).setLabel('Next ▶️').setStyle(ButtonStyle.Primary).setDisabled(page === (totalPages - 1));
    const row2 = new ActionRowBuilder().addComponents(prevBtn, nextBtn);

    try {
      return interaction.update({ embeds: [embed], components: [row1, row2] });
    } catch (e) {
      try { return interaction.message.edit({ embeds: [embed], components: [row1, row2] }); } catch (err) { console.error('pagination edit failed', err); }
    }
  }
});

function sendModEmbedToUser(user, type, { guild, moderatorTag, reason, caseId }) {
  const color = 0x8A2BE2;
  const actionWord = (t) => {
    const lt = String(t||'').toLowerCase();
    if (lt.includes('warn')) return 'warned';
    if (lt.includes('ban')) return 'banned';
    if (lt.includes('unban')) return 'unbanned';
    if (lt.includes('mute')) return 'muted';
    return lt;
  };
  const serverName = guild ? guild.name : 'Vanta Scrims';
  const action = actionWord(type) || type || 'notified';
  const reasonPart = reason ? `\nReason: ${reason}` : '';
  const when = Date.now();

  const desc = `You were ${action} in ${serverName}.${reasonPart}`;

  const embed = new EmbedBuilder()
    .setColor(color)
    .setDescription(desc)
    .setFooter({ text: `${formatFooterTime(when)}` });

  return user.send({ embeds: [embed] }).catch(() => null);
}

function createChannelConfirmEmbed(text, caseId, color = 0x8A2BE2) {
  const when = Date.now();
  return new EmbedBuilder()
    .setColor(color)
    .setDescription(text)
    .setFooter({ text: `${formatFooterTime(when)}` });
}

function formatFooterTime(ts) {
  const d = new Date(ts || Date.now());
  const now = new Date();
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  const h = pad(d.getHours());
  const m = pad(d.getMinutes());
  if (sameDay) return `Today at ${h}:${m}`;
  return formatHammertime(d);
}

client.on('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
});

// Ticket system: load modular ready + interaction handlers (keeps main file unchanged)
try {
  const readyTicket = require('./events/ready.ticket.js');
  if (readyTicket && typeof readyTicket.execute === 'function') client.once('ready', () => readyTicket.execute(client));
} catch (e) { console.error('Failed to load ready.ticket.js', e); }

try {
  const interTicket = require('./events/interactionCreate.ticket.js');
  if (interTicket && typeof interTicket.execute === 'function') client.on('interactionCreate', (interaction) => { try { interTicket.execute(interaction); } catch (err) { console.error('ticket interaction handler error', err); } });
} catch (e) { console.error('Failed to load interactionCreate.ticket.js', e); }

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  // Auto-mod: configurable: prevent users with blocked roles from posting invites/links
  if (message.guild && message.member) {
    try {
      const cfg = AUTOMOD_CONFIG;
      const isExempt = message.member.permissions.has(PermissionsBitField.Flags.ManageGuild) || message.member.permissions.has(PermissionsBitField.Flags.ManageMessages) || message.member.permissions.has(PermissionsBitField.Flags.ManageChannels) || message.member.permissions.has(PermissionsBitField.Flags.ManageRoles);
      const hasBlocked = cfg.blockedRoles && cfg.blockedRoles.length && message.member.roles.cache.some(r => cfg.blockedRoles.includes(r.name));
      const hasAllowed = cfg.allowedRoles && cfg.allowedRoles.length && message.member.roles.cache.some(r => cfg.allowedRoles.includes(r.name));
      if (hasBlocked && !hasAllowed && !isExempt && message.content) {
        const inviteRe = /(discord(?:\.gg|app\.com\/invite)\/[A-Za-z0-9-]+)/i;
        const urlRe = /https?:\/\/[^\s]+/i;
        if (inviteRe.test(message.content) || urlRe.test(message.content)) {
          try { await message.delete().catch(() => {}); } catch (e) {}

          const muteMs = Math.max(0, (cfg.muteMinutes || 2) * 60 * 1000);
          const caseId = nextCase();
          const reason = inviteRe.test(message.content) ? 'Posting invite link' : 'Posting link';
          modlogs.cases.push({ caseId, type: 'AutoMute', user: message.author.id, moderator: 'AutoMod', reason, durationMs: muteMs, time: Date.now() });
          saveJson(MODLOGS_PATH, modlogs);

          try { await message.member.timeout(muteMs, `AutoMod: ${reason}`); } catch (e) { console.error('autmod timeout failed', e); }

          appendActionMd(message.guild, 'AutoMod', 'AutoMute', `${message.author.tag} (${message.author.id}) muted for ${cfg.muteMinutes}m for: ${reason} in #${message.channel.name}`);

          // Send a compact DM to the user (styled same as other mod DMs) and post the compact log in the log channel
          try {
            await sendModEmbedToUser(message.author, 'AutoMute', { guild: message.guild, moderatorTag: 'AutoMod', reason, caseId });
          } catch (e) {}

          try {
            const logChannel = message.guild.channels.cache.find(c => cfg.logChannelNames.includes(c.name));
            if (logChannel && logChannel.isText()) {
              await logChannel.send({ embeds: [createChannelConfirmEmbed(`Auto-muted <@${message.author.id}> for ${cfg.muteMinutes} minutes — Reason: ${reason}`, caseId)] }).catch(() => {});
            }
          } catch (e) {}

          return;
        }
      }
    } catch (e) {
      console.error('automod check failed', e);
    }
  }

  // Blacklist command starts with dash
  if (message.content.startsWith('-')) {
    const [cmd, ...rest] = message.content.slice(1).trim().split(/\s+/);
    if (cmd.toLowerCase() === 'blacklist') {
      if (!message.member.permissions.has(PermissionsBitField.Flags.BanMembers)) return message.reply('You lack permission to blacklist users.');
      const id = parseId(rest[0]) || rest[0];
      const reason = rest.slice(1).join(' ') || 'No reason provided';
      if (!id || !/^\d+$/.test(id)) return message.reply('Please provide a valid user ID to blacklist.');

      if (blacklist.blacklisted.includes(id)) return message.reply('This ID is already blacklisted.');
      blacklist.blacklisted.push({ id, reason, moderator: message.author.id, time: Date.now() });
      saveJson(BLACKLIST_PATH, blacklist);

      // Try to ban in this guild
      let success = 0;
      let failed = 0;
      try {
        await message.guild.members.ban(id, { reason: `Blacklisted: ${reason}` });
        success += 1;
      } catch (e) {
        failed += 1;
      }

      const embed = new EmbedBuilder()
        .setColor(0x8A2BE2)
        .setTitle('Blacklist')
        .addFields(
          { name: 'User', value: id, inline: true },
          { name: 'Reason', value: reason, inline: true },
          { name: 'Banned by', value: message.author.tag, inline: true }
        )
        .addFields(
          { name: 'Success', value: `${success} servers`, inline: true },
          { name: 'Failed', value: `${failed} servers`, inline: true }
        )
        .setTimestamp();

      return message.channel.send({ embeds: [embed] });
    }
  }

  // Admin modlog edits via * commands
  if (message.content.startsWith('*')) {
    const [cmd, ...rest] = message.content.slice(1).trim().split(/\s+/);
    if (!cmd) return;
    // Permission: require ManageGuild
    if (!message.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) return message.reply('You lack permission to edit modlogs.');

    if (cmd.toLowerCase() === 'reason') {
      const caseId = parseInt(rest[0], 10);
      const newReason = rest.slice(1).join(' ');
      if (!caseId || !newReason) return message.reply('Usage: *reason <caseId> <new reason>');
      const c = modlogs.cases.find(x => Number(x.caseId) === Number(caseId));
      if (!c) return message.reply(`Case ${caseId} not found.`);
      c.reason = newReason;
      saveJson(MODLOGS_PATH, modlogs);
      // notify user if possible
      try {
        if (c.user) {
          const u = await client.users.fetch(String(c.user)).catch(() => null);
          if (u) await sendModEmbedToUser(u, `${c.type} - Reason Updated`, { guild: message.guild, moderatorTag: message.author.tag, reason: `Updated reason: ${newReason}`, caseId: c.caseId });
        }
      } catch (e) {}
      return message.channel.send({ embeds: [createChannelConfirmEmbed(`Updated reason for case ${caseId}`, caseId)] });
    }

    if (cmd.toLowerCase() === 'duration') {
      const caseId = parseInt(rest[0], 10);
      const durStr = rest.slice(1).join(' ');
      if (!caseId || !durStr) return message.reply('Usage: *duration <caseId> <duration> (e.g. 3d, 2h30m, 15m)');
      const ms = parseDurationToMs(durStr);
      if (ms === null) return message.reply('Invalid duration format. Use e.g. 3d, 2h30m, 15m');
      const c = modlogs.cases.find(x => Number(x.caseId) === Number(caseId));
      if (!c) return message.reply(`Case ${caseId} not found.`);
      c.durationMs = ms;
      // update reason for mutes for clarity
      if (c.type && c.type.toLowerCase() === 'mute') {
        c.reason = `Timeout ${humanDuration(ms)}`;
      }
      saveJson(MODLOGS_PATH, modlogs);
      try {
        if (c.user) {
          const u = await client.users.fetch(String(c.user)).catch(() => null);
          if (u) await sendModEmbedToUser(u, `${c.type} - Duration Updated`, { guild: message.guild, moderatorTag: message.author.tag, reason: `Duration changed to ${humanDuration(ms)}`, caseId: c.caseId });
        }
      } catch (e) {}
      return message.channel.send({ embeds: [createChannelConfirmEmbed(`Updated duration for case ${caseId} to ${humanDuration(ms)}`, caseId)] });
    }
  }

  if (!message.content.startsWith(PREFIX)) return;
  const [raw, ...args] = message.content.slice(PREFIX.length).trim().split(/\s+/);
  const command = raw.toLowerCase();

  // Helper to resolve a user by mention or id
  async function resolveUser(arg) {
    const id = parseId(arg) || arg;
    if (!id) return null;
    try {
      // Try fetch from guild members first
      if (message.guild) {
        const member = await message.guild.members.fetch(id).catch(() => null);
        if (member) return member.user;
      }
      // Fallback fetch global user
      return await client.users.fetch(id).catch(() => null);
    } catch (e) {
      return null;
    }
  }

  if (command === 'warn') {
    if (!message.member.permissions.has(PermissionsBitField.Flags.ManageMessages)) return message.reply('You lack permission to warn members.');
    const targetArg = args[0];
    const reason = args.slice(1).join(' ') || 'No reason provided';
    const targetUser = await resolveUser(targetArg);
    if (!targetUser) return message.reply('User not found. Use mention or ID.');

    const caseId = nextCase();
    // Record modlog
    modlogs.cases.push({ caseId, type: 'Warn', user: targetUser.id, moderator: message.author.id, reason, time: Date.now() });
    saveJson(MODLOGS_PATH, modlogs);

    // DM the user
    await sendModEmbedToUser(targetUser, 'Warn', { guild: message.guild, moderatorTag: message.author.tag, reason, caseId });

    const text = `User ${targetUser.tag} (${targetUser.id}) was warned. | ${reason}`;
    return message.channel.send({ embeds: [createChannelConfirmEmbed(text, caseId)] });
  }

  if (command === 'ban') {
    if (!message.member.permissions.has(PermissionsBitField.Flags.BanMembers)) return message.reply('You lack permission to ban members.');
    const targetArg = args[0];
    const reason = args.slice(1).join(' ') || 'No reason provided';
    const id = parseId(targetArg) || targetArg;
    if (!id) return message.reply('Please provide a mention or user ID to ban.');

    const caseId = nextCase();
    modlogs.cases.push({ caseId, type: 'Ban', user: id, moderator: message.author.id, reason, time: Date.now() });
    saveJson(MODLOGS_PATH, modlogs);

    // Try DM before ban
    try {
      const user = await client.users.fetch(id).catch(() => null);
      if (user) await sendModEmbedToUser(user, 'Ban', { guild: message.guild, moderatorTag: message.author.tag, reason, caseId });
    } catch (e) {}

    // Ban in guild
    try {
      await message.guild.members.ban(id, { reason: `${message.author.tag}: ${reason}` });
      const text = `User ${id} was banned. | ${reason}`;
      return message.channel.send({ embeds: [createChannelConfirmEmbed(text, caseId)] });
    } catch (e) {
      return message.reply('Failed to ban user — maybe invalid ID or lack of permissions.');
    }
  }

  if (command === 'unban') {
    if (!message.member.permissions.has(PermissionsBitField.Flags.BanMembers)) return message.reply('You lack permission to unban members.');
    const id = args[0];
    if (!id || !/^\d+$/.test(id)) return message.reply('Please provide a valid user ID to unban.');
    try {
      await message.guild.bans.remove(id, `${message.author.tag}`);
      const caseId = nextCase();
      modlogs.cases.push({ caseId, type: 'Unban', user: id, moderator: message.author.id, reason: 'Unban', time: Date.now() });
      saveJson(MODLOGS_PATH, modlogs);

      // DM the user if possible
      const user = await client.users.fetch(id).catch(() => null);
      if (user) await sendModEmbedToUser(user, 'Unban', { guild: message.guild, moderatorTag: message.author.tag, reason: 'You were unbanned', caseId });

      const text = `User ${id} was unbanned.`;
      return message.channel.send({ embeds: [createChannelConfirmEmbed(text, caseId)] });
    } catch (e) {
      return message.reply('Failed to unban — check the ID and that the user is banned.');
    }
  }

  if (command === 'mute') {
    if (!message.member.permissions.has(PermissionsBitField.Flags.ModerateMembers)) return message.reply('You lack permission to mute (timeout) members.');
    const targetArg = args[0];
    const minutesArg = args[1] || '1';
    const minutes = parseInt(minutesArg.replace(/[^0-9]/g, '')) || 1;
    const duration = minutes * 60 * 1000;
    const member = await message.guild.members.fetch(parseId(targetArg) || targetArg).catch(() => null);
    if (!member) return message.reply('Member not found.');

    try {
      await member.timeout(duration, `${message.author.tag}: mute`);
      const caseId = nextCase();
      modlogs.cases.push({ caseId, type: 'Mute', user: member.id, moderator: message.author.id, reason: `Timeout ${minutes}m`, time: Date.now() });
      saveJson(MODLOGS_PATH, modlogs);

      // DM user
      await sendModEmbedToUser(member.user, 'Mute', { guild: message.guild, moderatorTag: message.author.tag, reason: `Timeout ${minutes} minutes`, caseId });

      const text = `User ${member.user.tag} was muted for ${minutes} minutes.`;
      return message.channel.send({ embeds: [createChannelConfirmEmbed(text, caseId)] });
    } catch (e) {
      return message.reply('Failed to mute the member — missing permissions or hierarchy issue.');
    }
  }

  if (command === 'unmute') {
    if (!message.member.permissions.has(PermissionsBitField.Flags.ModerateMembers)) return message.reply('You lack permission to unmute (remove timeout).');
    const targetArg = args[0];
    const member = await message.guild.members.fetch(parseId(targetArg) || targetArg).catch(() => null);
    if (!member) return message.reply('Member not found.');

    try {
      await member.timeout(null, `${message.author.tag}: unmute`);
      const caseId = nextCase();
      modlogs.cases.push({ caseId, type: 'Unmute', user: member.id, moderator: message.author.id, reason: 'Unmute', time: Date.now() });
      saveJson(MODLOGS_PATH, modlogs);

      await sendModEmbedToUser(member.user, 'Unmute', { guild: message.guild, moderatorTag: message.author.tag, reason: 'You were unmuted', caseId });

      const text = `User ${member.user.tag} was unmuted.`;
      return message.channel.send({ embeds: [createChannelConfirmEmbed(text, caseId)] });
    } catch (e) {
      return message.reply('Failed to unmute the member.');
    }
  }

  // Modlogs display: !md or !modlogs <user>
  if (command === 'md' || command === 'modlogs') {
    const targetArg = args[0];
    if (!targetArg) return message.reply('Usage: !md <user mention|id>');
    const id = parseId(targetArg) || targetArg;
    if (!id || !/^\d+$/.test(id)) return message.reply('Provide a valid user mention or ID.');
    // find cases for this user
    const cases = modlogs.cases.filter(c => String(c.user) === String(id)).slice().sort((a,b)=>b.caseId - a.caseId);
    let userTag = id;
    try { const u = await client.users.fetch(id).catch(()=>null); if (u) userTag = `${u.tag}`; } catch(e){}

    const embed = new EmbedBuilder()
      .setColor(0x8A2BE2)
      .setTitle(`Modlogs for ${userTag}`)
      .setTimestamp();

    if (!cases.length) {
      embed.setDescription('No modlogs found for this user.');
      return message.channel.send({ embeds: [embed] });
    }

    // Add up to 25 fields (Discord limit); include case header and details
    const maxFields = 25;
    const total = cases.length;
    const toShow = cases.slice(0, maxFields);
    toShow.forEach((c) => {
      const when = formatHammertime(c.time || 0);
      const moderator = c.moderator ? String(c.moderator) : 'Unknown';
      const type = c.type || 'Case';
      const dur = c.durationMs ? ` (${Math.round((c.durationMs||0)/1000)}s)` : '';
      const name = `Case ${c.caseId} — ${type}${dur}`;
      const val = `Moderator: ${moderator}\nReason: ${c.reason || '—'}\n${when}`;
      embed.addFields({ name, value: val });
    });

    if (total > maxFields) embed.setFooter({ text: `Showing ${maxFields} of ${total} cases` });

    return message.channel.send({ embeds: [embed] });
  }

  // Fun / Christmas commands
  const SANTA_PATH = path.join(DATA_DIR, 'santa_list.json');
  const ADVENT_PATH = path.join(DATA_DIR, 'advent.json');
  let santaList = loadJson(SANTA_PATH, {});
  let advent = loadJson(ADVENT_PATH, {});

  if (command === 'santa') {
    const sub = args[0] ? args[0].toLowerCase() : 'help';
    if (sub === 'help') return message.reply('Usage: !santa check <user>|nice <user>|naughty <user>|list');
    if (sub === 'list') {
      const entries = Object.entries(santaList);
      if (!entries.length) return message.reply('Santa has no entries yet.');
      const embed = new EmbedBuilder().setColor(0x8A2BE2).setTitle('Santa List');
      entries.slice(0,25).forEach(([id, v]) => embed.addFields({ name: `${v.status.toUpperCase()}`, value: `<@${id}> — ${v.note||'—'}` }));
      return message.channel.send({ embeds: [embed] });
    }
    if (['check','nice','naughty'].includes(sub)) {
      const targetArg = args[1];
      const id = parseId(targetArg) || targetArg || message.author.id;
      if (!id || !/^\d+$/.test(id)) return message.reply('Provide a valid user mention or ID.');
      if (sub === 'check') {
        if (!santaList[id]) {
          const status = Math.random() < 0.6 ? 'nice' : 'naughty';
          santaList[id] = { status, note: '' };
          saveJson(SANTA_PATH, santaList);
        }
        const e = new EmbedBuilder().setColor(0x8A2BE2).setTitle(`Santa check for ${id}`).setDescription(`Status: **${santaList[id].status.toUpperCase()}**`);
        return message.channel.send({ embeds: [e] });
      } else {
        if (!message.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) return message.reply('Only server managers can set statuses.');
        const status = sub === 'nice' ? 'nice' : 'naughty';
        const note = args.slice(2).join(' ') || '';
        santaList[id] = { status, note };
        saveJson(SANTA_PATH, santaList);
        return message.channel.send({ embeds: [new EmbedBuilder().setColor(0x8A2BE2).setDescription(`Set <@${id}> to **${status.toUpperCase()}**${note?` — ${note}`:''}`)] });
      }
    }
    return message.reply('Unknown subcommand for !santa');
  }

  if (command === 'gift') {
    const targetArg = args[0];
    const id = parseId(targetArg) || targetArg || null;
    if (!id) return message.reply('Usage: !gift <user mention|id> [message]');
    const gifts = ['A cozy blanket','A box of cookies','A mysterious present','A warm hug emoji','A virtual snow globe'];
    const gift = gifts[Math.floor(Math.random()*gifts.length)];
    const note = args.slice(1).join(' ') || 'Happy Holidays!';
    // DM recipient
    const who = await resolveUser(id).catch(()=>null);
    const embed = new EmbedBuilder().setColor(0x8A2BE2).setTitle('You received a gift!').addFields({ name: 'Gift', value: gift }, { name: 'Message', value: note });
    if (who) { try { await who.send({ embeds: [embed] }); } catch(e){} }
    return message.channel.send({ embeds: [new EmbedBuilder().setColor(0x8A2BE2).setDescription(`Gave **${gift}** to <@${id}> — ${note}`)] });
  }

  if (command === 'snow') {
    let count = parseInt(args[0],10) || 10; if (count < 1) count = 1; if (count > 30) count = 30;
    const lines = [];
    for (let i=0;i<count;i++) lines.push(' '.repeat((i*3)%20) + '❄️'.repeat(Math.max(1, (i%5)+1)));
    return message.channel.send(lines.join('\n'));
  }

  if (command === 'joke') {
    const jokes = [
      'Why did Santa go to music school? To improve his wrapping skills!',
      'What do snowmen eat for breakfast? Frosted Flakes!',
      'Why was the Christmas tree bad at knitting? Too many needles.'
    ];
    return message.channel.send(jokes[Math.floor(Math.random()*jokes.length)]);
  }

  if (command === 'advent') {
    const sub = args[0] ? args[0].toLowerCase() : 'today';
    const day = new Date().getDate();
    if (sub === 'open') {
      const which = parseInt(args[1],10) || day;
      if (which < 1 || which > 25) return message.reply('Open days 1–25.');
      if (advent[which]) return message.reply(`Day ${which} already opened.`);
      const prizes = ['Candy cane','Hot chocolate','Gift card','Snowflake sticker','Silent night playlist'];
      const prize = prizes[which % prizes.length];
      advent[which] = { prize, time: Date.now() };
      saveJson(ADVENT_PATH, advent);
      return message.channel.send({ embeds: [new EmbedBuilder().setColor(0x8A2BE2).setTitle(`Advent Day ${which}`).setDescription(`You found: **${prize}**`)] });
    }
    // default: show today
    return message.channel.send({ embeds: [new EmbedBuilder().setColor(0x8A2BE2).setTitle(`Advent Today — Day ${day}`).setDescription('Use `!advent open <day>` to open a door!')] });
  }

  // Voice / Music commands
  if (command === 'join') {
    // optional channel arg
    let targetChannel = null;
    if (args[0]) {
      const chId = args[0].replace(/[<#>]/g, '');
      targetChannel = message.guild.channels.cache.get(chId) || message.guild.channels.cache.find(c => c.name === args[0]);
    }
    if (!targetChannel) targetChannel = message.member.voice.channel;
    if (!targetChannel) return message.reply('You must be in a voice channel or provide a channel to join.');
    try {
      const connection = joinVoiceChannel({ channelId: targetChannel.id, guildId: message.guild.id, adapterCreator: message.guild.voiceAdapterCreator });
      const started = startMusicForGuild(message.guild.id, connection);
      if (started) return message.reply(`Joined ${targetChannel.name} and started autoplaying music.`);
      return message.reply(`Joined ${targetChannel.name}, but no music files found in music/christmas.`);
    } catch (e) {
      console.error('join error', e);
      return message.reply('Failed to join voice channel.');
    }
  }

  if (command === 'leave') {
    const conn = getVoiceConnection(message.guild.id);
    if (!conn) return message.reply('I am not connected to a voice channel in this guild.');
    try {
      const entry = musicPlayers.get(message.guild.id);
      if (entry) { try { entry.player.stop(); } catch {} musicPlayers.delete(message.guild.id); }
      conn.destroy();
      return message.reply('Left the voice channel and stopped music.');
    } catch (e) {
      return message.reply('Failed to leave voice channel.');
    }
  }

  if (command === 'music') {
    const sub = args[0] ? args[0].toLowerCase() : 'list';
    const folder = path.join(DATA_DIR, 'music', 'christmas');
    if (!fs.existsSync(folder)) return message.reply('No music folder found (music/christmas).');
    const files = fs.readdirSync(folder).filter(f => /\.(mp3|wav|ogg|m4a)$/i.test(f));

    if (sub === 'list') {
      if (!files.length) return message.reply('No music files found in music/christmas.');
      // send first page (page 0)
      const page = 0;
      const pageSize = 25;
      const start = page * pageSize;
      const pageFiles = files.slice(start, start + pageSize);
      const embed = new EmbedBuilder()
        .setColor(0x8A2BE2)
        .setTitle('🎄 Christmas Music')
        .setDescription(pageFiles.map((f, i) => `${start + i + 1}. ${f.length > 90 ? f.substring(0, 87) + '...' : f}`).join('\n'))
        .setFooter({ text: 'Wähle einen Titel aus dem Menü oder benutze !music play <num>' });

      const options = pageFiles.map((f, i) => ({ label: `${start + i + 1}. ${f.length > 80 ? f.substring(0, 77) + '...' : f}`, value: String(start + i), emoji: '🎵' }));
      const select = new StringSelectMenuBuilder().setCustomId(`music_select_${message.guild.id}`).setPlaceholder('🎄 Wähle einen Titel...').addOptions(options);
      const row1 = new ActionRowBuilder().addComponents(select);

      // pagination row
      const totalPages = Math.max(1, Math.ceil(files.length / pageSize));
      const prevBtn = new ButtonBuilder().setCustomId(`music_page_${message.guild.id}_0`).setLabel('◀️ Prev').setStyle(ButtonStyle.Primary).setDisabled(true);
      const nextBtn = new ButtonBuilder().setCustomId(`music_page_${message.guild.id}_1`).setLabel('Next ▶️').setStyle(ButtonStyle.Primary).setDisabled(totalPages <= 1);
      const row2 = new ActionRowBuilder().addComponents(prevBtn, nextBtn);

      return message.channel.send({ embeds: [embed], components: [row1, row2] });
    }

    if (sub === 'play') {
      const which = args[1];
      if (!which) return message.reply('Usage: !music play <number|name> [channel]');
      let index = parseInt(which, 10);
      if (isNaN(index)) { index = files.findIndex(f => f.toLowerCase().includes(which.toLowerCase())); } else { index = index - 1; }
      if (index < 0 || index >= files.length) return message.reply('Invalid track number/name. Use !music list.');
      // channel arg
      let targetChannel = null;
      if (args[2]) { const chId = args[2].replace(/[<#>]/g, ''); targetChannel = message.guild.channels.cache.get(chId) || message.guild.channels.cache.find(c => c.name === args[2]); }
      if (!targetChannel) targetChannel = message.member.voice.channel;
      if (!targetChannel) return message.reply('You must be in a voice channel or provide one.');
      try {
        const connection = joinVoiceChannel({ channelId: targetChannel.id, guildId: message.guild.id, adapterCreator: message.guild.voiceAdapterCreator });
        const started = startMusicForGuild(message.guild.id, connection);
        if (!started) return message.reply('No music files found.');
        const entry = musicPlayers.get(message.guild.id);
        if (entry) { entry.index = index; if (entry.playNext) setImmediate(entry.playNext); }
        return message.reply(`Playing **${files[index]}** in ${targetChannel.name}.`);
      } catch (e) { console.error('music play error', e); return message.reply('Failed to start playback.'); }
    }

    if (sub === 'stop') {
      const entry = musicPlayers.get(message.guild.id);
      if (entry) { try { entry.player.stop(); } catch {} musicPlayers.delete(message.guild.id); }
      const conn = getVoiceConnection(message.guild.id);
      if (conn) conn.destroy();
      return message.reply('Stopped music and left.');
    }

    if (sub === 'volume') {
      const v = args[1];
      if (!v) return message.reply('Usage: !music volume <0-100>');
      const num = parseInt(v.replace(/[^0-9]/g, ''), 10);
      if (isNaN(num) || num < 0 || num > 100) return message.reply('Provide a number between 0 and 100.');
      const entry = musicPlayers.get(message.guild.id);
      if (!entry) return message.reply('No active music player in this guild. Use !join or !music play first.');
      entry.volume = Math.max(0, Math.min(5, num / 100));
      // restart current track
      try { entry.player.stop(); } catch (e) {}
      if (entry.playNext) setImmediate(entry.playNext);
      return message.reply(`Set volume to ${num}%`);
    }

    return message.reply('Unknown subcommand. Use `!music list`, `!music play <num|name> [channel]`, or `!music stop`.');
  }

    if (command === 'del' || command === 'delete') {
      if (!message.member.permissions.has(PermissionsBitField.Flags.ManageChannels)) return message.reply('You lack permission to delete channels.');
      const targetArg = args[0];
      if (!targetArg) return message.reply('Usage: !del <#channel|channelId|name>');

      // Try to resolve a mentioned channel first, then by id or exact name
      let channel = message.mentions.channels.first();
      if (!channel) {
        const id = targetArg.replace(/[<#>]/g, '');
        channel = message.guild.channels.cache.get(id) || message.guild.channels.cache.find(c => c.name === targetArg);
      }
      if (!channel) return message.reply('Channel not found. Provide a channel mention, ID or exact name.');

      const confirmEmbed = new EmbedBuilder().setColor(0x8A2BE2).setDescription(`Are you sure you want to delete channel **${channel.name}**? Reply with **y** to confirm within 30 seconds.`);
      await message.channel.send({ embeds: [confirmEmbed] });

      try {
        const filter = (m) => m.author.id === message.author.id && ['y','yes','n','no'].includes(m.content.toLowerCase());
        const collected = await message.channel.awaitMessages({ filter, max: 1, time: 30000, errors: ['time'] });
        const resp = collected.first().content.toLowerCase();
        if (resp === 'y' || resp === 'yes') {
          try {
            await channel.delete(`${message.author.tag}: requested by command`);
            appendActionMd(message.guild, message.author.tag, 'Channel Deleted', `Deleted channel ${channel.name} (${channel.id})`);
            return message.channel.send({ embeds: [new EmbedBuilder().setColor(0x8A2BE2).setDescription(`Deleted channel ${channel.name}`)] });
          } catch (e) {
            console.error('delete channel error', e);
            appendActionMd(message.guild, message.author.tag, 'Channel Deletion Failed', `Failed to delete ${channel.name} (${channel.id}) — ${String(e)}`);
            return message.reply('Failed to delete channel — missing permissions or role hierarchy.');
          }
        } else {
          appendActionMd(message.guild, message.author.tag, 'Channel Deletion Aborted', `User aborted deletion of ${channel.name} (${channel.id})`);
          return message.channel.send('Aborted channel deletion.');
        }
      } catch (e) {
        appendActionMd(message.guild, message.author.tag, 'Channel Deletion Timeout', `No confirmation received for deletion of ${channel.name} (${channel.id})`);
        return message.reply('No confirmation received — aborting deletion.');
      }
    }

    if (command === 'role') {
      if (!message.member.permissions.has(PermissionsBitField.Flags.ManageRoles)) return message.reply('You lack permission to assign roles.');
      // Expect usage: !role @user @role  OR !role userId roleIdOrName
      const member = message.mentions.members.first() || (args[0] ? await message.guild.members.fetch(args[0].replace(/[<@!>]/g, '')).catch(() => null) : null);
      // role: try mentioned role first, then id, then name (rest of args)
      let role = message.mentions.roles.first();
      if (!role) {
        const possibleId = (args[1] || '').replace(/[<@&>]/g, '');
        role = message.guild.roles.cache.get(possibleId) || message.guild.roles.cache.find(r => r.name === args.slice(1).join(' '));
      }
      if (!member || !role) return message.reply('Usage: !role @user @role  OR  !role <userId> <roleId|roleName>');

      try {
        await member.roles.add(role, `${message.author.tag}: assigned via command`);
        appendActionMd(message.guild, message.author.tag, 'Role Assigned', `Assigned role ${role.name} (${role.id}) to ${member.user.tag} (${member.id})`);
        return message.channel.send({ embeds: [new EmbedBuilder().setColor(0x8A2BE2).setDescription(`Assigned role **${role.name}** to ${member.user.tag}`)] });
      } catch (e) {
        console.error('role assign error', e);
        appendActionMd(message.guild, message.author.tag, 'Role Assignment Failed', `Failed to assign role ${role ? role.name : '(unknown)'} to ${member ? member.user.tag : '(unknown)'} — ${String(e)}`);
        return message.reply('Failed to assign role — check bot role hierarchy and permissions.');
      }
    }
});

client.login(process.env.DISCORD_TOKEN).catch((e) => {
  console.error('Failed to login — set DISCORD_TOKEN env variable', e);
});
