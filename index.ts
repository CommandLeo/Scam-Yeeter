import "dotenv/config";
import fs from "node:fs";
import {
  Client,
  GatewayIntentBits,
  Partials,
  MessageFlags,
  ChannelType,
  TextChannel,
  EmbedBuilder,
  ModalBuilder,
  ChannelSelectMenuBuilder,
  LabelBuilder,
  userMention,
  channelMention,
  inlineCode,
  type ChatInputCommandInteraction,
  type Message
} from "discord.js";
import { registerCommands } from "./registerCommands.ts";
import type { UserId, GuildId, MessageReference, DetectionStrategy, GuildConfig } from "./types.ts";

const THREE_DAYS = 3 * 24 * 60 * 60 * 1000;
const TEN_MINUTES = 10 * 60 * 1000;

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;

if (!DISCORD_TOKEN) {
  console.error("Missing DISCORD_TOKEN in .env");
  process.exit(1);
}

if (!DISCORD_CLIENT_ID) {
  console.error("Missing DISCORD_CLIENT_ID in .env");
  process.exit(1);
}

process.on("unhandledRejection", error => {
  console.error("Unhandled promise rejection:", error);
});

process.on("uncaughtException", error => {
  console.error("Uncaught exception:", error);
});

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Message, Partials.Channel, Partials.GuildMember]
});

const messageReferences = new Map<GuildId, Map<UserId, MessageReference[]>>();
const recentlyModerated = new Set<UserId>();

// Load guild configurations

const defaultConfig: GuildConfig = {
  logChannelId: null,
  timeoutDuration: THREE_DAYS,
  detectionStrategy: "multiple_messages",
  scamMessageAmount: 3,
  detectionChannelIds: []
};
const configs = new Map<GuildId, GuildConfig>();
fs.mkdirSync("./configs", { recursive: true });
for (const file of fs.globSync("./configs/*.json")) {
  try {
    const data = fs.readFileSync(file, "utf-8");
    const { guildId, logChannelId, timeoutDuration, detectionStrategy, scamMessageAmount, detectionChannelIds } = { ...defaultConfig, ...JSON.parse(data) };
    if (!guildId || typeof guildId !== "string") {
      throw new Error("Invalid or missing guildId");
    }
    if (logChannelId !== null && typeof logChannelId !== "string") {
      throw new Error("Invalid logChannelId");
    }
    if (typeof timeoutDuration !== "number") {
      throw new Error("Invalid timeoutDuration");
    }
    if (detectionStrategy !== "multiple_messages" && detectionStrategy !== "detection_channels") {
      throw new Error("Invalid detectionStrategy");
    }
    if (typeof scamMessageAmount !== "number") {
      throw new Error("Invalid scamMessageAmount");
    }
    if (!Array.isArray(detectionChannelIds) || !detectionChannelIds.every(id => typeof id === "string")) {
      throw new Error("Invalid detectionChannelIds");
    }
    configs.set(guildId, { logChannelId, timeoutDuration, detectionStrategy, scamMessageAmount, detectionChannelIds });
  } catch (error: any) {
    console.error(`Failed to load config ${file}:`, error.message);
  }
}

function saveConfig(guildId: GuildId) {
  if (!guildId) return;
  const config = configs.get(guildId);
  if (!config) return;
  const data = {
    ...defaultConfig,
    ...config,
    guildId
  };
  fs.writeFileSync(`./configs/${guildId}.json`, JSON.stringify(data, null, 2));
}

// SCAM DETECTION AND HANDLING

async function deleteMessages(guildId: GuildId, authorId: UserId) {
  const guildMap = messageReferences.get(guildId);
  if (!guildMap) return 0;

  const cached = guildMap.get(authorId);
  if (!cached || cached.length === 0) return 0;

  const now = Date.now();
  const validRefs = cached.filter(ref => ref.timestamp > now - TEN_MINUTES);

  const deletionPromises = validRefs.map(async ref => {
    try {
      const channel = await client.channels.fetch(ref.channelId);
      if (!channel) throw new Error("Channel not found");
      if (!channel.isTextBased() || channel.isDMBased()) throw new Error("Invalid channel");

      await channel.messages.delete(ref.messageId);
    } catch (error: any) {
      console.log(`Failed to delete message ${ref.messageId} in channel ${ref.channelId}:`, error.message);
      throw error;
    }
  });

  const result = await Promise.allSettled(deletionPromises);
  guildMap.delete(authorId);

  return result.filter(r => r.status === "fulfilled").length;
}

