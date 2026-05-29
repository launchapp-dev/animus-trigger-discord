// discord.js Client wrapper.
//
// Owns:
//   - Gateway intents (Guilds + GuildMessages + MessageContent + DirectMessages)
//   - Partial 'CHANNEL' so DM events fire (discord.js requires this for DM
//     channels that aren't cached at startup)
//   - login + ready handshake
//   - exposing the raw client for outbound calls (channel/DM/embed sends)
//
// The transport-layer reconnect logic ships inside discord.js itself; we
// don't reimplement WebSocket backoff here.

import { Client, GatewayIntentBits, Partials } from 'discord.js';

export interface DiscordClientOptions {
  token: string;
}

export async function createDiscordClient(opts: DiscordClientOptions): Promise<Client> {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ],
    partials: [Partials.Channel, Partials.Message],
  });

  await new Promise<void>((resolve, reject) => {
    client.once('ready', () => resolve());
    client.once('error', (err) => reject(err));
    client.login(opts.token).catch(reject);
  });

  return client;
}
