import { SlashCommandBuilder, inlineCode, MessageFlags, PermissionFlagsBits,  } from "discord.js";
import type { DetectionStrategy } from "../types.ts";
import type { Command } from "./types.ts";

export const detectionStrategyCommand: Command = {
  data: new SlashCommandBuilder()
    .setName("detection_strategy")
    .setDescription("Retrieve or set the detection strategy")
    .addStringOption(option =>
      option
        .setName("strategy")
        .setDescription("The detection strategy to use")
        .addChoices(
          { name: "Multiple Messages", value: "multiple_messages" },
          { name: "Detection Channels", value: "detection_channels" },
          { name: "Both", value: "both" }
        )
        .setRequired(false)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  execute: async (interaction, context) => {
    const config = context.configs.get(interaction.guildId!);
    if (!config) return;

    const strategy = interaction.options.getString("strategy") as DetectionStrategy | null;
    if (strategy !== null) {
      config.detectionStrategy = strategy;
      await interaction.reply({ content: `Detection strategy set to ${strategy}.`, flags: MessageFlags.Ephemeral });
      context.saveConfig(interaction.guildId!);
    } else {
      await interaction.reply({ content: `Current detection strategy is ${inlineCode(config.detectionStrategy)}.`, flags: MessageFlags.Ephemeral });
    }
  }
};
