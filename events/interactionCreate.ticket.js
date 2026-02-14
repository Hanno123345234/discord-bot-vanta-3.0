const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, PermissionsBitField } = require('discord.js');
const path = require('path');
const fs = require('fs');
const CLAIMING_CONFIG = require('../claiming.config');
const { handleTicketClaimFlow } = require('./interactionCreate.ticket.flow');
let voiceActivity = null;
try { voiceActivity = require('../utils/voice_activity'); } catch (e) { voiceActivity = null; }

const POLLS_PATH = path.join(__dirname, '..', 'polls.json');
const DUO_CLAIM_SCHEDULES_PATH = path.join(__dirname, '..', 'duo_claim_schedules.json');
const BLACKLIST_PATH = path.join(__dirname, '..', 'blacklist.json');
const pollCache = new Map();
let pollsLoaded = false;
const scheduledClaimTimers = new Map();
const duoClaimPanels = new Map();
const DUO_CLAIM_PING_ROLE_ID = String(CLAIMING_CONFIG.roles.staff);
let duoClaimSchedulesHydrated = false;

function parseHHMMToNextMs(input, now = new Date()) {
  const raw = String(input || '').trim();
  const m = raw.match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  const d = new Date(now);
  d.setSeconds(0, 0);
  d.setHours(h, min, 0, 0);
  if (d.getTime() + 60_000 < now.getTime()) d.setDate(d.getDate() + 1);
  return d.getTime();
}

function buildDuoClaimEmbed(state) {
  const claims = Array.isArray(state.claims) ? state.claims : [];
  const title = state.reload
    ? `Reload Session ${state.session}`
    : `${state.gamemode} Session ${state.session}`;
  const hasClaims = claims.length > 0;

  const embed = new EmbedBuilder()
    .setColor(0x87CEFA)
    .setTitle(title);

  if (!hasClaims) {
    embed.setDescription('No session claimed yet.\n\nPress a button below to claim/unclaim.');
    return embed;
  }

  embed.setDescription('Lobby order:');
  const fields = [];
  const maxLobbiesShown = 24;
  const shown = claims.slice(0, maxLobbiesShown);
  for (let i = 0; i < shown.length; i += 2) {
    const leftIdx = i;
    const rightIdx = i + 1;
    fields.push({ name: `Lobby ${leftIdx + 1}`, value: `<@${shown[leftIdx]}>`, inline: true });
    if (rightIdx < shown.length) {
      fields.push({ name: `Lobby ${rightIdx + 1}`, value: `<@${shown[rightIdx]}>`, inline: true });
    } else {
      fields.push({ name: '\u200B', value: '\u200B', inline: true });
    }
    fields.push({ name: '\u200B', value: '\u200B', inline: true });
  }
  if (claims.length > maxLobbiesShown) {
    fields.push({ name: 'More', value: `+${claims.length - maxLobbiesShown} more claimed lobbies`, inline: false });
  }
  fields.push({ name: '\u200B', value: 'Press the button to claim/unclaim', inline: false });
  embed.addFields(fields);
  return embed;
}

function buildDuoClaimRow(panelId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`duo_claim_add:${panelId}`).setLabel('Claim Lobby').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`duo_claim_remove:${panelId}`).setLabel('Unclaim').setStyle(ButtonStyle.Secondary)
  );
}

function loadJsonSafe(p, fallback) {
  try {
    if (!fs.existsSync(p)) return fallback;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    return fallback;
  }
}

function saveJsonSafe(p, obj) {
  try {
    fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8');
  } catch (e) {}
}

function loadDuoClaimSchedules() {
  const rows = loadJsonSafe(DUO_CLAIM_SCHEDULES_PATH, []);
  if (!Array.isArray(rows)) return [];
  return rows.filter(r => r && typeof r === 'object');
}

function saveDuoClaimSchedules(rows) {
  saveJsonSafe(DUO_CLAIM_SCHEDULES_PATH, Array.isArray(rows) ? rows : []);
}

