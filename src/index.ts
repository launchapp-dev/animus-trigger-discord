// Discord trigger backend plugin — entrypoint.
//
// The TS SDK v0.1.0 only wires the `subject_backend` dispatcher in
// `definePlugin`. For `trigger_backend` we build directly on the SDK's
// exported low-level helpers (`createWire`, `buildManifest`,
// `buildInitializeResult`, `validateInitializeParams`, `okResponse`,
// `errorResponse`) so the wire/handshake/protocol behavior still matches
// the SDK's contract.
//
// Wire surface:
//   - `initialize`                    — handshake (protocol version check)
//   - `$/ping`                        — keepalive
//   - `health/check`                  — returns Discord client state
//   - `shutdown` / `exit`             — graceful teardown
//   - `trigger/watch`                 — long-running; starts Gateway; events
//                                       are streamed via `trigger/event`
//                                       notifications
//   - `trigger/ack`                   — no-op for v0.1.0
//   - `discord/send_channel_message`  — outbound: post to channel
//   - `discord/send_dm`               — outbound: DM a user
//   - `discord/send_embed`            — outbound: post embed

import process from 'node:process';
import { stdout as nodeStdout } from 'node:process';

import {
  buildInitializeResult,
  buildManifest,
  createWire,
  errorResponse,
  ErrorCode,
  okResponse,
  PluginKind,
  validateInitializeParams,
  type PluginCapabilities,
  type PluginManifest,
  type RpcId,
  type RpcRequest,
  type RpcResponse,
} from '@launchapp-dev/animus-plugin-sdk';
import type { Client, Message } from 'discord.js';

import { createDiscordClient } from './discord-client.js';
import {
  channelAllowed,
  KIND_DISCORD_DM,
  KIND_DISCORD_MENTION,
  mapDiscordMessage,
  type ChannelAllowlist,
} from './inbound.js';
import {
  sendChannelMessage,
  sendDm,
  sendEmbed,
  type SendChannelMessageParams,
  type SendDmParams,
  type SendEmbedParams,
} from './outbound.js';

const PLUGIN_NAME = 'animus-trigger-discord';
const PLUGIN_VERSION = '0.1.1';
const PLUGIN_DESCRIPTION =
  'Discord trigger backend — emits mention + DM events, sends replies via outbound RPC';

const METHODS = [
  'trigger/watch',
  'trigger/schema',
  'trigger/ack',
  'discord/send_channel_message',
  'discord/send_dm',
  'discord/send_embed',
  'health/check',
];

const IDENTITY = {
  name: PLUGIN_NAME,
  version: PLUGIN_VERSION,
  description: PLUGIN_DESCRIPTION,
  plugin_kind: PluginKind.TriggerBackend,
};

const CAPABILITIES: PluginCapabilities = {
  methods: METHODS,
  streaming: true,
  progress: false,
  cancellation: false,
};

const MANIFEST: PluginManifest = buildManifest(IDENTITY, CAPABILITIES, {
  env_required: [
    {
      name: 'DISCORD_BOT_TOKEN',
      description: 'Discord bot token (Bot tab in discord.com/developers).',
      required: true,
      sensitive: true,
    },
    {
      name: 'DISCORD_FILTER_GUILDS',
      description: 'Comma-separated guild IDs to listen on (default: all).',
      required: false,
    },
    {
      name: 'DISCORD_FILTER_CHANNELS',
      description: 'Comma-separated channel IDs to listen on (default: all).',
      required: false,
    },
  ],
});

const TRIGGER_SCHEMA = {
  kinds: [KIND_DISCORD_MENTION, KIND_DISCORD_DM],
  supports_resume: false,
  supports_dedup: false,
  supports_ack: true,
};

interface RuntimeState {
  client: Client | null;
  watching: boolean;
  lastError: string | null;
  startedAt: number;
}

const state: RuntimeState = {
  client: null,
  watching: false,
  lastError: null,
  startedAt: Date.now(),
};

function parseAllowlistFromEnv(): ChannelAllowlist {
  const guilds = process.env.DISCORD_FILTER_GUILDS;
  const channels = process.env.DISCORD_FILTER_CHANNELS;
  return {
    guilds: guilds ? new Set(guilds.split(',').map((s) => s.trim()).filter(Boolean)) : undefined,
    channels: channels ? new Set(channels.split(',').map((s) => s.trim()).filter(Boolean)) : undefined,
  };
}

async function ensureClient(): Promise<Client> {
  if (state.client) return state.client;
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    throw new Error('DISCORD_BOT_TOKEN is not set in plugin environment');
  }
  const client = await createDiscordClient({ token });
  state.client = client;
  return client;
}

async function handleManifestArg(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    nodeStdout.write(`${JSON.stringify(MANIFEST)}\n`, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
  process.exit(0);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--manifest') || args.includes('-m')) {
    await handleManifestArg();
    return;
  }
  if (args.includes('--help') || args.includes('-h')) {
    process.stderr.write(
      `${PLUGIN_NAME} ${PLUGIN_VERSION} - Animus STDIO plugin\n` +
        'Usage:\n' +
        `  ${PLUGIN_NAME} --manifest    Print plugin manifest as JSON and exit\n` +
        `  ${PLUGIN_NAME}               Run JSON-RPC loop on stdin/stdout\n`,
    );
    process.exit(0);
    return;
  }

  const wire = createWire();
  await wire.run(async (frame) => dispatch(frame, wire));
}

