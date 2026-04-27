import { channelMention, SlashCommandBuilder, ChannelType, MessageFlags, PermissionFlagsBits } from "discord.js";
import type { Command } from "./types.ts";

export const logChannelCommand: Command = {
  data: new SlashCommandBuilder()
    .setName("log_channel")
    .setDescription("Retrieve or set the log channel")
    .addChannelOption(option =>
      option
        .setName("channel")
        .setDescription("The channel to set as log channel")
        .addChannelTypes(ChannelType.GuildText)
        .addChannelTypes(ChannelType.GuildAnnouncement)
        .setRequired(false)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  execute: async (interaction, context) => {
    const config = context.configs.get(interaction.guildId!);
    if (!config) return;

    const channel = interaction.options.getChannel("channel");

    if (channel !== null) {
      if (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement) {
        await interaction.reply({ content: "Please select a valid text channel.", flags: MessageFlags.Ephemeral });
        return;
      }
      config.logChannelId = channel.id;
      await interaction.reply({ content: `Log channel set to ${channelMention(channel.id)}.`, flags: MessageFlags.Ephemeral });
      context.saveConfig(interaction.guildId!);
    } else {
      if (config.logChannelId) {
        await interaction.reply({ content: `Current log channel is ${channelMention(config.logChannelId)}.`, flags: MessageFlags.Ephemeral });
      } else {
        await interaction.reply({ content: "No log channel is currently set.", flags: MessageFlags.Ephemeral });
      }
    }
  }
};