function upsertDuoClaimSchedule(row) {
  const all = loadDuoClaimSchedules();
  const key = String(row && row.scheduleKey ? row.scheduleKey : '');
  if (!key) return;
  const idx = all.findIndex(x => String(x.scheduleKey || '') === key);
  if (idx >= 0) all[idx] = row;
  else all.push(row);
  saveDuoClaimSchedules(all);
}

function removeDuoClaimSchedule(scheduleKey) {
  const key = String(scheduleKey || '');
  if (!key) return;
  const all = loadDuoClaimSchedules();
  const keep = all.filter(x => String(x.scheduleKey || '') !== key);
  saveDuoClaimSchedules(keep);
}

async function postScheduledDuoClaimPanel(client, job) {
  const channel = client.channels.cache.get(String(job.channelId))
    || await client.channels.fetch(String(job.channelId)).catch(() => null);
  if (!channel || typeof channel.send !== 'function') return;

  const state = {
    panelId: null,
    gamemode: String(job.gamemode || 'Duos'),
    session: Number(job.session || 1),
    reload: !!job.reload,
    claims: [],
  };

  const rowPending = buildDuoClaimRow('pending');
  const sent = await channel.send({
    embeds: [buildDuoClaimEmbed(state)],
    components: [rowPending],
    allowedMentions: { parse: ['users'] }
  }).catch(() => null);
  if (!sent) return;

  state.panelId = String(sent.id);
  duoClaimPanels.set(String(sent.id), state);

  const row = buildDuoClaimRow(String(sent.id));
  await sent.edit({ embeds: [buildDuoClaimEmbed(state)], components: [row] }).catch(() => {});

  const pingMsg = await channel.send({
    content: `<@&${DUO_CLAIM_PING_ROLE_ID}>`,
    allowedMentions: { roles: [DUO_CLAIM_PING_ROLE_ID] }
  }).catch(() => null);
  if (pingMsg) {
    setTimeout(() => {
      try { pingMsg.delete().catch(() => {}); } catch (e) {}
    }, 1800);
  }
}

function scheduleDuoClaimJob(client, job, { persist = true } = {}) {
  const scheduleKey = String(job.scheduleKey || '');
  if (!scheduleKey) return;

  if (scheduledClaimTimers.has(scheduleKey)) {
    try { clearTimeout(scheduledClaimTimers.get(scheduleKey)); } catch (e) {}
    scheduledClaimTimers.delete(scheduleKey);
  }

  if (persist) upsertDuoClaimSchedule(job);

  let delay = Math.max(0, Number(job.targetMs || Date.now()) - Date.now());
  if (!Number.isFinite(delay)) delay = 0;

  const t = setTimeout(async () => {
    try {
      await postScheduledDuoClaimPanel(client, job);
    } catch (e) {
      console.error('scheduled duo claim post failed', e);
    } finally {
      scheduledClaimTimers.delete(scheduleKey);
      removeDuoClaimSchedule(scheduleKey);
    }
  }, delay);

  scheduledClaimTimers.set(scheduleKey, t);
}

async function initClaimScheduler(client) {
  try {
    if (duoClaimSchedulesHydrated) return;
    duoClaimSchedulesHydrated = true;

    const now = Date.now();
    const all = loadDuoClaimSchedules();
    const keep = [];
    for (const job of all) {
      if (!job || !job.scheduleKey || !job.channelId) continue;
      const targetMs = Number(job.targetMs || 0);
      if (!Number.isFinite(targetMs) || targetMs <= 0) continue;

      // Skip very old pending jobs; run recent missed ones as immediate catch-up.
      if (targetMs < (now - (2 * 60 * 60 * 1000))) continue;

      const fixed = Object.assign({}, job);
      if (targetMs < now) fixed.targetMs = now + 2000;
      keep.push(fixed);
      scheduleDuoClaimJob(client, fixed, { persist: false });
    }
    saveDuoClaimSchedules(keep);
  } catch (e) {
    console.error('initClaimScheduler failed', e);
  }
}

