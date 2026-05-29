// Outbound RPC handlers — what workflow phases call via `mode: plugin_call`
// to post replies after human review.
//
// Three methods:
//   - `discord/send_channel_message` -> post text to a guild text channel
//   - `discord/send_dm`              -> open + post DM to a user by id
//   - `discord/send_embed`           -> post an embed (with optional content)
//
// All return the discord.js message id so the workflow can correlate replies
// to subsequent events (e.g. follow-up edits or threading).

import type { Client, EmbedData, TextBasedChannel } from 'discord.js';
import { ChannelType, EmbedBuilder } from 'discord.js';

export interface SendChannelMessageParams {
  channel_id: string;
  content: string;
  reply_to_message_id?: string | null;
}

export interface SendDmParams {
  user_id: string;
  content: string;
}

export interface SendEmbedParams {
  channel_id: string;
  embed: EmbedData;
  content?: string | null;
  reply_to_message_id?: string | null;
}

export interface SendResult {
  message_id: string;
  channel_id: string;
}

function isWritableTextChannel(channel: unknown): channel is TextBasedChannel {
  if (!channel || typeof channel !== 'object') return false;
  const type = (channel as { type?: unknown }).type;
  return (
    type === ChannelType.GuildText ||
    type === ChannelType.GuildAnnouncement ||
    type === ChannelType.PublicThread ||
    type === ChannelType.PrivateThread ||
    type === ChannelType.AnnouncementThread ||
    type === ChannelType.DM
  );
}

export async function sendChannelMessage(
  client: Client,
  params: SendChannelMessageParams,
): Promise<SendResult> {
  if (!params.channel_id) throw new Error('channel_id required');
  if (typeof params.content !== 'string') throw new Error('content must be a string');

  const channel = await client.channels.fetch(params.channel_id);
  if (!isWritableTextChannel(channel)) {
    throw new Error(`channel ${params.channel_id} is not a writable text channel`);
  }
  const sent = await (channel as TextBasedChannel & {
    send: (payload: unknown) => Promise<{ id: string }>;
  }).send(
    params.reply_to_message_id
      ? { content: params.content, reply: { messageReference: params.reply_to_message_id } }
      : { content: params.content },
  );
  return { message_id: sent.id, channel_id: params.channel_id };
}

export async function sendDm(client: Client, params: SendDmParams): Promise<SendResult> {
  if (!params.user_id) throw new Error('user_id required');
  if (typeof params.content !== 'string') throw new Error('content must be a string');

  const user = await client.users.fetch(params.user_id);
  const dm = await user.createDM();
  const sent = await dm.send({ content: params.content });
  return { message_id: sent.id, channel_id: dm.id };
}

export async function sendEmbed(client: Client, params: SendEmbedParams): Promise<SendResult> {
  if (!params.channel_id) throw new Error('channel_id required');
  if (!params.embed || typeof params.embed !== 'object') throw new Error('embed required');

  const channel = await client.channels.fetch(params.channel_id);
  if (!isWritableTextChannel(channel)) {
    throw new Error(`channel ${params.channel_id} is not a writable text channel`);
  }
  // EmbedBuilder normalizes the partial embed JSON the caller sent into the
  // shape discord.js expects on the wire. Pass-through for color, title,
  // description, fields, footer, image, thumbnail, etc.
  const embed = new EmbedBuilder(params.embed);
  const payload: Record<string, unknown> = { embeds: [embed] };
  if (params.content) payload.content = params.content;
  if (params.reply_to_message_id) {
    payload.reply = { messageReference: params.reply_to_message_id };
  }
  const sent = await (channel as TextBasedChannel & {
    send: (payload: unknown) => Promise<{ id: string }>;
  }).send(payload);
  return { message_id: sent.id, channel_id: params.channel_id };
}
