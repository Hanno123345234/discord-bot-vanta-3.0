const { EmbedBuilder, PermissionsBitField, ApplicationCommandOptionType } = require('discord.js');

function mergeGuildConfig(cfg, guildId) {
  try {
    if (!cfg || !guildId) return cfg || {};
    const gid = String(guildId);
    const overrides = cfg.guilds && cfg.guilds[gid] && typeof cfg.guilds[gid] === 'object' ? cfg.guilds[gid] : null;
    return overrides ? Object.assign({}, cfg, overrides) : cfg;
  } catch (e) {
    return cfg || {};
  }
}

function resolveRole(guild, raw) {
  if (!guild) return null;

  if (raw) {
    const s = String(raw).trim();
    const cleaned = s.replace(/[<@&>]/g, '');
    if (/^\d+$/.test(cleaned)) return guild.roles.cache.get(cleaned) || null;
    const byName = guild.roles.cache.find(r => r && r.name === s);
    if (byName) return byName;
  }

  // Fallback by common admin role names
  const candidates = guild.roles.cache
    .filter(r => r && r.name && r.name !== '@everyone')
    .filter(r => {
      const n = String(r.name).toLowerCase();
      return n === 'admin' || n === 'administrator' || n.includes('admin');
    })
    .sort((a, b) => b.position - a.position);

  return candidates.first() || null;
}

module.exports = {
  name: 'admin',
  description: 'Gibt einem Nutzer die Admin-Rolle in allen Ziel-Servern',
  data: {
    name: 'admin',
    description: 'Gibt einem Nutzer die Admin-Rolle in allen Ziel-Servern',
    options: [
      {
        name: 'user',
        description: 'Der Nutzer, der die Admin-Rolle bekommen soll',
        type: ApplicationCommandOptionType.User,
        required: true,
      },
      {
        name: 'reason',
        description: 'Grund (optional)',
        type: ApplicationCommandOptionType.String,
        required: false,
      },
    ],
  },

  async execute(interaction, config) {
    await interaction.deferReply({ ephemeral: true });

    const target = interaction.options.getUser('user', true);
    const reason = interaction.options.getString('reason') || 'No reason provided';

    // Safety: require ManageRoles in the guild where command is used
    if (!interaction.memberPermissions || !interaction.memberPermissions.has(PermissionsBitField.Flags.ManageRoles)) {
      return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0x87CEFA).setDescription('You do not have permission to assign admin roles.')] });
    }

    // Targets: same server list as blacklist
    const targetGuildIds = [
      '1459330497938325676',
      '1459345285317791917',
      '1368527215343435826',
      '1339662600903983154',
    ];

    const attempts = [];
    for (const gid of targetGuildIds) {
      const g = interaction.client.guilds.cache.get(gid) || await interaction.client.guilds.fetch(gid).catch(() => null);
      if (!g) {
        attempts.push({ guildId: gid, guildName: null, ok: false, error: 'Bot not in guild / cannot fetch guild' });
        continue;
      }

      const cfg = mergeGuildConfig(config || {}, g.id);
      const role = resolveRole(g, cfg.adminRoleId);
      if (!role) {
        attempts.push({ guildId: g.id, guildName: g.name, ok: false, error: 'Admin role not found (set adminRoleId in config.json)' });
        continue;
      }

      const botMember = g.members.me || await g.members.fetchMe().catch(() => null);
      if (!botMember) {
        attempts.push({ guildId: g.id, guildName: g.name, ok: false, error: 'Bot member not available' });
        continue;
      }

      if (!botMember.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
        attempts.push({ guildId: g.id, guildName: g.name, ok: false, error: 'Missing ManageRoles permission' });
        continue;
      }

      if (role.position >= botMember.roles.highest.position) {
        attempts.push({ guildId: g.id, guildName: g.name, ok: false, error: 'Role is higher/equal than bot role' });
        continue;
      }

      const member = await g.members.fetch(target.id).catch(() => null);
      if (!member) {
        attempts.push({ guildId: g.id, guildName: g.name, ok: false, error: 'User not in guild' });
        continue;
      }

      try {
        await member.roles.add(role, `Admin grant by ${interaction.user.tag}: ${reason}`);
        attempts.push({ guildId: g.id, guildName: g.name, ok: true, roleId: role.id, roleName: role.name });
      } catch (e) {
        attempts.push({ guildId: g.id, guildName: g.name, ok: false, error: String(e.message || e) });
      }
    }

    const okCount = attempts.filter(a => a.ok).length;
    const failCount = attempts.filter(a => !a.ok).length;

    const embed = new EmbedBuilder()
      .setTitle('Admin Role Sync')
      .setColor(0x87CEFA)
      .setDescription(`User: <@${target.id}> (${target.id})`)
      .addFields(
        { name: 'Moderator', value: `<@${interaction.user.id}>`, inline: true },
        { name: 'Reason', value: String(reason).substring(0, 256), inline: true },
        { name: 'Success', value: `${okCount} servers`, inline: true },
        { name: 'Failed', value: `${failCount} servers`, inline: true },
      )
      .setTimestamp();

    const lines = attempts
      .map(a => `${a.ok ? '✅' : '❌'} ${a.guildName || 'Unknown'} (${a.guildId})${a.ok ? ` — ${a.roleName || 'role'} (${a.roleId || ''})` : ` — ${String(a.error || 'failed').substring(0, 80)}`}`)
      .join('\n');

    embed.addFields([{ name: 'Results', value: lines.substring(0, 1024), inline: false }]);

    return interaction.editReply({ embeds: [embed] });
  },
};