function loadPollCache() {
  if (pollsLoaded) return;
  pollsLoaded = true;
  const raw = loadJsonSafe(POLLS_PATH, {});
  for (const [id, poll] of Object.entries(raw || {})) {
    const votes = {};
    const options = Array.isArray(poll.options) ? poll.options.slice(0, 2) : ['Ja', 'Nein'];
    for (let i = 0; i < options.length; i++) {
      const arr = (poll.votes && Array.isArray(poll.votes[i])) ? poll.votes[i] : [];
      votes[i] = new Set(arr.map(String));
    }
    pollCache.set(String(id), {
      messageId: String(id),
      question: String(poll.question || 'Poll'),
      options,
      votes,
      createdBy: poll.createdBy || null,
      createdAt: poll.createdAt || Date.now(),
    });
  }
}

function savePollCache() {
  const out = {};
  for (const [id, poll] of pollCache.entries()) {
    const votes = {};
    for (const [idx, set] of Object.entries(poll.votes || {})) {
      votes[idx] = Array.from(set || []);
    }
    out[id] = {
      question: poll.question,
      options: poll.options,
      votes,
      createdBy: poll.createdBy,
      createdAt: poll.createdAt,
    };
  }
  saveJsonSafe(POLLS_PATH, out);
}

function getPoll(messageId) {
  loadPollCache();
  return pollCache.get(String(messageId)) || null;
}

function setPoll(messageId, poll) {
  loadPollCache();
  pollCache.set(String(messageId), poll);
  savePollCache();
}

function buildPollComponents(poll) {
  const optionA = poll.options[0] || 'Ja';
  const optionB = poll.options[1] || 'Nein';

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`poll_vote:${poll.messageId}:0`)
      .setLabel(optionA)
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`poll_vote:${poll.messageId}:1`)
      .setLabel(optionB)
      .setStyle(ButtonStyle.Secondary)
  );

  return [row];
}

