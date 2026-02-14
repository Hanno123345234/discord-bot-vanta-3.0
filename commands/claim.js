const { ApplicationCommandOptionType } = require('discord.js');

module.exports = {
  name: 'claim',
  description: 'Schedule a duo session claim panel',
  data: {
    name: 'claim',
    description: 'Schedule a duo session claim panel',
    options: [
      {
        name: 'time',
        description: 'Start time in HH:MM (24h)',
        type: ApplicationCommandOptionType.String,
        required: true,
      },
      {
        name: 'gamemode',
        description: 'Gamemode label (e.g. Duos)',
        type: ApplicationCommandOptionType.String,
        required: true,
      },
      {
        name: 'session',
        description: 'Session number',
        type: ApplicationCommandOptionType.Integer,
        required: true,
        min_value: 1,
      },
      {
        name: 'reload',
        description: 'Is this a reload session?',
        type: ApplicationCommandOptionType.Boolean,
        required: false,
      }
    ]
  }
};
