import { MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from "discord.js";
import type { Command } from "./types.ts";

export const timeoutDurationCommand: Command = {
  data: new SlashCommandBuilder()
    .setName("timeout_duration")
    .setDescription("Retrieve or set the timeout duration for detected scammers")
    .addIntegerOption(option => option.setName("duration").setDescription("The timeout duration in milliseconds").setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  execute: async (interaction, context) => {
    const config = context.configs.get(interaction.guildId!);
    if (!config) return;

    const duration = interaction.options.getInteger("duration");
    if (duration !== null) {
      config.timeoutDuration = duration;
      await interaction.reply({ content: `Timeout duration set to ${duration} milliseconds.`, flags: MessageFlags.Ephemeral });
      context.saveConfig(interaction.guildId!);
    } else {
      await interaction.reply({
        content: `Current timeout duration is ${config.timeoutDuration} milliseconds. Default is ${context.defaultTimeoutDuration} milliseconds.`,
        flags: MessageFlags.Ephemeral
      });
    }
  }
};
