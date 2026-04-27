import type {
  ChatInputCommandInteraction,
  ModalSubmitInteraction,
  SlashCommandBuilder,
  SlashCommandOptionsOnlyBuilder,
  SlashCommandSubcommandsOnlyBuilder
} from "discord.js";
import type { GuildConfig, GuildId } from "../types.ts";

export interface CommandContext {
  configs: Map<GuildId, GuildConfig>;
  saveConfig: (guildId: GuildId) => void;
  createDefaultConfig: (guildId?: GuildId) => GuildConfig;
  defaultTimeoutDuration: number;
}

export interface Command {
  data: SlashCommandBuilder | SlashCommandOptionsOnlyBuilder | SlashCommandSubcommandsOnlyBuilder;
  execute: (interaction: ChatInputCommandInteraction, context: CommandContext) => Promise<void>;
}

export type ModalExecutor = (interaction: ModalSubmitInteraction, context: CommandContext) => Promise<void>;
