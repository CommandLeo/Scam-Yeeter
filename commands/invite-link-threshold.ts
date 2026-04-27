import { SlashCommandBuilder, inlineCode, MessageFlags, PermissionFlagsBits } from "discord.js";
import type { Command } from "./types.ts";

export const inviteLinkThresholdCommand: Command = {
  data: new SlashCommandBuilder()
    .setName("invite_link_threshold")
    .setDescription("Retrieve or set the number of unique channels for invite-link detection")
    .addIntegerOption(option => option.setName("threshold").setDescription("Unique channel threshold").setRequired(false).setMinValue(2))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  execute: async (interaction, context) => {
    const config = context.configs.get(interaction.guildId!);
    if (!config) return;

    const threshold = interaction.options.getInteger("threshold");
    if (threshold !== null) {
      config.inviteLinkChannelThreshold = threshold;
      await interaction.reply({ content: `Invite-link channel threshold set to ${threshold}.`, flags: MessageFlags.Ephemeral });
      context.saveConfig(interaction.guildId!);
    } else {
      await interaction.reply({
        content: `Current invite-link channel threshold is ${inlineCode(config.inviteLinkChannelThreshold.toString())}.`,
        flags: MessageFlags.Ephemeral
      });
    }
  }
};
