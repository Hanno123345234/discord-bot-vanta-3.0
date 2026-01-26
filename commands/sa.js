const { ApplicationCommandOptionType, PermissionsBitField } = require('discord.js');

function parseHHMM(input) {
  if (!input) return null;
  const s = String(input).trim();
  const m = s.match(/^(\d{1,2})\s*[:.]\s*(\d{2})$/);
  if (!m) return null;
  const hh = parseInt(m[1], 10);
  const mm = parseInt(m[2], 10);
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
  return { hh, mm };
}

function resolveNextTimestampSeconds(hh, mm, now = new Date()) {
  const d = new Date(now);
  d.setSeconds(0, 0);
  d.setHours(hh, mm, 0, 0);

  // If time already passed today, schedule for tomorrow.
  if (d.getTime() < (now.getTime() - 60_000)) {
    d.setDate(d.getDate() + 1);
  }

  return Math.floor(d.getTime() / 1000);
}

function buildAnnouncement({ mode, regTs, gameTs, staffMentions, includeEveryone }) {
  const lines = [];

  if (mode === 'alpha') {
    lines.push('### Duo Practice Session <:alpha:1433978499601006725>');
    lines.push('');
    lines.push(`> * **Registration Opens:** <t:${regTs}:t>`);
    lines.push(`> * **Game 1/3:** <t:${gameTs}:t>`);
    lines.push('');
    lines.push(`Staff in charge: ${staffMentions || '<@1191442500976640172>'} `);
    lines.push('');
    lines.push('**-** Session lasts **3 games**, **Missing a single game will get you banned.**');
    lines.push('**-** Make sure to read https://discord.com/channels/1345822793631268971/1345822794771857492, https://discord.com/channels/1345822793631268971/1345822794771857493 & https://discord.com/channels/1345822793631268971/1382471501994787010 **before** playing.');
    lines.push('');
    lines.push('**55+ reacts** | **110+ for second** (1 per duo)');
    lines.push('');
    if (includeEveryone) lines.push('@everyone');
  } else {
    lines.push('### Duo Practice Session <:beta:1433978497633615872>');
    lines.push('');
    lines.push(`> * **Registration Opens:** <t:${regTs}:t>`);
    lines.push(`> * **Game 1/3:** <t:${gameTs}:t>`);
    lines.push('');
    lines.push(`Staff in charge: ${staffMentions || '<@&1348295963579519139>'} `);
    lines.push('');
    lines.push('**-** Session lasts **3 games**, **Missing a single game will get you banned.**');
    lines.push('**-** Make sure to read https://discord.com/channels/1348295963571126282/1407505477566468137, https://discord.com/channels/1348295963571126282/1348295963793424454 & https://discord.com/channels/1348295963571126282/1407503876067954791 **before** playing.');
    lines.push('**-** **Bottom 5** will be kicked from the server');
    lines.push('');
    lines.push('**55+ reacts** | **110+ for second** (1 per duo)');
    lines.push('');
    if (includeEveryone) lines.push('@everyone');
  }

  return lines.join('\n');
}

