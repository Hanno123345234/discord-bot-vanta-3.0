const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, PermissionsBitField } = require('discord.js');
const path = require('path');
const fs = require('fs');
const { createTranscript } = require('../utils/transcript');
const { sendLog } = require('../utils/logger');

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
  async execute(interaction) {
    const config = loadConfig();

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

    // Slash command handler for /ticket
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === 'ticket') {
        const cmd = require(path.join(__dirname, '..', 'commands', 'ticket.js'));
        return cmd.execute(interaction, config);
      }
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

      // Do not auto-reply for unhandled chat input commands here.
      // Let other handlers (possibly consolidated in index.js) process the interaction.
      return;
    }

    // Handle select menu for ticket creation
    if (interaction.isStringSelectMenu() && interaction.customId === 'ticket_create') {
      await interaction.deferReply({ ephemeral: true });
      try {
        const type = interaction.values[0] || 'support';
        const guild = interaction.guild;
        if (!guild) {
          const e = new EmbedBuilder().setColor(0x87CEFA).setDescription('This menu can only be used on a server.');
          return interaction.editReply({ embeds: [e] });
        }

        const maxOpen = config.maxOpenPerUser || 1;
        const userId = interaction.user.id;
        // find existing tickets by topic convention ticket:<userId>:
        const existing = guild.channels.cache.find(c => c.topic && c.topic.startsWith(`ticket:${userId}:`));
        if (existing) {
          const e = new EmbedBuilder().setColor(0x87CEFA).setDescription('You already have an open ticket. Please close it first.');
          return interaction.editReply({ embeds: [e] });
        }

        // category: accept a real snowflake, otherwise ignore placeholder and fallback by name/create
        let categoryId = config.ticketCategoryId || null;
        if (categoryId && String(categoryId).includes('REPLACE_WITH')) categoryId = null;
        if (categoryId) categoryId = String(categoryId).replace(/[<#>]/g, '');
        if (categoryId && !/^\d+$/.test(categoryId)) categoryId = null;

        if (!categoryId) {
          const existingCat = guild.channels.cache.find(c => c && c.type === 4 && ['tickets', 'ticket', 'support', 'support-tickets'].includes(String(c.name || '').toLowerCase())) || null;
          if (existingCat) categoryId = existingCat.id;
          else {
            const catOverwrites = [ { id: everyone.id, deny: [PermissionsBitField.Flags.ViewChannel] } ];
            if (staffId) catOverwrites.push({ id: staffId, allow: [PermissionsBitField.Flags.ViewChannel] });
            const createdCat = await guild.channels.create({ name: 'tickets', type: 4, permissionOverwrites: catOverwrites });
            categoryId = createdCat.id;
          }
        }

        const channelName = `ticket-${userId}`;

        const everyone = guild.roles.everyone;
        const overwrites = [ { id: everyone.id, deny: [PermissionsBitField.Flags.ViewChannel] } ];
        if (staffId) overwrites.push({ id: staffId, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] });
        overwrites.push({ id: userId, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] });

        const channel = await guild.channels.create({ name: channelName, type: 0, parent: categoryId || undefined, permissionOverwrites: overwrites, topic: `ticket:${userId}:${type}` });

        const embed = new EmbedBuilder()
          .setTitle('New Ticket')
          .setDescription(`Ticket from <@${userId}> — Type: **${type}**`)
          .setColor(0x87CEFA)
          .addFields([{ name: 'Note', value: 'Staff will handle this as soon as possible. Use the button below to close the ticket.' }]);

        const closeBtn = new ButtonBuilder().setCustomId('ticket_close').setLabel('Close Ticket').setStyle(ButtonStyle.Danger);
        const claimBtn = new ButtonBuilder().setCustomId('ticket_claim').setLabel('Claim Ticket').setStyle(ButtonStyle.Primary);
        const row = new ActionRowBuilder().addComponents(claimBtn, closeBtn);

        await channel.send({ content: `<@${userId}>`, embeds: [embed], components: [row] });

        // notify user
        await interaction.editReply({ embeds: [new EmbedBuilder().setColor(0x87CEFA).setDescription(`Your ticket was created: ${channel}`)], ephemeral: true });
        // log creation
          try {
          await sendLog(guild, { embeds: [new EmbedBuilder().setColor(0x87CEFA).setTitle('Ticket created').setDescription(`Ticket ${channel} created by <@${userId}> Type: ${type}`)] });
        } catch (e) { console.error('ticket log send failed', e); }

          } catch (e) {
        console.error('ticket create failed', e);
        try { await interaction.editReply({ embeds: [new EmbedBuilder().setColor(0x87CEFA).setDescription('Failed to create the ticket.')] }); } catch {};
      }
      return;
    }

    // Handle close button
    if (interaction.isButton() && interaction.customId === 'ticket_close') {
      await interaction.deferReply({ ephemeral: true });
      try {
        const channel = interaction.channel;
        if (!channel || !channel.topic || !channel.topic.startsWith('ticket:')) return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0x87CEFA).setDescription('This button can only be used in ticket channels.')] });
        const parts = channel.topic.split(':');
        const ownerId = parts[1];
        const type = parts[2] || 'support';

        const member = await interaction.guild.members.fetch(interaction.user.id).catch(()=>null);
        const isOwner = interaction.user.id === ownerId;
        const isStaff = member ? (staffId && member.roles.cache.has(staffId)) || member.permissions.has(PermissionsBitField.Flags.ManageGuild) : false;
        if (!isOwner && !isStaff) return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0x87CEFA).setDescription('Only the creator or staff can close the ticket.')] });

        // show modal to collect reason
        const modal = new ModalBuilder().setCustomId(`ticket_confirm_close:${channel.id}`).setTitle('Close Ticket');
        const input = new TextInputBuilder().setCustomId('close_reason').setLabel('Reason (optional)').setStyle(TextInputStyle.Paragraph).setRequired(false).setPlaceholder('Short note why closing');
        const row = new ActionRowBuilder().addComponents(input);
        modal.addComponents(row);
        // log that a close modal is about to be shown (close requested)
        try {
          await sendLog(interaction.guild, { embeds: [new EmbedBuilder().setColor(0xFFAA00).setTitle('Ticket close requested').setDescription(`Close requested for ${channel.name} by <@${interaction.user.id}>`)] });
        } catch (e) { console.error('ticket close modal log failed', e); }

        await interaction.showModal(modal);
        return;
      } catch (e) {
        console.error('ticket close button failed', e);
        return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0x87CEFA).setDescription('Failed to start the close process.')] });
      }
    }

    // Handle claim button
    if (interaction.isButton() && interaction.customId === 'ticket_claim') {
      await interaction.deferReply({ ephemeral: true });
      try {
        const channel = interaction.channel;
        if (!channel || !channel.topic || !channel.topic.startsWith('ticket:')) return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0x87CEFA).setDescription('This button can only be used in ticket channels.')] });
        const parts = channel.topic.split(':');
        const ownerId = parts[1];
        const type = parts[2] || 'support';
        const claimedBy = parts[3] || null;

        const member = await interaction.guild.members.fetch(interaction.user.id).catch(()=>null);
        const isStaff = member ? (staffId && member.roles.cache.has(staffId)) || member.permissions.has(PermissionsBitField.Flags.ManageGuild) : false;
        if (!isStaff) return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0x87CEFA).setDescription('Only staff can claim tickets.')] });

        if (claimedBy) {
          if (claimedBy === interaction.user.id) {
            // Unclaim
            channel.setTopic(`ticket:${ownerId}:${type}`);
            const embed = new EmbedBuilder()
              .setTitle('Ticket unclaimed')
              .setDescription(`Ticket from <@${ownerId}> — Type: **${type}**\nNo longer claimed.`)
              .setColor(0x87CEFA)
              .addFields([{ name: 'Note', value: 'Staff will handle this as soon as possible. Use the button below to close the ticket.' }]);

            const claimBtn = new ButtonBuilder().setCustomId('ticket_claim').setLabel('Claim Ticket').setStyle(ButtonStyle.Primary);
            const closeBtn = new ButtonBuilder().setCustomId('ticket_close').setLabel('Close Ticket').setStyle(ButtonStyle.Danger);
            const row = new ActionRowBuilder().addComponents(claimBtn, closeBtn);

            await channel.messages.fetch({ limit: 1 }).then(messages => {
              const msg = messages.first();
              if (msg && msg.embeds.length > 0) msg.edit({ embeds: [embed], components: [row] });
            });

            await interaction.editReply({ embeds: [new EmbedBuilder().setColor(0x87CEFA).setDescription('Ticket unclaimed.')] });
            try {
              await sendLog(interaction.guild, { embeds: [new EmbedBuilder().setColor(0xFFFF00).setTitle('Ticket unclaimed').setDescription(`Ticket ${channel.name} unclaimed von <@${interaction.user.id}>`)] });
            } catch (e) {}
          } else {
            return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0x87CEFA).setDescription('This ticket has already been claimed by someone else.')] });
          }
        } else {
          // Claim
          channel.setTopic(`ticket:${ownerId}:${type}:${interaction.user.id}`);
          const embed = new EmbedBuilder()
            .setTitle('Ticket claimed')
            .setDescription(`Ticket von <@${ownerId}> — Typ: **${type}**\nClaimed von <@${interaction.user.id}>`)
            .setColor(0x00FF00)
            .addFields([{ name: 'Note', value: 'Staff will address this as soon as possible. Use the button below to close the ticket.' }]);

          const unclaimBtn = new ButtonBuilder().setCustomId('ticket_claim').setLabel('Unclaim Ticket').setStyle(ButtonStyle.Secondary);
          const closeBtn = new ButtonBuilder().setCustomId('ticket_close').setLabel('Close Ticket').setStyle(ButtonStyle.Danger);
          const row = new ActionRowBuilder().addComponents(unclaimBtn, closeBtn);

          await channel.messages.fetch({ limit: 1 }).then(messages => {
            const msg = messages.first();
            if (msg && msg.embeds.length > 0) msg.edit({ embeds: [embed], components: [row] });
          });

          await interaction.editReply({ embeds: [new EmbedBuilder().setColor(0x87CEFA).setDescription('Ticket claimed.')] });
          try {
            await sendLog(interaction.guild, { embeds: [new EmbedBuilder().setColor(0x00FF00).setTitle('Ticket claimed').setDescription(`Ticket ${channel.name} claimed von <@${interaction.user.id}>`)] });
          } catch (e) {}
        }
      } catch (e) {
        console.error('ticket claim button failed', e);
        return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0x87CEFA).setDescription('Failed to claim the ticket.')] });
      }
    }

    // Modal submit for closing
    if (interaction.isModalSubmit() && interaction.customId && interaction.customId.startsWith('ticket_confirm_close:')) {
      await interaction.deferReply({ ephemeral: true });
      try {
        const channelId = interaction.customId.split(':')[1];
        const channel = interaction.guild.channels.cache.get(channelId) || interaction.channel;
        if (!channel) return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0x87CEFA).setDescription('Ticket channel not found.')] });
        const reason = interaction.fields.getTextInputValue('close_reason') || 'Kein Grund angegeben';

        // permission check again
        const topic = channel.topic || '';
        if (!topic.startsWith('ticket:')) return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0x87CEFA).setDescription('Not a ticket channel.')] });
        const ownerId = topic.split(':')[1];

        const member = await interaction.guild.members.fetch(interaction.user.id).catch(()=>null);
        const isOwner = interaction.user.id === ownerId;
        const isStaff = member ? (staffId && member.roles.cache.has(staffId)) || member.permissions.has(PermissionsBitField.Flags.ManageGuild) : false;
        if (!isOwner && !isStaff) return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0x87CEFA).setDescription('Only the creator or staff can close the ticket.')] });

        // create transcript
        const base = path.resolve(__dirname, '..');
        const folder = path.join(base, config.transcriptFolder || 'transcripts');
        if (!fs.existsSync(folder)) fs.mkdirSync(folder, { recursive: true });
        const { txtPath, htmlPath } = await createTranscript(channel, folder);

        // send transcript to log channel if configured
        try {
          await sendLog(interaction.guild, { embeds: [new EmbedBuilder().setTitle('Ticket closed').setDescription(`Ticket ${channel.name} closed by <@${interaction.user.id}>\nReason: ${reason}`)], files: [txtPath, htmlPath].filter(Boolean) });
        } catch (e) { console.error('failed to send transcript to log channel', e); }

        // DM owner with transcript
        try {
          const owner = await interaction.client.users.fetch(ownerId).catch(()=>null);
            if (owner) {
            await owner.send({ embeds: [new EmbedBuilder().setTitle('Your ticket has been closed').setDescription(`Reason: ${reason}`)], files: [txtPath] }).catch(()=>{});
          }
        } catch (e) {}

        // remove ticket: delete only this ticket channel (keep shared category)
        try {
          try { await channel.send({ embeds: [new EmbedBuilder().setTitle('Ticket closed').setDescription(`This ticket was closed by <@${interaction.user.id}>\nReason: ${reason}`)] }).catch(()=>{}); } catch(e) {}
          try { await channel.delete().catch(()=>{}); } catch (e) { console.error('failed to delete ticket channel', e); }
        } catch (e) { console.error('failed to remove ticket', e); }

        try { await interaction.editReply({ embeds: [new EmbedBuilder().setColor(0x87CEFA).setDescription('Ticket closed, transcript created and channel removed.')] }); } catch(e) {}
        return;
      } catch (e) {
        console.error('modal submit close failed', e);
        return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0x87CEFA).setDescription('Failed to close the ticket.')] });
      }
    }
  }
}; 
