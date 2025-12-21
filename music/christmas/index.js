const fs = require('fs');
const path = require('path');
// Load .env into process.env when present (safe if dotenv isn't installed)
try { require('dotenv').config(); } catch (e) {}
const { Client, GatewayIntentBits, Partials, EmbedBuilder, PermissionsBitField } = require('discord.js');

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

let modlogs = loadJson(MODLOGS_PATH, { lastCase: 10000, cases: [] });
let blacklist = loadJson(BLACKLIST_PATH, { blacklisted: [] });

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

function pad(n) { return String(n).padStart(2, '0'); }
function formatHammertime(input) {
  const d = (typeof input === 'number') ? new Date(input) : new Date(input);
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  return `${pad(d.getDate())} ${months[d.getMonth()]} ${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
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

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

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

});

client.login(process.env.DISCORD_TOKEN).catch((e) => {
  console.error('Failed to login — set DISCORD_TOKEN env variable', e);
});
