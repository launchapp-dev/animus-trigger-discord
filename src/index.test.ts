// Unit tests for the Discord trigger plugin.
//
// We mock discord.js so tests don't open real Gateway connections. The
// inbound translation tests cover mapping logic; the outbound tests
// verify the channel/DM/embed RPC adapters.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ChannelType } from 'discord.js';

import {
  channelAllowed,
  mapDiscordMessage,
  KIND_DISCORD_DM,
  KIND_DISCORD_MENTION,
  ACTION_HINT_CREATE_TASK,
  type ChannelAllowlist,
} from './inbound.js';
import { sendChannelMessage, sendDm, sendEmbed } from './outbound.js';
import { MANIFEST, METHODS } from './index.js';

// ---- helpers ---------------------------------------------------------------

const BOT_ID = 'BOT_USER_ID';

function mockMessage(opts: {
  channelType: number;
  authorBot?: boolean;
  mentions?: string[];
  guildId?: string | null;
  channelId?: string;
  messageId?: string;
  content?: string;
  system?: boolean;
}): any {
  const mentionsList = opts.mentions ?? [];
  return {
    id: opts.messageId ?? 'MSG_1',
    channelId: opts.channelId ?? 'CHAN_1',
    guildId: opts.guildId ?? (opts.channelType === ChannelType.DM ? null : 'GUILD_1'),
    content: opts.content ?? 'hello',
    system: opts.system ?? false,
    author: {
      id: 'USER_1',
      username: 'user',
      globalName: 'User',
      bot: opts.authorBot ?? false,
    },
    channel: { type: opts.channelType },
    mentions: {
      users: {
        has: (uid: string) => mentionsList.includes(uid),
        map: (fn: any) => mentionsList.map((id) => fn({ id, username: 'u' })),
      },
      roles: { map: (_fn: any) => [] },
      everyone: false,
    },
    attachments: { map: (_fn: any) => [] },
    createdAt: new Date('2026-05-27T12:00:00Z'),
    editedAt: null,
  };
}

// ---- inbound ---------------------------------------------------------------

describe('mapDiscordMessage', () => {
  it('emits discord.mention when bot is @mentioned in a guild channel', () => {
    const msg = mockMessage({
      channelType: ChannelType.GuildText,
      mentions: [BOT_ID],
    });
    const ev = mapDiscordMessage(msg, BOT_ID, 'discord-inbox');
    expect(ev).not.toBeNull();
    expect((ev!.payload as any).kind).toBe(KIND_DISCORD_MENTION);
    expect(ev!.event_id).toBe('discord:GUILD_1/CHAN_1/MSG_1');
    expect(ev!.trigger_id).toBe('discord-inbox');
    expect(ev!.action_hint).toBe(ACTION_HINT_CREATE_TASK);
    expect((ev!.payload as any).message.content).toBe('hello');
  });

  it('emits discord.dm for messages in a DM channel', () => {
    const msg = mockMessage({
      channelType: ChannelType.DM,
      guildId: null,
      channelId: 'DM_1',
    });
    const ev = mapDiscordMessage(msg, BOT_ID);
    expect(ev).not.toBeNull();
    expect((ev!.payload as any).kind).toBe(KIND_DISCORD_DM);
    expect(ev!.event_id).toBe('discord:dm/DM_1/MSG_1');
    // trigger_id omitted when not passed (Rust serde marks it Option-skipped).
    expect(ev!.trigger_id).toBeUndefined();
  });

  it('ignores guild messages without a bot mention', () => {
    const msg = mockMessage({
      channelType: ChannelType.GuildText,
      mentions: ['SOMEONE_ELSE'],
    });
    expect(mapDiscordMessage(msg, BOT_ID)).toBeNull();
  });

  it('ignores bot-authored messages', () => {
    const msg = mockMessage({
      channelType: ChannelType.GuildText,
      mentions: [BOT_ID],
      authorBot: true,
    });
    expect(mapDiscordMessage(msg, BOT_ID)).toBeNull();
  });

  it('ignores system messages', () => {
    const msg = mockMessage({
      channelType: ChannelType.GuildText,
      mentions: [BOT_ID],
      system: true,
    });
    expect(mapDiscordMessage(msg, BOT_ID)).toBeNull();
  });

  it('treats thread channels as mention-eligible', () => {
    const msg = mockMessage({
      channelType: ChannelType.PublicThread,
      mentions: [BOT_ID],
    });
    const ev = mapDiscordMessage(msg, BOT_ID);
    expect((ev?.payload as any)?.kind).toBe(KIND_DISCORD_MENTION);
  });

  it('ignores unsupported channel types (e.g. voice)', () => {
    const msg = mockMessage({
      channelType: ChannelType.GuildVoice,
      mentions: [BOT_ID],
    });
    expect(mapDiscordMessage(msg, BOT_ID)).toBeNull();
  });
});