async function logScamDetection(message: Message) {
  const config = configs.get(message.guild!.id);

  const logChannelId = config?.logChannelId;
  if (!logChannelId) {
    throw new Error(`No log channel configured for guild "${message.guild!.name}" (${message.guild!.id})`);
  }

  const logChannel = await message.guild!.channels.fetch(logChannelId).catch(() => null);
  if (!logChannel) {
    throw new Error(`Log channel ${logChannelId} not found in guild "${message.guild!.name}" (${message.guild!.id})`);
  }
  if (!logChannel.isTextBased() || logChannel.isDMBased()) {
    throw new Error(`Log channel ${logChannelId} is not a text channel in guild "${message.guild!.name}" (${message.guild!.id})`);
  }

  try {
    const forwardedMessage = await message.forward(logChannel);
    const embed = new EmbedBuilder()
      .setTitle("🚨 Image scam detected")
      .setColor("#c0392b")
      .addFields({
        name: "User Info",
        value: [userMention(message.author.id), `Username: ${inlineCode(message.author.username)}`, `User ID: ${inlineCode(message.author.id)}`].join("\n"),
        inline: true
      })
      .addFields({ name: "Detection Channel", value: channelMention(message.channel.id), inline: true })
      .setTimestamp();

    await forwardedMessage.reply({ embeds: [embed], allowedMentions: { repliedUser: false } });
  } catch (error: any) {
    throw new Error(`Unable to send messages in log channel ${logChannelId} in guild "${message.guild!.name}" (${message.guild!.id}):`, error.message);
  }
}

async function handleScam(message: Message, config: GuildConfig) {
  if (!recentlyModerated.has(message.author.id)) {
    recentlyModerated.add(message.author.id);
    // Clear from debounce set after 10 seconds
    setTimeout(() => recentlyModerated.delete(message.author.id), 10_000);

    if (message.member?.moderatable) {
      const timeoutDuration = config.timeoutDuration ?? THREE_DAYS;
      await message.member.timeout(timeoutDuration, "Image scam").catch(error => {
        console.error(`Failed to timeout user ${message.author.username} (${message.author.id}) in guild "${message.guild!.name}" (${message.guild!.id}):`, error.message);
      });
    }

    await logScamDetection(message).catch(error => {
      console.error("Error logging scam detection:", error.message);
    });

    if (message.deletable) {
      message.delete().catch(error => {
        console.error("Error deleting detected message:", error.message);
      });
    }
    const deletedMessagesAmount = await deleteMessages(message.guild!.id, message.author.id);
    if (deletedMessagesAmount > 0) {
      console.log(
        `Deleted ${deletedMessagesAmount} additional messages from user ${message.author.username} (${message.author.id}) in guild "${message.guild!.name}" (${message.guild!.id})`
      );
    }
  }
}

client.on("messageCreate", async message => {
  if (message.author.bot) return;
  if (!message.guild || !message.channel.isTextBased() || message.channel.isDMBased() || message.channel.isThread()) return;
  if (message.content?.trim()) return;
  if (message.attachments.size !== 4) return;
  if (!message.attachments.every(att => att.contentType?.startsWith("image/"))) return;

  const config = configs.get(message.guild.id);
  if (!config) return;

  const detectionStrategy = config.detectionStrategy;
  const scamMessageAmount = config.scamMessageAmount;
  const detectionChannels = config.detectionChannelIds;

  const userId = message.author.id;
  const guildId = message.guild.id;
  const channelId = message.channel.id;
  const messageId = message.id;

  let cond = false;
  if (detectionStrategy === "multiple_messages") {
    let guildMap = messageReferences.get(guildId);
    if (!guildMap) {
      guildMap = new Map();
      messageReferences.set(guildId, guildMap);
    }
    let refs = guildMap.get(userId);
    if (!refs) {
      refs = [];
      guildMap.set(userId, refs);
    }
    const now = Date.now();
    const recentMessages = refs.filter(ref => ref.timestamp > now - TEN_MINUTES);
    if (recentMessages.length >= scamMessageAmount - 1) {
      cond = true;
    }
  } else if (detectionStrategy === "detection_channels") {
    cond = detectionChannels.includes(channelId);
  }

  if (cond) {
    console.log(
      `[!] Scam detected from user ${message.author.username} (${userId}) in channel #${message.channel.name} (${channelId}) in guild "${message.guild.name}" (${guildId})`
    );
    handleScam(message, config);
  } else {
    if (!messageReferences.has(guildId)) {
      messageReferences.set(guildId, new Map());
    }
    const guildMap = messageReferences.get(guildId)!;
    if (!guildMap.has(userId)) {
      guildMap.set(userId, []);
    }
    const refs = guildMap.get(userId)!;
    refs.push({ channelId: channelId, messageId: messageId, timestamp: message.createdTimestamp });
    console.log(
      `Flagged suspicious message from user ${message.author.username} (${userId}) in channel #${message.channel.name} (${channelId}) in guild "${message.guild.name}" (${guildId})`
    );
  }
});

// SLASH COMMANDS

async function logChannelCommand(interaction: ChatInputCommandInteraction) {
  const config = configs.get(interaction.guildId!);
  if (!config) return;

  const channel = interaction.options.getChannel("channel");

  if (channel !== null) {
    if (!(channel instanceof TextChannel)) {
      await interaction.reply({ content: "Please select a valid text channel.", flags: MessageFlags.Ephemeral });
      return;
    }
    config.logChannelId = channel.id;
    await interaction.reply({ content: `Log channel set to ${channelMention(channel.id)}.`, flags: MessageFlags.Ephemeral });
    saveConfig(interaction.guildId!);
  } else {
    if (config.logChannelId) {
      await interaction.reply({ content: `Current log channel is ${channelMention(config.logChannelId)}.`, flags: MessageFlags.Ephemeral });
    } else {
      await interaction.reply({ content: "No log channel is currently set.", flags: MessageFlags.Ephemeral });
    }
  }
}

