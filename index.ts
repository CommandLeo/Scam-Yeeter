import "dotenv/config";
import fs from "node:fs";
import { TTLCache } from "@isaacs/ttlcache";
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

// Guild Config Management

const defaultTimeoutDuration = 3 * 24 * 60 * 60 * 1000; // 3 days

const defaultDetectionStrategy: DetectionStrategy = "multiple_messages";
const imageScamTimeWindowMs = 5 * 60 * 1000; // 5 minutes

const defaultInviteLinkChannelThreshold = 4;
const inviteLinkTimeWindowMs = 5 * 60 * 1000; // 5 minutes

const scamImagesMessageReferences = new TTLCache<string, MessageReference[]>({
  ttl: imageScamTimeWindowMs,
  checkAgeOnGet: true,
  max: 100_000
});
const inviteLinkMessageReferences = new TTLCache<string, MessageReference[]>({
  ttl: inviteLinkTimeWindowMs,
  checkAgeOnGet: true,
  max: 100_000
});
const recentlyModerated = new Set<UserId>();

function createDefaultConfig(guildId?: GuildId): GuildConfig {
  return {
    guildId,
    logChannelId: null,
    timeoutDuration: defaultTimeoutDuration,
    detectionStrategy: defaultDetectionStrategy,
    scamMessageAmount: 3,
    detectionChannelIds: [],
    inviteLinkChannelThreshold: defaultInviteLinkChannelThreshold
  };
}

const configs = new Map<GuildId, GuildConfig>();
fs.mkdirSync("./configs", { recursive: true });
for (const file of fs.globSync("./configs/*.json")) {
  try {
    const data = fs.readFileSync(file, "utf-8");
    const config: GuildConfig = { ...createDefaultConfig(), ...JSON.parse(data) };
    if (!config.guildId) {
      throw new Error("Missing guildId");
    }
    if (typeof config.guildId !== "string") {
      throw new Error("Invalid guildId");
    }
    if (config.logChannelId !== null && typeof config.logChannelId !== "string") {
      throw new Error("Invalid logChannelId");
    }
    if (typeof config.timeoutDuration !== "number") {
      throw new Error("Invalid timeoutDuration");
    }
    if (!["multiple_messages", "detection_channels", "both"].includes(config.detectionStrategy)) {
      throw new Error("Invalid detectionStrategy");
    }
    if (!Number.isInteger(config.scamMessageAmount) || config.scamMessageAmount < 1) {
      throw new Error("Invalid scamMessageAmount");
    }
    if (!Array.isArray(config.detectionChannelIds) || !config.detectionChannelIds.every(id => typeof id === "string")) {
      throw new Error("Invalid detectionChannelIds");
    }
    if (!Number.isInteger(config.inviteLinkChannelThreshold) || config.inviteLinkChannelThreshold < 2) {
      throw new Error("Invalid inviteLinkChannelThreshold");
    }
    configs.set(config.guildId, config);
  } catch (error: any) {
    console.error(`Failed to load config ${file}:`, error.message);
  }
}

function saveConfig(guildId: GuildId) {
  const config = configs.get(guildId);
  if (!config) return;
  fs.writeFileSync(`./configs/${guildId}.json`, JSON.stringify(config, null, 2));
}

function getRecentReferences(refs: MessageReference[], timeWindowMs: number, now = Date.now()) {
  return refs.filter(ref => ref.timestamp > now - timeWindowMs);
}

function getReferenceCacheKey(guildId: GuildId, userId: UserId) {
  return `${guildId}:${userId}`;
}

// SCAM DETECTION AND HANDLING

function isImageScamCandidate(message: Message) {
  return message.content.trim().length < 10 && message.attachments.size === 4 && message.attachments.every(att => att.contentType?.startsWith("image/"));
}

function containsInviteLink(message: Message) {
  return /(?:discord\.gg|discord(?:app)?\.com\/invite)\/(\S+)/i.test(message.content);
}

