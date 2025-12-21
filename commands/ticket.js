const { EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder } = require('discord.js');

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
      .setColor(0x8A2BE2);

    const menu = new StringSelectMenuBuilder()
      .setCustomId('ticket_create')
      .setPlaceholder('Wähle einen Ticket-Typ')
      .addOptions([
        { label: 'Support', value: 'support', description: 'Allgemeine Hilfe', emoji: '🛠️' },
        { label: 'Bug', value: 'bug', description: 'Fehler melden', emoji: '🐛' },
        { label: 'Bewerbung', value: 'apply', description: 'Bewerbung einreichen', emoji: '💼' }
      ]);

    const row = new ActionRowBuilder().addComponents(menu);

    await interaction.reply({ embeds: [embed], components: [row], ephemeral: false });
  }
};
