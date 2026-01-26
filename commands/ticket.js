const { EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder } = require('discord.js');
const { sendLog } = require('../utils/logger');

module.exports = {
  name: 'ticket',
  description: 'Sendet das Ticket-Menu',
  data: {
    name: 'ticket',
    description: 'Erstellt ein Ticket (Support, Bug, Bewerbung)'
  },
  async execute(interaction, config) {
    const embed = new EmbedBuilder()
      .setTitle('Support Tickets')
      .setDescription('Wähle den Ticket-Typ aus, um ein Ticket zu öffnen.')
      .setColor(0x87CEFA);

    const menu = new StringSelectMenuBuilder()
      .setCustomId('ticket_create')
      .setPlaceholder('Wähle einen Ticket-Typ')
      .addOptions([
        { label: 'Support', value: 'support', description: 'Allgemeine Hilfe', emoji: '🛠️' },
        { label: 'Bug', value: 'bug', description: 'Report bug', emoji: '🐛' },
        { label: 'Bewerbung', value: 'apply', description: 'Bewerbung einreichen', emoji: '💼' }
      ]);

    const row = new ActionRowBuilder().addComponents(menu);

    try {
      await interaction.reply({ embeds: [embed], components: [row], ephemeral: false });
    } catch (err) {
      console.warn('ticket command reply failed', err && err.code ? `${err.code} ${err.message}` : err);
    }

    // log to configured log channel if present
    try {
      if (interaction.guild) {
        await sendLog(interaction.guild, { embeds: [
          new EmbedBuilder()
            .setColor(0x87CEFA)
            .setTitle('Ticket-Menü gesendet')
            .setDescription(`Ticket-Menü gesendet von <@${interaction.user.id}> in ${interaction.channel ? (interaction.channel.name || interaction.channel.id) : 'DM'}`)
        ] });
      }
    } catch (e) { console.error('ticket menu log failed', e); }
  }
};
