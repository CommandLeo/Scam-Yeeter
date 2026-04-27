import fs from "node:fs";
import { z } from "zod";
import { TTLCache } from "@isaacs/ttlcache";
import { Client, GatewayIntentBits, Partials, MessageFlags, EmbedBuilder, userMention, channelMention, inlineCode, type Message } from "discord.js";
import { commands } from "./commands/index.ts";
import { handleDetectionChannelsModal } from "./commands/detection-channels.ts";
import { registerCommands } from "./register-commands.ts";
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

const guildConfigSchema = z.object({
  guildId: z.string().optional(),
  logChannelId: z.string().nullable().default(null),
  timeoutDuration: z.number().default(defaultTimeoutDuration),
  detectionStrategy: z.enum(["multiple_messages", "detection_channels", "both"]).default(defaultDetectionStrategy),
  suspiciousImageTreshold: z.number().int().min(1).default(3),
  detectionChannelIds: z.array(z.string()).default([]),
  inviteLinkChannelThreshold: z.number().int().min(2).default(defaultInviteLinkChannelThreshold)
});

const persistedGuildConfigSchema = guildConfigSchema.extend({ guildId: z.string().min(1) });

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
  return guildConfigSchema.parse({ guildId });
}

const configs = new Map<GuildId, GuildConfig>();
fs.mkdirSync("./configs", { recursive: true });
for (const file of fs.globSync("./configs/*.json")) {
  try {
    const data = fs.readFileSync(file, "utf-8");
    const rawConfig = JSON.parse(data);
    const parsedConfig = persistedGuildConfigSchema.safeParse(rawConfig);
    if (!parsedConfig.success) {
      throw new Error(parsedConfig.error.issues.map(issue => `${issue.path.join(".") || "root"}: ${issue.message}`).join("; "));
    }
    const config = parsedConfig.data;
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
  return (
    message.content.trim().length < 10 && message.attachments.size === 4 && message.attachments.every(att => att.contentType?.startsWith("image/"))
  );
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
        value: [userMention(message.author.id), `Username: ${inlineCode(message.author.username)}`, `User ID: ${inlineCode(message.author.id)}`].join(
          "\n"
        ),
        inline: true
      })
      .addFields({ name: "Detection Channel", value: channelMention(message.channel.id), inline: true })
      .setTimestamp();

    await forwardedMessage.reply({ embeds: [embed], allowedMentions: { repliedUser: false } });
  } catch (error: any) {
    throw new Error(
      `Unable to send messages in log channel ${logChannelId} in guild "${message.guild!.name}" (${message.guild!.id}):`,
      error.message
    );
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
        console.error(
          `Failed to timeout user ${message.author.username} (${message.author.id}) in guild "${message.guild!.name}" (${message.guild!.id}):`,
          error.message
        );
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

  let inviteLinkScamDetected = false;
  let imageScamDetected = false;

  if (containsInviteLink(message)) {
    const cacheKey = getReferenceCacheKey(guildId, userId);
    const refs = inviteLinkMessageReferences.get(cacheKey) ?? [];
    const recentRefs = getRecentReferences(refs, inviteLinkTimeWindowMs);
    const uniqueChannels = new Set(recentRefs.map(ref => ref.channelId));
    uniqueChannels.add(channelId);

    if (uniqueChannels.size >= config.inviteLinkChannelThreshold) {
      inviteLinkMessageReferences.set(cacheKey, recentRefs);
      inviteLinkScamDetected = true;
    } else {
      recentRefs.push({ channelId: channelId, messageId: message.id, timestamp: message.createdTimestamp });
      inviteLinkMessageReferences.set(cacheKey, recentRefs);

      inviteLinkScamDetected = false;
    }

    if (inviteLinkScamDetected) {
      console.log(
        `[!] Invite-link scam detected from user ${message.author.username} (${userId}) in channel #${message.channel.name} (${channelId}) in guild "${message.guild.name}" (${guildId})`
      );
      handleScam(message, "invite_link_scam", config);
      return;
    }
  }

  if (isImageScamCandidate(message)) {
    if (config.detectionStrategy === "detection_channels" || config.detectionStrategy === "both") {
      if (config.detectionChannelIds.includes(channelId)) {
        imageScamDetected = true;
      }
    }

    if (!imageScamDetected && (config.detectionStrategy === "multiple_messages" || config.detectionStrategy === "both")) {
      const cacheKey = getReferenceCacheKey(guildId, userId);
      const refs = scamImagesMessageReferences.get(cacheKey) ?? [];
      const recentRefs = getRecentReferences(refs, imageScamTimeWindowMs);
      if (recentRefs.length >= config.suspiciousImageTreshold - 1) {
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
    } else {
      console.log(
        `Flagged suspicious image message from user ${message.author.username} (${userId}) in channel #${message.channel.name} (${channelId}) in guild "${message.guild.name}" (${guildId})`
      );
    }
  }
});

// SLASH COMMANDS

const commandContext = {
  configs,
  saveConfig,
  createDefaultConfig,
  defaultTimeoutDuration
};

const commandsByName = new Map(commands.map(command => [command.data.toJSON().name, command]));

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

    const command = commandsByName.get(interaction.commandName);
    if (!command) {
      return;
    }

    await command.execute(interaction, commandContext);
  } else if (interaction.isModalSubmit()) {
    if (interaction.customId === "detection_channels_modal") {
      await handleDetectionChannelsModal(interaction, commandContext);
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
