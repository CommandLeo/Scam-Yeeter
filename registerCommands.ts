import { REST, Routes, SlashCommandBuilder, ChannelType, PermissionFlagsBits, type Guild } from "discord.js";

const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN!);

export const logChannelCommand = new SlashCommandBuilder()
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
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);

export const timeoutDurationCommand = new SlashCommandBuilder()
  .setName("timeout_duration")
  .setDescription("Retrieve or set the timeout duration for detected scammers")
  .addIntegerOption(option => option.setName("duration").setDescription("The timeout duration in milliseconds").setRequired(false))
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);

export const detectionStrategyCommand = new SlashCommandBuilder()
  .setName("detection_strategy")
  .setDescription("Retrieve or set the detection strategy")
  .addStringOption(option =>
    option
      .setName("strategy")
      .setDescription("The detection strategy to use")
      .addChoices({ name: "Multiple Messages", value: "multiple_messages" }, { name: "Detection Channels", value: "detection_channels" })
      .setRequired(false)
  )
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);

export const scamMessageAmountCommand = new SlashCommandBuilder()
  .setName("scam_message_amount")
  .setDescription("Retrieve or set the number of messages a user must send for a scam to be detected")
  .addIntegerOption(option => option.setName("amount").setDescription("The number of messages").setRequired(false))
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);

export const detectionChannelsCommand = new SlashCommandBuilder()
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
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);

export async function registerCommands(guildId: string) {
  await rest.put(Routes.applicationGuildCommands(process.env.DISCORD_CLIENT_ID!, guildId), {
    body: [logChannelCommand.toJSON(), timeoutDurationCommand.toJSON(), detectionStrategyCommand.toJSON(), scamMessageAmountCommand.toJSON(), detectionChannelsCommand.toJSON()]
  });
}

export async function registerCommandsInAllGuilds() {
  const guilds = (await rest.get(Routes.userGuilds())) as Guild[];

  for (const guild of guilds) {
    try {
      await registerCommands(guild.id);
      console.log(`Registered commands for guild "${guild.name}" (${guild.id})`);
    } catch (error) {
      console.error(`Failed to register commands for guild "${guild.name}" (${guild.id}):`, error instanceof Error ? error.message : error);
    }
  }
}

if (import.meta.main) {
  await import("dotenv/config");

  const guildId = process.argv[2];
  if (!guildId) {
    console.error("Please provide a guild ID as an argument.");
    process.exit(1);
  }

  if (guildId.toLowerCase() === "all") {
    await registerCommandsInAllGuilds();
  } else {
    await registerCommands(guildId);
    console.log(`Registered commands for guild "${guildId}"`);
  }
}
