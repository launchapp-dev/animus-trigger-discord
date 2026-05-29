// Discord message -> Animus TriggerEvent translation.
//
// Surfaces two event kinds:
//   - `discord.mention` — bot @mentioned in a guild text channel
//   - `discord.dm`      — direct message to the bot
//
// Other Discord events (typing, reactions, voice state, member joins) are
// ignored in v0.1.0. The original message snapshot is preserved on
// `payload` so workflow YAML can template against `{{trigger.payload.content}}`,
// `{{trigger.payload.author.id}}`, etc.

import type { Message } from 'discord.js';
import { ChannelType } from 'discord.js';

export const KIND_DISCORD_MENTION = 'discord.mention';
export const KIND_DISCORD_DM = 'discord.dm';
export const ACTION_HINT_CREATE_TASK = 'create_task';

// Matches the Rust `animus_plugin_protocol::TriggerEvent` wire shape (see
// crates/animus-plugin-protocol/src/lib.rs). The host deserializes
// `trigger/event` notification `params` directly into this struct, so field
// names + omission rules matter:
//   - `event_id` is required
//   - `trigger_id` is optional (omitted when unset)
//   - `kind` lives inside `payload` (Rust struct has no top-level kind)
//   - `subject_id`, `action_hint` are optional
//   - `payload` is opaque JSON forwarded to the spawned workflow
export interface DiscordTriggerEvent {
  event_id: string;
  trigger_id?: string;
  payload: Record<string, unknown>;
  subject_id?: string;
  action_hint?: string;
}

export interface ChannelAllowlist {
  guilds?: Set<string>;
  channels?: Set<string>;
}

export function channelAllowed(message: Message, allow: ChannelAllowlist): boolean {
  if (allow.guilds && allow.guilds.size > 0) {
    if (!message.guildId || !allow.guilds.has(message.guildId)) {
      return false;
    }
  }
  if (allow.channels && allow.channels.size > 0) {
    if (!allow.channels.has(message.channelId)) {
      return false;
    }
  }
  return true;
}

/**
 * Convert a discord.js Message into a TriggerEvent.
 *
 * Returns `null` if the message should be ignored (bot's own message, system
 * notice, non-text DM/channel, no mention + not a DM).
 *
 * `botUserId` is the snowflake of the running bot — used to detect mentions
 * (Discord's `mentions.users` collection contains every @mentioned user,
 * including @everyone via `mentions.everyone`).
 *
 * `triggerId`, when provided, populates `TriggerEvent.trigger_id` so the host
 * can route the event back to the workflow YAML `[[triggers]]` block that
 * spawned this `trigger/watch` call.
 */
export function mapDiscordMessage(
  message: Message,
  botUserId: string,
  triggerId?: string,
): DiscordTriggerEvent | null {
  // Ignore bot's own messages + system notices (welcome, pin updates, ...).
  if (message.author.bot) return null;
  if (message.system) return null;

  const channelType = message.channel.type;
  const isDm = channelType === ChannelType.DM;
  const isGuildText =
    channelType === ChannelType.GuildText ||
    channelType === ChannelType.GuildAnnouncement ||
    channelType === ChannelType.PublicThread ||
    channelType === ChannelType.PrivateThread ||
    channelType === ChannelType.AnnouncementThread;

  let kind: string;
  if (isDm) {
    kind = KIND_DISCORD_DM;
  } else if (isGuildText) {
    const mentionsBot = message.mentions.users.has(botUserId);
    if (!mentionsBot) return null;
    kind = KIND_DISCORD_MENTION;
  } else {
    return null;
  }

  return buildEvent(kind, message, triggerId);
}

function buildEvent(
  kind: string,
  message: Message,
  triggerId: string | undefined,
): DiscordTriggerEvent {
  const event: DiscordTriggerEvent = {
    event_id: buildEventId(message),
    // `kind` lives inside payload per the Rust TriggerEvent wire shape; we
    // also include `occurred_at` here so workflow templates can read
    // `{{trigger.payload.occurred_at}}` directly.
    payload: {
      kind,
      occurred_at: (message.createdAt ?? new Date()).toISOString(),
      message: serializeMessage(message),
    },
    action_hint: ACTION_HINT_CREATE_TASK,
  };
  if (triggerId) event.trigger_id = triggerId;
  return event;
}

/**
 * Stable event id: `discord:<guildOrDm>/<channel>/<message>`. Guild messages
 * use the guild snowflake; DMs use the literal `dm` so the channel id stays
 * the disambiguator. This keeps the daemon's dedup table stable across
 * Gateway reconnects.
 */
function buildEventId(message: Message): string {
  const scope = message.guildId ?? 'dm';
  return `discord:${scope}/${message.channelId}/${message.id}`;
}

/**
 * Project the discord.js Message into a plain JSON-safe object suitable for
 * the wire. We intentionally do NOT pass the full discord.js instance — its
 * cyclic Client references would blow up JSON.stringify, and the workflow
 * doesn't need them.
 */
function serializeMessage(message: Message): Record<string, unknown> {
  return {
    id: message.id,
    content: message.content,
    channel_id: message.channelId,
    guild_id: message.guildId,
    author: {
      id: message.author.id,
      username: message.author.username,
      global_name: message.author.globalName,
      bot: message.author.bot,
    },
    mentions: {
      users: message.mentions.users.map((u) => ({ id: u.id, username: u.username })),
      roles: message.mentions.roles.map((r) => ({ id: r.id, name: r.name })),
      everyone: message.mentions.everyone,
    },
    attachments: message.attachments.map((a) => ({
      id: a.id,
      url: a.url,
      name: a.name,
      size: a.size,
      content_type: a.contentType,
    })),
    created_at: (message.createdAt ?? new Date()).toISOString(),
    edited_at: message.editedAt?.toISOString() ?? null,
  };
}
