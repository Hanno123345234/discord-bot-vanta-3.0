const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, PermissionsBitField } = require('discord.js');
const path = require('path');
const fs = require('fs');
const { createTranscript } = require('../utils/transcript');

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
      return;
    }

    // Handle select menu for ticket creation
    if (interaction.isStringSelectMenu() && interaction.customId === 'ticket_create') {
      await interaction.deferReply({ ephemeral: true });
      try {
        const type = interaction.values[0] || 'support';
        const guild = interaction.guild;
        if (!guild) return interaction.editReply('Dieses Menü kann nur auf einem Server verwendet werden.');

        const maxOpen = config.maxOpenPerUser || 1;
        const userId = interaction.user.id;
        // find existing tickets by topic convention ticket:<userId>:
        const existing = guild.channels.cache.find(c => c.topic && c.topic.startsWith(`ticket:${userId}:`));
        if (existing) return interaction.editReply('Du hast bereits ein offenes Ticket. Bitte schließe es zuerst.');

        const categoryId = config.ticketCategoryId || null;
        const channelName = `ticket-${userId}`;

        const everyone = guild.roles.everyone;
        const overwrites = [ { id: everyone.id, deny: [PermissionsBitField.Flags.ViewChannel] } ];
        if (staffId) overwrites.push({ id: staffId, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] });
        overwrites.push({ id: userId, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] });

        const channel = await guild.channels.create({ name: channelName, type: 0, parent: categoryId || undefined, permissionOverwrites: overwrites, topic: `ticket:${userId}:${type}` });

        const embed = new EmbedBuilder()
          .setTitle('Neues Ticket')
          .setDescription(`Ticket von <@${userId}> — Typ: **${type}**`) 
          .setColor(0x8A2BE2)
          .addFields({ name: 'Hinweis', value: 'Staff wird sich so schnell wie möglich darum kümmern. Benutze den Button unten, um das Ticket zu schließen.' });

        const closeBtn = new ButtonBuilder().setCustomId('ticket_close').setLabel('Close Ticket').setStyle(ButtonStyle.Danger);
        const row = new ActionRowBuilder().addComponents(closeBtn);

        await channel.send({ content: `<@${userId}>`, embeds: [embed], components: [row] });

        // notify user
        await interaction.editReply({ content: `Dein Ticket wurde erstellt: ${channel}`, ephemeral: true });
        // log creation
        try {
          await sendLog(guild, { embeds: [new EmbedBuilder().setColor(0x00AAFF).setTitle('Ticket erstellt').setDescription(`Ticket ${channel} erstellt von <@${userId}> Typ: ${type}`)] });
        } catch (e) { console.error('ticket log send failed', e); }

      } catch (e) {
        console.error('ticket create failed', e);
        try { await interaction.editReply('Fehler beim Erstellen des Tickets.'); } catch {};
      }
      return;
    }

    // Handle close button
    if (interaction.isButton() && interaction.customId === 'ticket_close') {
      await interaction.deferReply({ ephemeral: true });
      try {
        const channel = interaction.channel;
        if (!channel || !channel.topic || !channel.topic.startsWith('ticket:')) return interaction.editReply('Dieses Knopf kann nur in Ticket-Kanälen verwendet werden.');
        const parts = channel.topic.split(':');
        const ownerId = parts[1];
        const type = parts[2] || 'support';

        const member = await interaction.guild.members.fetch(interaction.user.id).catch(()=>null);
        const isOwner = interaction.user.id === ownerId;
        const isStaff = member ? (staffId && member.roles.cache.has(staffId)) || member.permissions.has(PermissionsBitField.Flags.ManageGuild) : false;
        if (!isOwner && !isStaff) return interaction.editReply('Nur der Ersteller oder Staff kann das Ticket schließen.');

        // show modal to collect reason
        const modal = new ModalBuilder().setCustomId(`ticket_confirm_close:${channel.id}`).setTitle('Ticket schließen');
        const input = new TextInputBuilder().setCustomId('close_reason').setLabel('Grund (optional)').setStyle(TextInputStyle.Paragraph).setRequired(false).setPlaceholder('Kurze Notiz warum geschlossen wird');
        const row = new ActionRowBuilder().addComponents(input);
        modal.addComponents(row);
        // log that a close modal is about to be shown (close requested)
        try {
          await sendLog(interaction.guild, { embeds: [new EmbedBuilder().setColor(0xFFAA00).setTitle('Ticket-Schließung angefragt').setDescription(`Schließung angefragt für ${channel.name} von <@${interaction.user.id}>`)] });
        } catch (e) { console.error('ticket close modal log failed', e); }

        await interaction.showModal(modal);
        return;
      } catch (e) {
        console.error('ticket close button failed', e);
        return interaction.editReply('Fehler beim Starten des Schließvorgangs.');
      }
    }

    // Modal submit for closing
    if (interaction.isModalSubmit() && interaction.customId && interaction.customId.startsWith('ticket_confirm_close:')) {
      await interaction.deferReply({ ephemeral: true });
      try {
        const channelId = interaction.customId.split(':')[1];
        const channel = interaction.guild.channels.cache.get(channelId) || interaction.channel;
        if (!channel) return interaction.editReply('Ticket-Kanal nicht gefunden.');
        const reason = interaction.fields.getTextInputValue('close_reason') || 'Kein Grund angegeben';

        // permission check again
        const topic = channel.topic || '';
        if (!topic.startsWith('ticket:')) return interaction.editReply('Kein Ticket-Kanal.');
        const ownerId = topic.split(':')[1];

        const member = await interaction.guild.members.fetch(interaction.user.id).catch(()=>null);
        const isOwner = interaction.user.id === ownerId;
        const isStaff = member ? (staffId && member.roles.cache.has(staffId)) || member.permissions.has(PermissionsBitField.Flags.ManageGuild) : false;
        if (!isOwner && !isStaff) return interaction.editReply('Nur der Ersteller oder Staff kann das Ticket schließen.');

        // create transcript
        const base = path.resolve(__dirname, '..');
        const folder = path.join(base, config.transcriptFolder || 'transcripts');
        if (!fs.existsSync(folder)) fs.mkdirSync(folder, { recursive: true });
        const { txtPath, htmlPath } = await createTranscript(channel, folder);

        // send transcript to log channel if configured
        try {
          await sendLog(interaction.guild, { embeds: [new EmbedBuilder().setTitle('Ticket geschlossen').setDescription(`Ticket ${channel.name} geschlossen von <@${interaction.user.id}>\nGrund: ${reason}`)], files: [txtPath, htmlPath].filter(Boolean) });
        } catch (e) { console.error('failed to send transcript to log channel', e); }

        // DM owner with transcript
        try {
          const owner = await interaction.client.users.fetch(ownerId).catch(()=>null);
          if (owner) {
            await owner.send({ embeds: [new EmbedBuilder().setTitle('Dein Ticket wurde geschlossen').setDescription(`Grund: ${reason}`)], files: [txtPath] }).catch(()=>{});
          }
        } catch (e) {}

        // remove ticket: delete all channels in the parent category (if exists) and then delete the category
        try {
          const parent = channel.parent;
          // send final notice to the channel before deletion if possible
          try { await channel.send({ embeds: [new EmbedBuilder().setTitle('Ticket geschlossen').setDescription(`Dieses Ticket wurde geschlossen von <@${interaction.user.id}>\nGrund: ${reason}`)] }).catch(()=>{}); } catch(e) {}

          if (parent) {
            // delete each child channel (skip already deleting channel if needed)
            for (const ch of parent.children.values()) {
              try { await ch.delete().catch(()=>{}); } catch (e) {}
            }
            try { await parent.delete().catch(()=>{}); } catch (e) { console.error('failed to delete parent category', e); }
          } else {
            try { await channel.delete().catch(()=>{}); } catch (e) { console.error('failed to delete ticket channel', e); }
          }
        } catch (e) { console.error('failed to remove ticket', e); }

        try { await interaction.editReply({ content: 'Ticket geschlossen, Transkript erstellt und Kanal/Kategorie gelöscht.' }); } catch(e) {}
        return;
      } catch (e) {
        console.error('modal submit close failed', e);
        return interaction.editReply('Fehler beim Schließen des Tickets.');
      }
    }
  }
}; 
