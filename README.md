# animus-trigger-discord

Discord trigger backend plugin for [Animus](https://github.com/launchapp-dev/animus-cli).

Emits Animus `TriggerEvent`s for Discord mentions + DMs, and exposes outbound
RPC methods so workflow phases can post replies after human review.

## Status

`v0.1.0` — initial release. Built on top of `@launchapp-dev/animus-plugin-sdk`
(TypeScript SDK, v0.1.0) and `discord.js` v14.

## What's inside

**Inbound events** (streamed via `trigger/event` notifications):

| Kind                | When it fires                                          |
| ------------------- | ------------------------------------------------------ |
| `discord.mention`   | Bot is `@mentioned` in a guild text channel or thread  |
| `discord.dm`        | User sends a direct message to the bot                 |

The original Discord `Message` is serialized into the event `payload` so
workflow YAML can template against `{{trigger.payload.content}}`,
`{{trigger.payload.author.id}}`, attachments, etc.

**Outbound RPC methods** (called by workflow phases via `mode: plugin_call`):

| Method                            | Use                                 |
| --------------------------------- | ----------------------------------- |
| `discord/send_channel_message`    | Post text to a guild text channel   |
| `discord/send_dm`                 | Open + post a DM to a user          |
| `discord/send_embed`              | Post an embed (with optional text)  |

All outbound methods return `{ message_id, channel_id }` so the workflow can
correlate replies to follow-up events.

## Required env

| Name                       | Required | Description                                                  |
| -------------------------- | -------- | ------------------------------------------------------------ |
| `DISCORD_BOT_TOKEN`        | yes      | Bot token from <https://discord.com/developers> -> Bot tab.  |
| `DISCORD_FILTER_GUILDS`    | no       | Comma-separated guild (server) ids to listen on.             |
| `DISCORD_FILTER_CHANNELS`  | no       | Comma-separated channel ids to listen on.                    |

## Setup

1. **Create a Discord application + bot** at
   <https://discord.com/developers/applications>. Under the **Bot** tab,
   enable these **Privileged Gateway Intents**:
   - `Server Members Intent`
   - `Message Content Intent`
2. **Copy the bot token** and add it to your Animus daemon environment as
   `DISCORD_BOT_TOKEN`.
3. **Invite the bot to your server.** From the application's
   **OAuth2 -> URL Generator** tab, pick scopes `bot` and
   `applications.commands`. Pick at least these bot permissions:
   `Read Messages/View Channels`, `Send Messages`, `Embed Links`,
   `Read Message History`. Open the generated URL and authorize.
4. **Install the plugin into Animus:**

   ```bash
   animus plugin install launchapp-dev/animus-trigger-discord@v0.1.0
   ```

5. **Wire it into a workflow.** Reference the trigger by id in
   `.animus/workflows.yaml`:

   ```yaml
   triggers:
     - id: discord-inbox
       backend: animus-trigger-discord
       kinds: [discord.mention, discord.dm]
   ```

   And reply from a phase via `plugin_call`:

   ```yaml
   phases:
     - name: reply
       mode: plugin_call
       plugin: animus-trigger-discord
       method: discord/send_channel_message
       params:
         channel_id: "{{trigger.payload.channel_id}}"
         content: "Got it — task created."
         reply_to_message_id: "{{trigger.payload.id}}"
   ```

6. **Restart the daemon** so it picks up the new plugin:

   ```bash
   animus daemon stop && animus daemon start
   ```

## Development

```bash
npm install
npm run build
npm run typecheck
npm test
```

The build produces `dist/index.cjs` (a single bundled Node executable). The plugin
manifest is emitted via `node dist/index.cjs --manifest` — Animus's
`plugin info` reads this to introspect capabilities.

## Not yet covered (v0.2+ ideas)

- **Slash commands** — bot-side `/command` registration + `InteractionCreate`
  events as a third inbound kind (`discord.slash_command`).
- **Voice channels** — voice state updates, recording, TTS replies.
- **Button + select-menu interactions** — `discord.interaction` event for
  components on previously-sent embeds.
- **Reactions** — `discord.reaction_added` event for emoji-driven triage.
- **Webhook outbound** — `discord/send_webhook` for posting as a custom name
  + avatar rather than as the bot.
- **Thread creation** — `discord/create_thread` outbound RPC.

## License

Elastic License 2.0 — see [LICENSE](./LICENSE).
