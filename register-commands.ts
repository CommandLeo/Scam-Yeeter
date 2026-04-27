import { REST, Routes, type Guild } from "discord.js";
import { commands } from "./commands/index.ts";

const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN!);

export async function registerCommands(guildId: string) {
  await rest.put(Routes.applicationGuildCommands(process.env.DISCORD_CLIENT_ID!, guildId), {
    body: commands.map(command => command.data.toJSON())
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