async function deleteMessages(guildId: GuildId, authorId: UserId) {
  const cacheKey = getReferenceCacheKey(guildId, authorId);
  const imageRefs = scamImagesMessageReferences.get(cacheKey) ?? [];
  const inviteRefs = inviteLinkMessageReferences.get(cacheKey) ?? [];

  const validRefs = [...getRecentReferences(imageRefs, imageScamTimeWindowMs), ...getRecentReferences(inviteRefs, inviteLinkTimeWindowMs)];

  if (validRefs.length === 0) {
    scamImagesMessageReferences.delete(cacheKey);
    inviteLinkMessageReferences.delete(cacheKey);
    return 0;
  }

  const seen = new Set<string>();
  const deduplicatedRefs = validRefs.filter(ref => {
    const key = `${ref.channelId}:${ref.messageId}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });

  const messageDeletionPromises = deduplicatedRefs.map(async ref => {
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

  const messageDeletionResults = await Promise.allSettled(messageDeletionPromises);
  scamImagesMessageReferences.delete(cacheKey);
  inviteLinkMessageReferences.delete(cacheKey);

  return messageDeletionResults.filter(result => result.status === "fulfilled").length;
}

async function logScam(message: Message, type: "image_scam" | "invite_link_scam") {
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
      .setTitle(`🚨 ${type === "image_scam" ? "Image" : "Invite link"} scam detected`)
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

async function handleScam(message: Message, type: "image_scam" | "invite_link_scam", config: GuildConfig) {
  if (!recentlyModerated.has(message.author.id)) {
    recentlyModerated.add(message.author.id);
    // Clear from debounce set after 10 seconds
    setTimeout(() => recentlyModerated.delete(message.author.id), 10_000);

    if (message.member?.moderatable) {
      const timeoutDuration = config.timeoutDuration;
      await message.member.timeout(timeoutDuration, "Image scam").catch(error => {
        console.error(`Failed to timeout user ${message.author.username} (${message.author.id}) in guild "${message.guild!.name}" (${message.guild!.id}):`, error.message);
      });
    }

    await logScam(message, type).catch(error => {
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
  if (!message.guild) return;
  if (!message.channel.isTextBased() || message.channel.isDMBased() || message.channel.isThread()) return;

  const config = configs.get(message.guild.id);
  if (!config) return;

  const userId = message.author.id;
  const guildId = message.guild.id;
  const channelId = message.channel.id;

  let imageScamDetected = false;
  let inviteScamDetected = false;

  if (isImageScamCandidate(message)) {
    const detectionStrategy = config.detectionStrategy;
    const scamMessageAmount = config.scamMessageAmount;
    const detectionChannels = config.detectionChannelIds;

    if (detectionStrategy === "detection_channels" || detectionStrategy === "both") {
      if (detectionChannels.includes(channelId)) {
        imageScamDetected = true;
      }
    }

    if ((detectionStrategy === "multiple_messages" || detectionStrategy === "both") && !imageScamDetected) {
      const cacheKey = getReferenceCacheKey(guildId, userId);
      const refs = scamImagesMessageReferences.get(cacheKey) ?? [];
      const recentRefs = getRecentReferences(refs, imageScamTimeWindowMs);
      if (recentRefs.length >= scamMessageAmount - 1) {
        imageScamDetected = true;
      } else {
        recentRefs.push({ channelId: channelId, messageId: message.id, timestamp: message.createdTimestamp });
      }
      scamImagesMessageReferences.set(cacheKey, recentRefs);
    }

    if (imageScamDetected) {
      console.log(
        `[!] Image scam detected from user ${message.author.username} (${userId}) in channel #${message.channel.name} (${channelId}) in guild "${message.guild.name}" (${guildId})`
      );
      handleScam(message, "image_scam", config);
      return;
    }
  }

  if (containsInviteLink(message)) {
    const cacheKey = getReferenceCacheKey(guildId, userId);
    const refs = inviteLinkMessageReferences.get(cacheKey) ?? [];
    const recentRefs = getRecentReferences(refs, inviteLinkTimeWindowMs);
    const uniqueChannels = new Set(recentRefs.map(ref => ref.channelId));
    uniqueChannels.add(channelId);

    if (uniqueChannels.size >= config.inviteLinkChannelThreshold) {
      inviteLinkMessageReferences.set(cacheKey, recentRefs);
      inviteScamDetected = true;
    } else {
      recentRefs.push({ channelId: channelId, messageId: message.id, timestamp: message.createdTimestamp });
      inviteLinkMessageReferences.set(cacheKey, recentRefs);

      inviteScamDetected = false;
    }

    if (inviteScamDetected) {
      console.log(
        `[!] Invite-link scam detected from user ${message.author.username} (${userId}) in channel #${message.channel.name} (${channelId}) in guild "${message.guild.name}" (${guildId})`
      );
      handleScam(message, "invite_link_scam", config);
      return;
    }
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
      content: `Current timeout duration is ${config.timeoutDuration} milliseconds. Default is ${defaultTimeoutDuration} milliseconds.`,
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

async function inviteLinkThresholdCommand(interaction: ChatInputCommandInteraction) {
  const config = configs.get(interaction.guildId!);
  if (!config) return;

  const threshold = interaction.options.getInteger("threshold");
  if (threshold !== null) {
    config.inviteLinkChannelThreshold = threshold;
    await interaction.reply({ content: `Invite-link channel threshold set to ${threshold}.`, flags: MessageFlags.Ephemeral });
    saveConfig(interaction.guildId!);
  } else {
    await interaction.reply({ content: `Current invite-link channel threshold is ${inlineCode(config.inviteLinkChannelThreshold.toString())}.`, flags: MessageFlags.Ephemeral });
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
      configs.set(guildId, createDefaultConfig(guildId));
      saveConfig(guildId);
    }

    switch (interaction.commandName) {
      case "log_channel":
        await logChannelCommand(interaction);
        break;
      case "timeout_duration":
        await timeoutDurationCommand(interaction);
        break;
      case "detection_strategy":
        await detectionStrategyCommand(interaction);
        break;
      case "scam_message_amount":
        await scamMessageAmountCommand(interaction);
        break;
      case "detection_channels":
        await detectionChannelsCommand(interaction);
        break;
      case "invite_link_threshold":
        await inviteLinkThresholdCommand(interaction);
        break;
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
    configs.set(guild.id, createDefaultConfig(guild.id));
    saveConfig(guild.id);
  }

  try {
    await registerCommands(guild.id);
    console.log(`Registered commands for guild "${guild.name}" (${guild.id})`);
  } catch (error: any) {
    console.error(`Failed to register commands for guild "${guild.name}" (${guild.id}):`, error.message);
  }
});

client.on("clientReady", () => {
  console.log(`Logged in as ${client.user?.tag}`);
});

client.login(DISCORD_TOKEN);
