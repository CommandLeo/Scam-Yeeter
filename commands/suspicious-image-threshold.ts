import { inlineCode, SlashCommandBuilder, MessageFlags, PermissionFlagsBits } from "discord.js";
import type { Command } from "./types.ts";

export const suspiciousImageThresholdCommand: Command = {
  data: new SlashCommandBuilder()
    .setName("suspicious_image_threshold")
    .setDescription("Retrieve or set the number of suspicious image messages for image-scam detection")
    .addIntegerOption(option => option.setName("threshold").setDescription("The number of images").setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  execute: async (interaction, context) => {
    const config = context.configs.get(interaction.guildId!);
    if (!config) return;

    const threshold = interaction.options.getInteger("threshold");

    if (threshold !== null) {
      config.suspiciousImageTreshold = threshold;
      await interaction.reply({ content: `Suspicious image threshold set to ${threshold}.`, flags: MessageFlags.Ephemeral });
      context.saveConfig(interaction.guildId!);
    } else {
      await interaction.reply({
        content: `Current suspicious image threshold is ${inlineCode(config.suspiciousImageTreshold.toString())}.`,
        flags: MessageFlags.Ephemeral
      });
    }
  }
};