function formatPollTimestamp(ms) {
  const d = new Date(ms);
  const pad2 = (n) => String(n).padStart(2, '0');
  return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function formatPollTimeValue(raw) {
  if (!raw) return '—';
  const s = String(raw).trim();
  if (!s) return '—';
  if (/^\d{9,}$/.test(s)) {
    const ts = parseInt(s, 10);
    return `<t:${ts}:t>`;
  }
  const m = s.match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  if (m) {
    const now = new Date();
    const d = new Date(now);
    d.setHours(Number(m[1]), Number(m[2]), 0, 0);
    const ts = Math.floor(d.getTime() / 1000);
    return `<t:${ts}:t>`;
  }
  return s;
}

function formatVoterList(ids) {
  if (!ids || !ids.length) return '—';
  const mentions = ids.map(id => `<@${id}>`);
  const out = [];
  let len = 0;
  for (const m of mentions) {
    if (len + m.length + 2 > 1024) break;
    out.push(m);
    len += m.length + 2;
  }
  return out.join(', ') || '—';
}

function buildPollEmbed(poll) {
  const timeText = formatPollTimeValue(poll.timeText ? String(poll.timeText).slice(0, 100) : null);
  const amountText = poll.amountText ? String(poll.amountText).slice(0, 100) : '—';
  const yesIds = poll.votes[0] ? Array.from(poll.votes[0]) : [];
  const noIds = poll.votes[1] ? Array.from(poll.votes[1]) : [];
  const playedChannelId = '1466123477055574262';
  const rulesChannelId = '1466123579396718643';
  const creatorLabel = poll.createdByTag ? String(poll.createdByTag) : 'Unknown';

  return new EmbedBuilder()
    .setTitle(poll.question)
    .setColor(0x1E90FF)
    .setDescription(`Poll by ${creatorLabel}`)
    .addFields(
      { name: 'Gespielt wird in', value: `<#${playedChannelId}>`, inline: false },
      { name: 'Regeln', value: `<#${rulesChannelId}>`, inline: false },
      { name: 'Uhrzeit', value: timeText, inline: true },
      { name: 'Betrag', value: amountText, inline: true },
      { name: 'Ja', value: formatVoterList(yesIds), inline: false },
      { name: 'Nein', value: formatVoterList(noIds), inline: false }
    );
}

function loadConfig() {
  const base = path.resolve(__dirname, '..');
  const cfgPath = path.join(base, 'config.json');
  const example = path.join(base, 'config.example.json');
  if (fs.existsSync(cfgPath)) return JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  if (fs.existsSync(example)) return JSON.parse(fs.readFileSync(example, 'utf8'));
  return {};
}

module.exports = {
  name: 'interactionCreate.ticket',
  initClaimScheduler,
  async execute(interaction) {
    try { await initClaimScheduler(interaction.client); } catch (e) {}
    const config = loadConfig();

    // Voice Activity buttons: edit the existing message
    try {
      if (interaction.isButton && interaction.isButton()) {
        const id = String(interaction.customId || '');
        if (id === 'va_refresh' || id.startsWith('va_range:')) {
          if (!voiceActivity) {
            try { return interaction.reply({ content: 'Voice activity module is not available on this deployment.', ephemeral: true }); } catch (e0) {}
            return;
          }
          const range = id === 'va_refresh' ? '7d' : (id.split(':')[1] || '7d');
          const normalized = voiceActivity.normalizeRange(range);
          const embed = await voiceActivity.buildVoiceActivityEmbed(interaction.guild, { range: normalized, viewerId: interaction.user.id });
          const components = voiceActivity.buildVoiceActivityComponents(normalized);
          return interaction.update({ embeds: [embed], components });
        }
      }
    } catch (e) {
      console.error('voice activity button failed', e);
      try { return interaction.reply({ content: 'Failed to update voice activity.', ephemeral: true }); } catch (e2) {}
    }

    // Poll voting buttons
    try {
      if (interaction.isButton && interaction.isButton()) {
        const id = String(interaction.customId || '');
        if (id.startsWith('poll_vote:')) {
          const parts = id.split(':');
          const messageId = parts[1];
          const optionIndex = parseInt(parts[2], 10);
          if (!messageId || isNaN(optionIndex)) return;

          const poll = getPoll(messageId);
          if (!poll) {
            try { return interaction.reply({ content: 'Poll not found or expired.', ephemeral: true }); } catch (e0) {}
            return;
          }

          const userId = String(interaction.user.id);
          let previous = null;
          for (const [idx, set] of Object.entries(poll.votes || {})) {
            if (set && set.has(userId)) previous = Number(idx);
          }
          const shouldGrantYesRole = optionIndex === 0 && previous !== 0;

          let action = 'Vote recorded.';
          if (previous === optionIndex) {
            poll.votes[optionIndex].delete(userId);
            action = 'Vote removed.';
          } else {
            if (previous !== null && poll.votes[previous]) poll.votes[previous].delete(userId);
            if (!poll.votes[optionIndex]) poll.votes[optionIndex] = new Set();
            poll.votes[optionIndex].add(userId);
            action = 'Vote updated.';
          }

          setPoll(messageId, poll);
          if (shouldGrantYesRole && interaction.guild) {
            try {
              const roleId = '1466119165227171951';
              const role = interaction.guild.roles.cache.get(roleId) || await interaction.guild.roles.fetch(roleId).catch(() => null);
              const member = interaction.member || await interaction.guild.members.fetch(userId).catch(() => null);
              if (role && member && member.roles && !member.roles.cache.has(roleId)) {
                await member.roles.add(role, 'Poll: voted Yes').catch(() => {});
              }
            } catch (e0) {}
          }
          try { await interaction.deferUpdate(); } catch (e0) {}
          try { await interaction.message.edit({ embeds: [buildPollEmbed(poll)], components: buildPollComponents(poll) }); } catch (e0) {}
          try { await interaction.followUp({ content: action, ephemeral: true }); } catch (e0) {}
          return;
        }
      }
    } catch (e) {
      console.error('poll vote failed', e);
      try { return interaction.reply({ content: 'Failed to record vote.', ephemeral: true }); } catch (e2) {}
    }

    // resolve staff role id from config: accept raw id, mention, or role name
    function resolveRoleId(guild, raw) {
      if (!raw || !guild) return null;
      const s = String(raw).trim();
      const cleaned = s.replace(/[<@&>]/g, '');
      if (/^\d+$/.test(cleaned)) return cleaned;
      const byName = guild.roles.cache.find(r => r.name === s);
      return byName ? byName.id : null;
    }

    const staffId = (interaction && interaction.guild) ? resolveRoleId(interaction.guild, config.staffRoleId) : null;

    // Slash command handler
    if (interaction.isChatInputCommand()) {
      // support /create here as a fallback to ensure the modal is shown
      if (interaction.commandName === 'create') {
        try {
          const modal = new ModalBuilder().setCustomId('create_modal').setTitle('Paste session announcement');
          const input = new TextInputBuilder().setCustomId('announcement_text').setLabel('Announcement').setStyle(TextInputStyle.Paragraph).setRequired(true).setPlaceholder('Paste the full announcement here...').setMinLength(10).setMaxLength(4000);
          const row = new ActionRowBuilder().addComponents(input);
          modal.addComponents(row);
          await interaction.showModal(modal);
        } catch (e) {
          console.error('ticket interaction create modal failed', e);
          try { await interaction.reply({ content: 'Failed to open the modal.', ephemeral: true }); } catch (e) {}
        }
        return;
      }
      // session is handled centrally in index.js now
      if (interaction.commandName === 'admin') {
        const cmd = require(path.join(__dirname, '..', 'commands', 'admin.js'));
        return cmd.execute(interaction, config);
      }
      if (interaction.commandName === 'sa') {
        const cmd = require(path.join(__dirname, '..', 'commands', 'sa.js'));
        return cmd.execute(interaction, config);
      }
      if (interaction.commandName === 'voiceactivity') {
        const cmd = require(path.join(__dirname, '..', 'commands', 'voiceactivity.js'));
        return cmd.execute(interaction, config);
      }
      if (interaction.commandName === 'poll') {
        console.log('[poll] slash command received', {
          guildId: interaction.guildId,
          channelId: interaction.channelId,
          userId: interaction.user && interaction.user.id,
        });
        try {
          await interaction.deferReply();
          console.log('[poll] deferred reply');
          const question = interaction.options.getString('question', true);
          const timeText = interaction.options.getString('time') || null;
          const amountText = interaction.options.getString('amount') || null;
          const pingEveryone = interaction.options.getBoolean('ping_everyone') === true;
          const rolePing = interaction.options.getRole('role_ping') || null;
          const createdAt = Date.now();
          const poll = {
            messageId: null,
            question: question.trim().slice(0, 256),
            options: ['Ja', 'Nein'],
            votes: { 0: new Set(), 1: new Set() },
            createdBy: interaction.user.id,
            createdByTag: interaction.user.tag || interaction.user.username,
            createdAt,
            timeText: timeText || null,
            amountText: amountText || null,
          };

          const content = rolePing && rolePing.id ? `<@&${rolePing.id}>` : undefined;
          const sent = await interaction.editReply({ content, embeds: [buildPollEmbed(poll)], components: buildPollComponents({ ...poll, messageId: 'pending' }), allowedMentions: { roles: rolePing && rolePing.id ? [rolePing.id] : [] } });
          console.log('[poll] message sent', { messageId: sent && sent.id });
          poll.messageId = sent.id;
          setPoll(sent.id, poll);
          await sent.edit({ embeds: [buildPollEmbed(poll)], components: buildPollComponents(poll) }).catch(() => {});
          if (pingEveryone) {
            try {
              const ping = await interaction.followUp({ content: '@everyone', allowedMentions: { parse: ['everyone'] } });
              setTimeout(() => { try { ping.delete().catch(() => {}); } catch (e0) {} }, 1500);
            } catch (e0) {}
          }
        } catch (e) {
          console.error('poll command failed', e);
          try {
            if (interaction.deferred || interaction.replied) return interaction.editReply({ content: 'Failed to create poll.' });
            return interaction.reply({ content: 'Failed to create poll.', ephemeral: true });
          } catch (e2) {}
        }
        return;
      }

    }

    const handledByTicketClaimFlow = await handleTicketClaimFlow({
      interaction,
      config,
      staffId,
      helpers: {
        parseHHMMToNextMs,
        scheduleDuoClaimJob,
        loadJsonSafe,
        buildDuoClaimRow,
        buildDuoClaimEmbed,
        duoClaimPanels,
        BLACKLIST_PATH,
      },
    });
    if (handledByTicketClaimFlow) return;
  }
};