async function timeoutDurationCommand(interaction: ChatInputCommandInteraction) {
  const config = configs.get(interaction.guildId!);
  if (!config) return;

  const duration = interaction.options.getInteger("duration");
  if (duration !== null) {
    config.timeoutDuration = duration;
    await interaction.reply({ content: `Timeout duration set to ${duration} milliseconds.`, flags: MessageFlags.Ephemeral });
    saveConfig(interaction.guildId!);
  } else {
    await interaction.reply({
      content: `Current timeout duration is ${config.timeoutDuration} milliseconds. Default is ${THREE_DAYS} milliseconds.`,
      flags: MessageFlags.Ephemeral
    });
  }
}

async function detectionStrategyCommand(interaction: ChatInputCommandInteraction) {
  const config = configs.get(interaction.guildId!);
  if (!config) return;

  const strategy = interaction.options.getString("strategy");
  if (strategy !== null) {
    config.detectionStrategy = strategy as DetectionStrategy;
    await interaction.reply({ content: `Detection strategy set to ${strategy}.`, flags: MessageFlags.Ephemeral });
    saveConfig(interaction.guildId!);
  } else {
    await interaction.reply({ content: `Current detection strategy is ${inlineCode(config.detectionStrategy)}.`, flags: MessageFlags.Ephemeral });
  }
}

async function scamMessageAmountCommand(interaction: ChatInputCommandInteraction) {
  const config = configs.get(interaction.guildId!);
  if (!config) return;

  const amount = interaction.options.getInteger("amount");

  if (amount !== null) {
    config.scamMessageAmount = amount;
    await interaction.reply({ content: `Scam message amount set to ${amount}.`, flags: MessageFlags.Ephemeral });
    saveConfig(interaction.guildId!);
  } else {
    await interaction.reply({ content: `Current scam message amount is ${inlineCode(config.scamMessageAmount.toString())}.`, flags: MessageFlags.Ephemeral });
  }
}

async function detectionChannelsCommand(interaction: ChatInputCommandInteraction) {
  const config = configs.get(interaction.guildId!);

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
    saveConfig(interaction.guildId!);
  } else if (subcommand === "remove") {
    const channel = interaction.options.getChannel("channel", true);
    const index = config.detectionChannelIds.indexOf(channel.id);
    if (index === -1) {
      await interaction.reply({ content: `${channelMention(channel.id)} is not a detection channel.`, flags: MessageFlags.Ephemeral });
      return;
    }
    config.detectionChannelIds.splice(index, 1);
    await interaction.reply({ content: `Removed ${channelMention(channel.id)} from detection channels.`, flags: MessageFlags.Ephemeral });
    saveConfig(interaction.guildId!);
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

    const modal = new ModalBuilder().setCustomId("detection_channels_modal").setTitle("Edit Detection Channels").addLabelComponents(channelSelectLabel);

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

client.on("interactionCreate", async interaction => {
  if (interaction.isChatInputCommand()) {
    const guildId = interaction.guildId;
    if (!guildId) {
      await interaction.reply({ content: "This command can only be used in a guild.", flags: MessageFlags.Ephemeral });
      return;
    }

    if (!configs.has(guildId)) {
      configs.set(guildId, { ...defaultConfig });
      saveConfig(guildId);
    }

    if (interaction.commandName === "log_channel") {
      await logChannelCommand(interaction);
    } else if (interaction.commandName === "timeout_duration") {
      await timeoutDurationCommand(interaction);
    } else if (interaction.commandName === "detection_strategy") {
      await detectionStrategyCommand(interaction);
    } else if (interaction.commandName === "scam_message_amount") {
      await scamMessageAmountCommand(interaction);
    } else if (interaction.commandName === "detection_channels") {
      await detectionChannelsCommand(interaction);
    }
  } else if (interaction.isModalSubmit()) {
    if (interaction.customId === "detection_channels_modal") {
      const guildId = interaction.guildId;
      if (!guildId) {
        await interaction.reply({ content: "This modal can only be used in a guild.", flags: MessageFlags.Ephemeral });
        return;
      }

      const config = configs.get(guildId);
      if (!config) return;

      const selectedChannels = interaction.fields.getSelectedChannels("detection_channels_select");
      config.detectionChannelIds = selectedChannels?.map(channel => channel.id) ?? [];
      saveConfig(guildId);
      await interaction.reply({ content: "Detection channels updated.", flags: MessageFlags.Ephemeral });
    }
  }
});

// OTHER EVENTS

client.on("guildCreate", async guild => {
  console.log(`Joined new guild: ${guild.name} (${guild.id})`);

  if (!configs.has(guild.id)) {
    configs.set(guild.id, { ...defaultConfig });
    saveConfig(guild.id);
  }

  await registerCommands(guild.id);
});

client.on("clientReady", async () => {
  console.log(`Logged in as ${client.user?.tag}`);
});

client.login(DISCORD_TOKEN);