module.exports = {
  name: 'sa',
  description: 'Posts a session announcement with Hammertime times',
  data: {
    name: 'sa',
    description: 'Posts a session announcement with Hammertime times',
    options: [
      {
        name: 'reg',
        description: 'Registration time (HH:MM)',
        type: ApplicationCommandOptionType.String,
        required: true,
      },
      {
        name: 'game',
        description: 'Game time (HH:MM)',
        type: ApplicationCommandOptionType.String,
        required: true,
      },
      {
        name: 'mode',
        description: 'beta or alpha template',
        type: ApplicationCommandOptionType.String,
        required: false,
        choices: [
          { name: 'beta', value: 'beta' },
          { name: 'alpha', value: 'alpha' },
        ],
      },
      {
        name: 'staff',
        description: 'Optional staff mention text (e.g. @role or @user)',
        type: ApplicationCommandOptionType.String,
        required: false,
      },
      {
        name: 'everyone',
        description: 'Include @everyone ping (requires permission)',
        type: ApplicationCommandOptionType.Boolean,
        required: false,
      },
    ],
  },

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const modeRaw = interaction.options.getString('mode') || 'beta';
    const mode = String(modeRaw).toLowerCase() === 'alpha' ? 'alpha' : 'beta';
    const regRaw = interaction.options.getString('reg', true);
    const gameRaw = interaction.options.getString('game', true);
    const staffMentions = interaction.options.getString('staff') || null;
    const everyoneOpt = interaction.options.getBoolean('everyone');

    const reg = parseHHMM(regRaw);
    const game = parseHHMM(gameRaw);
    if (!reg) return interaction.editReply('Invalid `reg` time. Use `HH:MM` (example: `20:12`).');
    if (!game) return interaction.editReply('Invalid `game` time. Use `HH:MM` (example: `20:45`).');

    const now = new Date();
    const regTs = resolveNextTimestampSeconds(reg.hh, reg.mm, now);
    let gameTs = resolveNextTimestampSeconds(game.hh, game.mm, now);
    if (gameTs <= regTs) gameTs = gameTs + 86400;

    // Staff-User-Auswahl: IDs und Namen aus Guild holen
    // IDs für beta und alpha getrennt
    const staffUserIdsBeta = [
      '871647871546580993',
      '1327994389208760340',
      '799318648128667648',
      '674251120998350896',
      '876458296100417576',
      '694493019340275723',
    ];
    const staffUserIdsAlpha = [
      // Beispiel-IDs für alpha, ggf. anpassen:
      '871647871546580993',
      '1327994389208760340',
      '799318648128667648',
      '674251120998350896',
      '876458296100417576',
      '694493019340275723',
    ];
    const staffUserIds = mode === 'alpha' ? staffUserIdsAlpha : staffUserIdsBeta;
    let staffOptions = [];
    if (interaction.guild) {
      for (const id of staffUserIds) {
        const member = await interaction.guild.members.fetch(id).catch(() => null);
        if (member) {
          staffOptions.push({ label: member.user.username, value: id });
        }
      }
    }
    if (!staffOptions.length) staffOptions = [{ label: 'Kein Staff gefunden', value: 'none' }];

    // Zeige SelectMenu zur Auswahl
    const { ActionRowBuilder, StringSelectMenuBuilder } = require('discord.js');
    const select = new StringSelectMenuBuilder()
      .setCustomId('sa_staff_select')
      .setPlaceholder('Wähle Staff für die Session (optional)')
      .setMinValues(0)
      .setMaxValues(staffOptions.length)
      .addOptions(staffOptions);
    const row = new ActionRowBuilder().addComponents(select);

    await interaction.editReply({
      content: 'Select the staff members to mention in the announcement (or skip to mention @staff):',
      components: [row],
      ephemeral: true,
    });

    // Collector für Auswahl
    const collector = interaction.channel.createMessageComponentCollector({
      filter: i => i.user.id === interaction.user.id && i.customId === 'sa_staff_select',
      time: 60_000,
      max: 1,
    });

    collector.on('collect', async (selectInt) => {
      const selectedIds = selectInt.values.filter(v => v !== 'none');
      let staffMentionLine = '';
      if (selectedIds.length > 0) {
        staffMentionLine = selectedIds.map(id => `<@${id}>`).join(' ');
      } else {
        staffMentionLine = '@staff';
      }
      // Decide whether we are allowed to ping @everyone.
      let includeEveryone = Boolean(everyoneOpt);
      if (includeEveryone) {
        const canMentionEveryone = interaction.memberPermissions && interaction.memberPermissions.has(PermissionsBitField.Flags.MentionEveryone);
        if (!canMentionEveryone) includeEveryone = false;
      }
      const content = buildAnnouncement({ mode, regTs, gameTs, staffMentions: staffMentionLine, includeEveryone });
      const sent = await interaction.channel.send({
        content,
        allowedMentions: {
          parse: ['users', 'roles'],
          users: selectedIds,
          everyone: includeEveryone,
        },
      }).catch(() => null);
      if (!sent) return selectInt.reply({ content: 'I could not send the announcement in this channel (missing permission?).', ephemeral: true });
      await selectInt.reply({ content: `✅ Posted: ${sent.url}`, ephemeral: true });
    });

    collector.on('end', async (collected) => {
      if (collected.size === 0) {
        // Timeout: poste mit @staff
        let staffMentionLine = '@staff';
        let includeEveryone = Boolean(everyoneOpt);
        if (includeEveryone) {
          const canMentionEveryone = interaction.memberPermissions && interaction.memberPermissions.has(PermissionsBitField.Flags.MentionEveryone);
          if (!canMentionEveryone) includeEveryone = false;
        }
        const content = buildAnnouncement({ mode, regTs, gameTs, staffMentions: staffMentionLine, includeEveryone });
        const sent = await interaction.channel.send({
          content,
          allowedMentions: {
            parse: ['users', 'roles'],
            everyone: includeEveryone,
          },
        }).catch(() => null);
        if (sent) await interaction.followUp({ content: `✅ Posted: ${sent.url}`, ephemeral: true });
      }
    });
  },
};

module.exports.buildAnnouncement = buildAnnouncement;
module.exports.parseHHMM = parseHHMM;
module.exports.resolveNextTimestampSeconds = resolveNextTimestampSeconds;
