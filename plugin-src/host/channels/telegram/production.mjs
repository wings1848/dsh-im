import { TelegramConfigStore } from '../../../../src/channels/telegram/config-store.mjs';
import { TelegramHarnessClient } from '../../../../src/channels/telegram/harness-client.mjs';
import { TelegramController } from '../../../../src/channels/telegram/telegram-controller.mjs';
import { TelegramRuntime } from '../../../../src/channels/telegram/telegram-runtime.mjs';
import { TelegramStateStore } from '../../../../src/channels/telegram/state-store.mjs';
import { createTelegramVoiceTranscriber } from '../../../../src/channels/telegram/voice.mjs';
import { createTokenProductionController } from '../shared/production.mjs';

export { normalizeTelegramAllowedUsers } from '../../../../src/channels/telegram/config-store.mjs';

export function createProductionController(ctx, config = {}, internals = {}) {
  return createTokenProductionController(ctx, config, internals, {
    channel: 'telegram',
    ConfigStore: TelegramConfigStore,
    StateStore: TelegramStateStore,
    HarnessClient: TelegramHarnessClient,
    Controller: TelegramController,
    Runtime: TelegramRuntime,
    // A proactive notification card's press is an answer for the Session that
    // sent it, not a chat command: hand it to the Host's delivery service, which
    // owns delivering the choice back into that Session.
    runtimeOptions: (config) => ({
      onProactiveCardAnswer: (origin, choice) => config.deliveryService?.answerProactiveCard?.(origin, choice),
    }),
    // The per-group reply rules list chats from the shared group archive.
    controllerGroupHistory: true,
    // Speech recognition is a Host service (@deepseek-ai/dsh-experimental-speech-to-text);
    // the channel only converts the attachment and forwards the transcript.
    createVoiceTranscriber: (ctx) => createTelegramVoiceTranscriber({
      speechToText: typeof ctx?.get === 'function' ? ctx.get('speechToText') : ctx?.speechToText,
      logger: typeof ctx?.logger === 'function' ? ctx.logger('dsh-im:telegram-voice') : ctx?.logger,
    }),
  });
}
