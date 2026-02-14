const { EmbedBuilder } = require('discord.js');

async function handleTicketClaimFlow({ interaction, helpers }) {
  const {
    parseHHMMToNextMs,
    scheduleDuoClaimJob,
    loadJsonSafe,
    buildDuoClaimRow,
    buildDuoClaimEmbed,
    duoClaimPanels,
    BLACKLIST_PATH,
  } = helpers;

  if (interaction.isChatInputCommand()) {
    if (interaction.commandName === 'claim') {
      try {
        const timeRaw = interaction.options.getString('time', true);
        const gamemode = String(interaction.options.getString('gamemode', true) || 'Duos').trim().slice(0, 50) || 'Duos';
        const session = interaction.options.getInteger('session', true);
        const reload = interaction.options.getBoolean('reload') === true;

        const targetMs = parseHHMMToNextMs(timeRaw, new Date());
        if (!targetMs) {
          await interaction.reply({
            embeds: [new EmbedBuilder().setColor(0x87CEFA).setDescription('Invalid `time`. Please use `HH:MM` (24h).')],
            ephemeral: true,
          });
          return true;
        }

        const scheduleKey = `${String(interaction.guildId || 'dm')}:${String(interaction.channelId)}:${String(gamemode).toLowerCase()}:${session}`;
        const job = {
          scheduleKey,
          guildId: String(interaction.guildId || ''),
          channelId: String(interaction.channelId || ''),
          targetMs,
          gamemode,
          session,
          reload,
          createdAt: Date.now(),
          createdBy: String(interaction.user.id || ''),
        };
        scheduleDuoClaimJob(interaction.client, job, { persist: true });

        const ts = Math.floor(targetMs / 1000);
        await interaction.reply({ content: `Claim scheduled <t:${ts}:F>`, ephemeral: false });
        return true;
      } catch (e) {
        console.error('claim command failed', e);
        await interaction.reply({
          embeds: [new EmbedBuilder().setColor(0x87CEFA).setDescription('Failed to schedule claim panel.')],
          ephemeral: true,
        }).catch(() => null);
        return true;
      }
    }

    if (interaction.commandName === 'whois') {
      try {
        const raw = String(interaction.options.getString('user', true) || '').trim();
        const cleaned = raw.replace(/[<@!>\s]/g, '');
        if (!/^\d{15,20}$/.test(cleaned)) {
          await interaction.reply({
            embeds: [new EmbedBuilder().setColor(0x87CEFA).setDescription('Please provide a valid user mention or ID.')],
            ephemeral: true,
          });
          return true;
        }

        const targetId = cleaned;
        const targetUser = await interaction.client.users.fetch(targetId).catch(() => null);
        const member = interaction.guild ? await interaction.guild.members.fetch(targetId).catch(() => null) : null;

        const blacklistData = loadJsonSafe(BLACKLIST_PATH, { blacklisted: [] });
        const entries = Array.isArray(blacklistData && blacklistData.blacklisted) ? blacklistData.blacklisted : [];
        const banEntry = entries.find(x => x && String(x.id || '') === String(targetId) && String(x.type || 'user') !== 'guild') || null;
        const isBanned = !!banEntry;
        const banReasonRaw = String((banEntry && banEntry.reason) || 'No reason provided');
        const banReason = banReasonRaw.length > 220 ? `${banReasonRaw.slice(0, 217)}...` : banReasonRaw;
        const banModeratorId = banEntry && banEntry.moderator ? String(banEntry.moderator) : null;
        const banStaffText = banModeratorId ? `<@${banModeratorId}> (${banModeratorId})` : 'Unknown';
        const banDate = (banEntry && banEntry.time)
          ? new Date(Number(banEntry.time)).toLocaleString('en-GB', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
          : 'Unknown';

        const regDate = targetUser && targetUser.createdAt
          ? new Date(targetUser.createdAt).toLocaleString('en-GB', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
          : 'Unknown';

        const joinedDate = member && member.joinedAt
          ? new Date(member.joinedAt).toLocaleString('en-GB', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
          : 'N/A';

        const roleMentions = member
          ? member.roles.cache
            .filter(r => r && r.id !== interaction.guild.id)
            .sort((a, b) => b.position - a.position)
            .map(r => `<@&${r.id}>`)
          : [];

        let rolesText = 'None';
        if (roleMentions.length) {
          const out = [];
          let size = 0;
          for (const m of roleMentions) {
            if (size + m.length + 2 > 1024) break;
            out.push(m);
            size += m.length + 2;
          }
          rolesText = out.join(', ') || 'None';
        }

        const timeoutActive = !!(member && member.communicationDisabledUntilTimestamp && member.communicationDisabledUntilTimestamp > Date.now());
        const timeoutText = timeoutActive ? `Timed out until <t:${Math.floor(member.communicationDisabledUntilTimestamp / 1000)}:F>` : 'Not timed out';

        const displayName = targetUser ? targetUser.username : `user ${targetId}`;
        const userField = `<@${targetId}>\n(${targetId})`;
        const statusField = isBanned
          ? `🚫 BANNED\nReason: ${banReason}\n*Appeal your ban here or in Nova Appeals Hub*`
          : '🟢 NOT BANNED\nReason: none\n*No active ban on record*';

        const embed = new EmbedBuilder()
          .setColor(isBanned ? 0xED4245 : 0x87CEFA)
          .setTitle(`${displayName}'s Info`)
          .addFields(
            { name: 'User', value: userField, inline: true },
            { name: 'Server Status', value: statusField, inline: true },
            { name: 'Registered', value: regDate, inline: true },
            { name: '\u200B', value: '\u200B', inline: false },
            { name: 'Joined', value: joinedDate, inline: false },
            { name: `Roles [${roleMentions.length}]`, value: rolesText, inline: false },
            { name: 'Timeout Status', value: timeoutText, inline: false }
          );

        if (isBanned) {
          embed.addFields({
            name: 'Blacklist Log',
            value: `User ID: ${targetId}\nReason: ${banReason}\nStaff: ${banStaffText}\nDate: ${banDate}`,
            inline: false,
          });
        }

        const avatar = targetUser ? targetUser.displayAvatarURL({ size: 256, extension: 'png' }) : null;
        if (avatar) embed.setThumbnail(avatar);

        await interaction.reply({ embeds: [embed] });
        return true;
      } catch (e) {
        console.error('whois command failed', e);
        await interaction.reply({
          embeds: [new EmbedBuilder().setColor(0x87CEFA).setDescription('Failed to load whois info.')],
          ephemeral: true,
        }).catch(() => null);
        return true;
      }
    }

    return false;
  }

  if (interaction.isButton() && typeof interaction.customId === 'string' && (interaction.customId.startsWith('duo_claim_add:') || interaction.customId.startsWith('duo_claim_remove:'))) {
    await interaction.deferReply({ ephemeral: true });
    try {
      const isUnclaimAction = interaction.customId.startsWith('duo_claim_remove:');
      const msgId = String(interaction.customId.split(':')[1] || interaction.message?.id || '');
      if (!msgId || msgId === 'pending') {
        await interaction.editReply({ embeds: [new EmbedBuilder().setColor(0x87CEFA).setDescription('Claim panel is not ready yet.')] });
        return true;
      }

      const state = duoClaimPanels.get(msgId);
      if (!state) {
        await interaction.editReply({ embeds: [new EmbedBuilder().setColor(0x87CEFA).setDescription('Claim panel expired or not found.')] });
        return true;
      }

      if (!Array.isArray(state.claims)) {
        const migrated = [];
        if (state.lobby1) migrated.push(String(state.lobby1));
        if (state.lobby2) migrated.push(String(state.lobby2));
        state.claims = migrated;
        delete state.lobby1;
        delete state.lobby2;
      }

      const uid = String(interaction.user.id);
      let info = '';
      const claims = state.claims;

      if (isUnclaimAction) {
        const idx = claims.indexOf(uid);
        if (idx !== -1) {
          claims.splice(idx, 1);
          info = 'You unclaimed your session.';
        } else {
          await interaction.editReply({ embeds: [new EmbedBuilder().setColor(0x87CEFA).setDescription('You have no claimed session to unclaim.')] });
          return true;
        }
      } else if (claims.includes(uid)) {
        await interaction.editReply({ embeds: [new EmbedBuilder().setColor(0x87CEFA).setDescription('You already claimed a lobby. Use Unclaim first.')] });
        return true;
      } else {
        claims.push(uid);
        info = `You claimed Lobby ${claims.length}.`;
      }

      const row = buildDuoClaimRow(msgId);

      await interaction.message.edit({
        embeds: [buildDuoClaimEmbed(state)],
        components: [row],
        allowedMentions: { parse: ['users'] }
      }).catch(() => {});

      await interaction.editReply({ embeds: [new EmbedBuilder().setColor(0x87CEFA).setDescription(info)] });
      return true;
    } catch (e) {
      console.error('duo claim button failed', e);
      await interaction.editReply({ embeds: [new EmbedBuilder().setColor(0x87CEFA).setDescription('Failed to update claim panel.')] });
      return true;
    }
  }

  return false;
}

module.exports = {
  handleTicketClaimFlow,
};