describe('channelAllowed', () => {
  it('allows when no filters set', () => {
    const msg = mockMessage({ channelType: ChannelType.GuildText });
    expect(channelAllowed(msg, {})).toBe(true);
  });

  it('rejects when guild not in allowlist', () => {
    const msg = mockMessage({ channelType: ChannelType.GuildText, guildId: 'OTHER' });
    const allow: ChannelAllowlist = { guilds: new Set(['GUILD_1']) };
    expect(channelAllowed(msg, allow)).toBe(false);
  });

  it('rejects when channel not in allowlist', () => {
    const msg = mockMessage({ channelType: ChannelType.GuildText, channelId: 'OTHER' });
    const allow: ChannelAllowlist = { channels: new Set(['CHAN_1']) };
    expect(channelAllowed(msg, allow)).toBe(false);
  });

  it('accepts when guild + channel both in allowlist', () => {
    const msg = mockMessage({ channelType: ChannelType.GuildText });
    const allow: ChannelAllowlist = {
      guilds: new Set(['GUILD_1']),
      channels: new Set(['CHAN_1']),
    };
    expect(channelAllowed(msg, allow)).toBe(true);
  });
});

// ---- outbound --------------------------------------------------------------

describe('outbound RPC', () => {
  let send: ReturnType<typeof vi.fn>;
  let client: any;

  beforeEach(() => {
    send = vi.fn().mockResolvedValue({ id: 'REPLY_MSG_1' });
    client = {
      channels: {
        fetch: vi.fn().mockResolvedValue({
          type: ChannelType.GuildText,
          send,
        }),
      },
      users: {
        fetch: vi.fn().mockResolvedValue({
          createDM: vi.fn().mockResolvedValue({
            id: 'DM_CHAN_1',
            send,
          }),
        }),
      },
    };
  });

  it('sendChannelMessage posts plain content', async () => {
    const out = await sendChannelMessage(client, {
      channel_id: 'CHAN_1',
      content: 'reply text',
    });
    expect(client.channels.fetch).toHaveBeenCalledWith('CHAN_1');
    expect(send).toHaveBeenCalledWith({ content: 'reply text' });
    expect(out).toEqual({ message_id: 'REPLY_MSG_1', channel_id: 'CHAN_1' });
  });

  it('sendChannelMessage supports replying to a message', async () => {
    await sendChannelMessage(client, {
      channel_id: 'CHAN_1',
      content: 'hi',
      reply_to_message_id: 'PARENT_1',
    });
    expect(send).toHaveBeenCalledWith({
      content: 'hi',
      reply: { messageReference: 'PARENT_1' },
    });
  });

  it('sendChannelMessage rejects non-text channels', async () => {
    client.channels.fetch.mockResolvedValueOnce({ type: ChannelType.GuildVoice, send });
    await expect(
      sendChannelMessage(client, { channel_id: 'CHAN_1', content: 'x' }),
    ).rejects.toThrow(/not a writable text channel/);
  });

  it('sendDm opens a DM and sends', async () => {
    const out = await sendDm(client, { user_id: 'USER_1', content: 'hi there' });
    expect(client.users.fetch).toHaveBeenCalledWith('USER_1');
    expect(send).toHaveBeenCalledWith({ content: 'hi there' });
    expect(out).toEqual({ message_id: 'REPLY_MSG_1', channel_id: 'DM_CHAN_1' });
  });

  it('sendEmbed builds an embed and posts it', async () => {
    await sendEmbed(client, {
      channel_id: 'CHAN_1',
      embed: { title: 'Hello', description: 'world', color: 0x5865f2 },
      content: 'see embed:',
    });
    expect(send).toHaveBeenCalledTimes(1);
    const payload = send.mock.calls[0]?.[0] as { content?: string; embeds?: unknown[] };
    expect(payload.content).toBe('see embed:');
    expect(Array.isArray(payload.embeds)).toBe(true);
    expect(payload.embeds?.length).toBe(1);
  });

  it('sendEmbed rejects missing embed', async () => {
    await expect(
      sendEmbed(client, { channel_id: 'CHAN_1', embed: undefined as any }),
    ).rejects.toThrow(/embed required/);
  });
});

// ---- manifest --------------------------------------------------------------

describe('manifest', () => {
  it('declares all required methods', () => {
    expect(MANIFEST.plugin_kind).toBe('trigger_backend');
    for (const m of METHODS) {
      expect(MANIFEST.capabilities).toContain(m);
    }
  });

  it('requires DISCORD_BOT_TOKEN in env', () => {
    const required = (MANIFEST.env_required ?? []).find((e) => e.name === 'DISCORD_BOT_TOKEN');
    expect(required).toBeDefined();
    expect(required!.required).toBe(true);
    expect(required!.sensitive).toBe(true);
  });
});