async function dispatch(
  frame: RpcRequest,
  wire: ReturnType<typeof createWire>,
): Promise<RpcResponse | undefined> {
  const id = frame.id;
  const method = frame.method;

  // Notifications: per JSON-RPC 2.0, missing `id` means notification.
  if (id === undefined) {
    if (method === 'exit') {
      setImmediate(() => process.exit(0));
      return undefined;
    }
    return undefined;
  }

  switch (method) {
    case 'initialize': {
      const params = (frame.params ?? {}) as Parameters<typeof validateInitializeParams>[0];
      const incompat = validateInitializeParams(params);
      if (incompat) {
        return errorResponse(id, ErrorCode.InvalidRequest, incompat);
      }
      return okResponse(id, buildInitializeResult(IDENTITY, CAPABILITIES));
    }
    case '$/ping':
      return okResponse(id, {});
    case 'health/check': {
      const ready = state.client?.isReady() ?? false;
      const status = state.lastError ? 'unhealthy' : ready || !state.watching ? 'healthy' : 'degraded';
      return okResponse(id, {
        status,
        uptime_ms: Date.now() - state.startedAt,
        memory_usage_bytes: process.memoryUsage().rss,
        last_error: state.lastError,
      });
    }
    case 'shutdown':
      await teardown();
      return okResponse(id, {});
    case 'exit':
      await teardown();
      setImmediate(() => process.exit(0));
      return okResponse(id, {});
    case 'trigger/watch':
      return handleWatch(id, frame, wire);
    case 'trigger/schema':
      return okResponse(id, TRIGGER_SCHEMA);
    case 'trigger/ack':
      // No-op: Discord acks happen inside discord.js's internal Gateway loop.
      return okResponse(id, {});
    case 'discord/send_channel_message':
      return wrapOutbound(id, () =>
        sendChannelMessage(state.client!, (frame.params ?? {}) as SendChannelMessageParams),
      );
    case 'discord/send_dm':
      return wrapOutbound(id, () =>
        sendDm(state.client!, (frame.params ?? {}) as SendDmParams),
      );
    case 'discord/send_embed':
      return wrapOutbound(id, () =>
        sendEmbed(state.client!, (frame.params ?? {}) as SendEmbedParams),
      );
    default:
      return errorResponse(id, ErrorCode.MethodNotFound, `unknown method '${method}'`);
  }
}

async function wrapOutbound<T>(id: RpcId, run: () => Promise<T>): Promise<RpcResponse> {
  try {
    await ensureClient();
    const out = await run();
    return okResponse(id, out as unknown);
  } catch (err) {
    return errorResponse(
      id,
      ErrorCode.InternalError,
      `discord outbound error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function handleWatch(
  id: RpcId,
  frame: RpcRequest,
  wire: ReturnType<typeof createWire>,
): Promise<RpcResponse> {
  if (state.watching) {
    // Already watching from a previous trigger/watch — acknowledge but don't
    // attach a second listener (would duplicate every event).
    return okResponse(id, { watching: true });
  }
  let client: Client;
  try {
    client = await ensureClient();
  } catch (err) {
    state.lastError = err instanceof Error ? err.message : String(err);
    return errorResponse(id, ErrorCode.InternalError, state.lastError);
  }

  const params = (frame.params ?? {}) as { trigger_id?: string };
  const triggerId = params.trigger_id ?? 'discord';
  const allowlist = parseAllowlistFromEnv();
  const botUserId = client.user?.id;
  if (!botUserId) {
    state.lastError = 'discord client ready but user id missing';
    return errorResponse(id, ErrorCode.InternalError, state.lastError);
  }

  client.on('messageCreate', (message: Message) => {
    if (!channelAllowed(message, allowlist)) return;
    const event = mapDiscordMessage(message, botUserId, triggerId);
    if (!event) return;
    // Stream to the host as a JSON-RPC notification. The Rust trigger host
    // (crates/orchestrator-daemon-runtime/.../trigger_supervisor.rs:294)
    // deserializes `notification.params` directly into the protocol's
    // `TriggerEvent` struct, so params MUST be the flat event itself —
    // wrapping it as `{ trigger_id, event }` would fail to decode and the
    // host would drop the notification.
    void wire.notify('trigger/event', event);
  });

  state.watching = true;
  state.lastError = null;
  return okResponse(id, { watching: true, bot_user_id: botUserId });
}

async function teardown(): Promise<void> {
  if (state.client) {
    try {
      await state.client.destroy();
    } catch {
      // best-effort
    }
    state.client = null;
  }
  state.watching = false;
}

// Only run when executed as the binary, not when imported by tests.
const isMain = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  return entry.endsWith('index.cjs') || entry.endsWith('index.js') || entry.endsWith('animus-trigger-discord');
})();

if (isMain) {
  main().catch((err) => {
    process.stderr.write(`[animus-trigger-discord] fatal: ${String(err)}\n`);
    process.exit(1);
  });
}

// Exported for tests.
export {
  MANIFEST,
  METHODS,
  dispatch,
  handleWatch,
  parseAllowlistFromEnv,
  state as __testState,
};
