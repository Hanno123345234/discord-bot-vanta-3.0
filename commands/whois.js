const { ApplicationCommandOptionType } = require('discord.js');

module.exports = {
  name: 'whois',
  description: 'Show detailed user info',
  data: {
    name: 'whois',
    description: 'Show detailed user info',
    options: [
      {
        name: 'user',
        description: 'User mention or numeric user ID',
        type: ApplicationCommandOptionType.String,
        required: true,
      }
    ]
  }
};
