const { ApplicationCommandOptionType } = require('discord.js');

module.exports = {
  name: 'poll',
  description: 'Create a simple yes/no poll',
  data: {
    name: 'poll',
    description: 'Create a poll with Yes/No buttons',
    options: [
      {
        name: 'question',
        description: 'Poll question',
        type: ApplicationCommandOptionType.String,
        required: true,
      },
      {
        name: 'time',
        description: 'When is it? (e.g. 18:00)',
        type: ApplicationCommandOptionType.String,
        required: false,
      },
      {
        name: 'amount',
        description: 'How much money? (e.g. 5€)',
        type: ApplicationCommandOptionType.String,
        required: false,
      },
      {
        name: 'ping_everyone',
        description: 'Ping @everyone?',
        type: ApplicationCommandOptionType.Boolean,
        required: false,
      },
      {
        name: 'role_ping',
        description: 'Role to ping (optional)',
        type: ApplicationCommandOptionType.Role,
        required: false,
      },
    ],
  },
};
