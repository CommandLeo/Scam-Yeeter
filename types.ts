import type { Snowflake } from "discord.js";

export type UserId = Snowflake;
export type GuildId = Snowflake;
export type ChannelId = Snowflake;
export type MessageId = Snowflake;
export interface MessageReference {
  channelId: ChannelId;
  messageId: MessageId;
  timestamp: number;
}

export type DetectionStrategy = "multiple_messages" | "detection_channels" | "both";
export interface GuildConfig {
  guildId?: GuildId;
  logChannelId: ChannelId | null;
  timeoutDuration: number;
  detectionStrategy: DetectionStrategy;
  scamMessageAmount: number;
  detectionChannelIds: ChannelId[];
}
