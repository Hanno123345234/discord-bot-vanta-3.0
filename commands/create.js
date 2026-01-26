const { ApplicationCommandOptionType } = require('discord.js');

module.exports = {
  name: 'create',
  description: 'Open a modal to paste a session announcement',
  data: {
    name: 'create',
    description: 'Paste a full session announcement via modal',
    options: []
  }
};
