const { ApplicationCommandOptionType, PermissionsBitField } = require('discord.js');

const sa = require('./sa.js');

module.exports = {
  name: 'sb',
  description: 'Posts a beta session announcement with Hammertime times',
  data: {
    name: 'sb',
    description: 'Posts a beta session announcement with Hammertime times',
    options: [
      {
        name: 'reg',
        description: 'Registration time (HH:MM)',
        type: ApplicationCommandOptionType.String,
        required: true,
      },
      {
        name: 'game',
        description: 'Game time (HH:MM)',
        type: ApplicationCommandOptionType.String,
        required: true,
      },
      {
        name: 'staff',
        description: 'Optional staff mention text (e.g. @role or @user)',
        type: ApplicationCommandOptionType.String,
        required: false,
      },
      {
        name: 'everyone',
        description: 'Include @everyone ping (requires permission)',
        type: ApplicationCommandOptionType.Boolean,
        required: false,
      },
    ],
  },

  async execute(interaction) {
    // Always use beta mode for /sb
    interaction.options.getString = ((orig => (name, required) => {
      if (name === 'mode') return 'beta';
      return orig.call(interaction.options, name, required);
    })(interaction.options.getString)).bind(interaction.options);
    return sa.execute(interaction);
  },
};
