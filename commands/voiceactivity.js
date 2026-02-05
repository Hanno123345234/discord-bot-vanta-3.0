const { ApplicationCommandOptionType } = require('discord.js');
let voiceActivity = null;
try { voiceActivity = require('../utils/voice_activity'); } catch (e) { voiceActivity = null; }

module.exports = {
  name: 'voiceactivity',
  description: 'Show voice activity leaderboards',
  data: {
    name: 'voiceactivity',
    description: 'Show voice activity (top members/channels)',
    options: [
      {
        name: 'range',
        description: 'Time range',
        type: ApplicationCommandOptionType.String,
        required: false,
        choices: [
          { name: '1 day', value: '1d' },
          { name: '7 days', value: '7d' },
          { name: '30 days', value: '30d' },
        ],
      },
    ],
  },

  async execute(interaction) {
    try {
      if (!voiceActivity) {
        return interaction.reply({ content: 'Voice activity module is not available on this deployment.', ephemeral: true });
      }
      const range = interaction.options.getString('range') || '7d';
      const embed = await voiceActivity.buildVoiceActivityEmbed(interaction.guild, { range, viewerId: interaction.user.id });
      const components = voiceActivity.buildVoiceActivityComponents(range);
      return interaction.reply({ embeds: [embed], components });
    } catch (e) {
      console.error('voiceactivity command failed', e);
      try {
        if (interaction.deferred || interaction.replied) return interaction.editReply({ content: 'Failed to build voice activity.' });
        return interaction.reply({ content: 'Failed to build voice activity.', ephemeral: true });
      } catch (e2) {}
    }
  },
};
