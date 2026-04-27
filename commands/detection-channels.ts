import {
  SlashCommandBuilder,
  channelMention,
  ChannelType,
  ChannelSelectMenuBuilder,
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits
} from "discord.js";
import type { ModalExecutor, Command } from "./types.ts";

export const detectionChannelsCommand: Command = {
  data: new SlashCommandBuilder()
    .setName("detection_channels")
    .setDescription("Set detection channels")
    .addSubcommand(subcommand =>
      subcommand
        .setName("add")
        .setDescription("Add a detection channel")
        .addChannelOption(option =>
          option
            .setName("channel")
            .setDescription("The channel to add to detection channels")
            .addChannelTypes(ChannelType.GuildText)
            .addChannelTypes(ChannelType.GuildAnnouncement)
            .setRequired(true)
        )
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName("remove")
        .setDescription("Remove a detection channel")
        .addChannelOption(option =>
          option
            .setName("channel")
            .setDescription("The channel to remove from detection channels")
            .addChannelTypes(ChannelType.GuildText)
            .addChannelTypes(ChannelType.GuildAnnouncement)
            .setRequired(true)
        )
    )
    .addSubcommand(subcommand => subcommand.setName("edit").setDescription("Edit detection channels inside a modal"))
    .addSubcommand(subcommand => subcommand.setName("list").setDescription("List all detection channels"))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  execute: async (interaction, context) => {
    const config = context.configs.get(interaction.guildId!);
    if (!config) return;

    const subcommand = interaction.options.getSubcommand();

    if (subcommand === "add") {
      const channel = interaction.options.getChannel("channel", true);
      if (config.detectionChannelIds.includes(channel.id)) {
        await interaction.reply({ content: `${channelMention(channel.id)} is already a detection channel.`, flags: MessageFlags.Ephemeral });
        return;
      }
      config.detectionChannelIds.push(channel.id);
      await interaction.reply({ content: `Added ${channelMention(channel.id)} as a detection channel.`, flags: MessageFlags.Ephemeral });
      context.saveConfig(interaction.guildId!);
    } else if (subcommand === "remove") {
      const channel = interaction.options.getChannel("channel", true);
      const index = config.detectionChannelIds.indexOf(channel.id);
      if (index === -1) {
        await interaction.reply({ content: `${channelMention(channel.id)} is not a detection channel.`, flags: MessageFlags.Ephemeral });
        return;
      }
      config.detectionChannelIds.splice(index, 1);
      await interaction.reply({ content: `Removed ${channelMention(channel.id)} from detection channels.`, flags: MessageFlags.Ephemeral });
      context.saveConfig(interaction.guildId!);
    } else if (subcommand === "edit") {
      const channelSelect = new ChannelSelectMenuBuilder()
        .setCustomId("detection_channels_select")
        .setPlaceholder("Select detection channels")
        .setDefaultChannels(config.detectionChannelIds)
        .addChannelTypes(ChannelType.GuildText)
        .addChannelTypes(ChannelType.GuildAnnouncement)
        .setMinValues(0)
        .setMaxValues(25)
        .setRequired(false);
      const channelSelectLabel = new LabelBuilder().setLabel("Detection Channels").setChannelSelectMenuComponent(channelSelect);

      const modal = new ModalBuilder()
        .setCustomId("detection_channels_modal")
        .setTitle("Edit Detection Channels")
        .addLabelComponents(channelSelectLabel);

      await interaction.showModal(modal);
    } else if (subcommand === "list") {
      if (config.detectionChannelIds.length === 0) {
        await interaction.reply({ content: "No detection channels are currently set.", flags: MessageFlags.Ephemeral });
        return;
      }
      const channelMentions = config.detectionChannelIds.map(id => channelMention(id)).join(", ");
      await interaction.reply({ content: `Current detection channels: ${channelMentions}`, flags: MessageFlags.Ephemeral });
    }
  }
};

export const handleDetectionChannelsModal: ModalExecutor = async (interaction, context) => {
  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.reply({ content: "This modal can only be used in a guild.", flags: MessageFlags.Ephemeral });
    return;
  }

  const config = context.configs.get(guildId);
  if (!config) return;

  const selectedChannels = interaction.fields.getSelectedChannels("detection_channels_select");
  config.detectionChannelIds = selectedChannels?.map(channel => channel.id) ?? [];
  context.saveConfig(guildId);
  await interaction.reply({ content: "Detection channels updated.", flags: MessageFlags.Ephemeral });
};
