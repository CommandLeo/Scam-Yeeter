# Scam Yeeter

A Discord bot designed to detect and automatically moderate image-based scam messages in your server.

## Features

- **Automatic Scam Detection**: Identifies suspicious messages containing exactly 4 images with no text content
- **Flexible Detection Strategies**: 
  - **Multiple Messages Mode**: Flags users who send multiple suspicious messages within a time window
  - **Detection Channels Mode**: Automatically flags suspicious messages in designated channels
- **Automated Moderation**: 
  - Times out detected scammers
  - Deletes scam messages automatically
- **Logging**: Forwards detected scam messages to a designated log channel with detailed user information
- **Highly Configurable**: Customize timeout duration, detection strategy, and more via slash commands

## Prerequisites

- Node.js (v23.6 or higher recommended) or Bun
- A Discord bot token

## Installation

1. Clone the repository:
```bash
git clone https://github.com/CommandLeo/Scam-Yeeter.git
cd Scam-Yeeter
```

2. Install dependencies:
```bash
npm install
```
or
```bash
bun install
```

3. Create a `.env` file in the root directory:
```env
DISCORD_TOKEN=your_bot_token_here
DISCORD_CLIENT_ID=your_client_id_here
```


4. Start the bot:
```bash
node index.ts
```
or
```bash
bun run index.ts
```

## Configuration

The bot stores per-guild configurations in the `configs/` directory. Each guild gets its own JSON configuration file.

### Default Settings

- **Timeout Duration**: 3 days
- **Detection Strategy**: `multiple_messages`
- **Scam Message Amount**: 3 messages
- **Detection Channels**: None
- **Log Channel**: Not set (must be configured if logging is desired)

## Slash Commands

### `/log_channel [<channel>]`
Set or view the channel where scam detections are logged.
- **channel** (optional): The text channel to use for logging
- If no channel is provided, displays the current log channel

### `/timeout_duration [<duration>]`
Set or view the timeout duration for detected scammers.
- **duration** (optional): Duration in milliseconds
- If no duration is provided, displays the current setting

### `/detection_strategy [<strategy>]`
Set or view the detection strategy.
- **strategy** (optional): Either `Multiple Messages` or `Detection Channels`
- If no strategy is provided, displays the current setting

**Strategies:**
- `multiple_messages`: Detects when a user sends multiple suspicious messages (configurable threshold)
- `detection_channels`: Any suspicious message in designated channels is flagged immediately

### `/scam_message_amount [<amount>]`
Set or view the number of suspicious messages required to trigger detection (only applies to `multiple_messages` strategy).
- **amount** (optional): Number of messages (e.g. 3)
- If no amount is provided, displays the current setting

### `/detection_channels <subcommand>`
Manage detection channels (only applies to `detection_channels` strategy).

**Subcommands:**
- `add <channel>`: Add a channel to the detection list
- `remove <channel>`: Remove a channel from the detection list
- `edit`: Opens a modal to select multiple channels at once
- `list`: Shows all current detection channels
