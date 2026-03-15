const { ApplicationCommandOptionType } = require('discord.js');

module.exports = {
  name: 'setup',
  description: 'Send all standard lobby setup messages into existing lobby channels',
  data: {
    name: 'setup',
    description: 'Send setup messages to lobby channels',
    options: [
      {
        name: 'session',
        description: 'Session number (e.g. 5)',
        type: ApplicationCommandOptionType.Integer,
        required: true,
      },
      {
        name: 'lobby',
        description: 'Lobby number (e.g. 1)',
        type: ApplicationCommandOptionType.Integer,
        required: true,
      },
      {
        name: 'registration_opens',
        description: 'Registration opens at HH:MM (e.g. 00:17)',
        type: ApplicationCommandOptionType.String,
        required: true,
      },
      {
        name: 'category',
        description: 'Category name or category ID/mention (optional)',
        type: ApplicationCommandOptionType.String,
        required: false,
      },
    ],
  },
};
