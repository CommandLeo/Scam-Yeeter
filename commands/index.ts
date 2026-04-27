import { detectionChannelsCommand } from "./detection-channels.ts";
import { detectionStrategyCommand } from "./detection-strategy.ts";
import { inviteLinkThresholdCommand } from "./invite-link-threshold.ts";
import { logChannelCommand } from "./log-channel.ts";
import { suspiciousImageThresholdCommand } from "./suspicious-image-threshold.ts";
import { timeoutDurationCommand } from "./timeout-duration.ts";

export const commands = [
  logChannelCommand,
  timeoutDurationCommand,
  detectionStrategyCommand,
  suspiciousImageThresholdCommand,
  detectionChannelsCommand,
  inviteLinkThresholdCommand
];
