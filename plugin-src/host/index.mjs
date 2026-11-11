import { randomUUID } from 'node:crypto';

import { installGroupHistoryTools } from '../../src/channels/shared/group-history-access.mjs';
import { apply as applyDingtalk } from './channels/dingtalk/index.mjs';
import { apply as applyDiscord } from './channels/discord/index.mjs';
import { apply as applyOffice } from './channels/office/index.mjs';
import { apply as applyFeishu } from './channels/feishu/index.mjs';
import { apply as applyQq } from './channels/qq/index.mjs';
import { apply as applySlack } from './channels/slack/index.mjs';
import { apply as applyTelegram } from './channels/telegram/index.mjs';
import { apply as applyWecom } from './channels/wecom/index.mjs';
import { apply as applyWecomApp } from './channels/wecom-app/index.mjs';
import { apply as applyWeixin } from './channels/weixin/index.mjs';
import { apply as applyWhatsapp } from './channels/whatsapp/index.mjs';
import { apply as applyIMessage } from './channels/imessage/index.mjs';
import { apply as applyEmail } from './channels/email/index.mjs';
import { apply as applyMatrix } from './channels/matrix/index.mjs';
import { installOutboundArtifactTool } from '../../src/channels/shared/semantic/artifact.mjs';
import { installHostLanguage } from './host-language.mjs';
import { installHostLanguageRpc } from './host-language-rpc.mjs';
import { installDeliveryRpc } from './delivery-rpc.mjs';
import { installDeliveryHttp } from './delivery-http.mjs';
import { createDeliveryService } from './delivery-service.mjs';
import { createDsBotClient } from './ds-bot-client.mjs';
import { installDsBotQuestionSync } from './ds-bot-question-sync.mjs';
import { installInboundTtlRpc } from './inbound-ttl-rpc.mjs';
import { installDeliverySyncRpc } from './delivery-sync-rpc.mjs';
import { installSidebarSettingsRpc } from './sidebar-settings.mjs';
import { installInjectedContext } from './injected-context.mjs';
import { installSessionSyncCoordinator } from './session-sync-coordinator.mjs';
import { deliverySwitchesOff } from '../../src/channels/shared/delivery-sync-settings.mjs';
import { getDeliverySyncSettingsStore } from '../../src/channels/shared/delivery-sync-settings-store.mjs';
import { installSessionTitlePrefix } from './session-title-prefix.mjs';
import { installImNotifyTool } from './im-notify-tool.mjs';
import { t } from '../../src/channels/shared/i18n.mjs';
import { NotifyTargetStore, installNotifyTargetRpc, notifyTargetPath } from './notify-settings.mjs';
import { modernHarnessApi } from './modern-harness-api.mjs';
import { installUpdateRpc } from './update-rpc.mjs';

export const name = 'dsh-im-host';
export const inject = [
  'connection',
  'credentials',
  'typertGateway',
];

function channelConfig(config, name, deliveryService) {
  const channel = {
    ...(config.dshHome ? { dshHome: config.dshHome } : {}),
    ...(config.groupByAgentPreset === undefined ? {} : { groupByAgentPreset: config.groupByAgentPreset }),
    ...config[name],
  };
  const withAuthority = config.rpcAuthority === undefined
    ? channel
    : { ...channel, rpcAuthority: config.rpcAuthority };
  return name === 'office' ? withAuthority : { ...withAuthority, deliveryService };
}

export function createImHostPlugin(internals = {}) {
  const startHostLanguage = internals.installHostLanguage ?? installHostLanguage;
  const startHostLanguageRpc = internals.installHostLanguageRpc ?? installHostLanguageRpc;
  const startUpdate = internals.installUpdateRpc ?? installUpdateRpc;
  const startInboundTtl = internals.installInboundTtlRpc ?? installInboundTtlRpc;
  const startDeliverySync = internals.installDeliverySyncRpc ?? installDeliverySyncRpc;
  const startSidebarSettings = internals.installSidebarSettingsRpc ?? installSidebarSettingsRpc;
  const startInjectedContext = internals.installInjectedContext ?? installInjectedContext;
  const startDelivery = internals.installDeliveryRpc ?? installDeliveryRpc;
  const startDeliveryHttp = internals.installDeliveryHttp ?? installDeliveryHttp;
  const startSessionSync = internals.installSessionSyncCoordinator
    ?? installSessionSyncCoordinator;
  const startNotifyTarget = internals.installNotifyTargetRpc ?? installNotifyTargetRpc;
  const makeDeliveryService = internals.createDeliveryService ?? createDeliveryService;
  const startFeishu = internals.applyFeishu ?? applyFeishu;
  const startWeixin = internals.applyWeixin ?? applyWeixin;
  const startDingtalk = internals.applyDingtalk ?? applyDingtalk;
  const startWecom = internals.applyWecom ?? applyWecom;
  const startWecomApp = internals.applyWecomApp ?? applyWecomApp;
  const startQq = internals.applyQq ?? applyQq;
  const startSlack = internals.applySlack ?? applySlack;
  const startTelegram = internals.applyTelegram ?? applyTelegram;
  const startDiscord = internals.applyDiscord ?? applyDiscord;
  const startOffice = internals.applyOffice ?? applyOffice;
  const startWhatsapp = internals.applyWhatsapp ?? applyWhatsapp;
  const startIMessage = internals.applyIMessage ?? applyIMessage;
  const startEmail = internals.applyEmail ?? applyEmail;
  const startMatrix = internals.applyMatrix ?? applyMatrix;
  const channels = [
    ['feishu', startFeishu],
    ['weixin', startWeixin],
    ['dingtalk', startDingtalk],
    ['wecom', startWecom],
    ['wecomApp', startWecomApp],
    ['qq', startQq],
    ['slack', startSlack],
    ['telegram', startTelegram],
    ['discord', startDiscord],
    ['whatsapp', startWhatsapp],
    ['imessage', startIMessage],
    ['email', startEmail],
    ['matrix', startMatrix],
    ['office', startOffice],
  ];
  return Object.freeze({
    name,
    inject,
    async apply(ctx, config = {}) {
      const unavailableSessionSyncChannels = channels
        .map(([channel]) => channel)
        .filter((channel) => channel !== 'office'
          && config[channel]?.harnessBaseUrl !== undefined);
      const deliveryService = makeDeliveryService({
        unavailableSessionSyncChannels: unavailableSessionSyncChannels.map((channel) => channel === 'wecomApp' ? 'wecom-app' : channel),
        dsBot: createDsBotClient(ctx),
      });
      const notifyStore = new NotifyTargetStore(notifyTargetPath(config));
      // A notification card's choice is delivered back to the Session that sent
      // it; `modernHarnessApi` is cached per Host scope, so this shares the
      // channel-side instance instead of arming a second set of listeners.
      try {
        const harness = modernHarnessApi(ctx, { deliveryService });
        deliveryService.setProactiveAnswerHandler(async (origin, choice) => {
          // The model-facing value can differ from the button text; keep both so
          // a Session can branch on a stable id instead of a label.
          const selected = choice.value && choice.value !== choice.label
            ? `${choice.label}（${choice.value}）`
            : choice.label;
          const response = await harness.sessions.prompt({
            rpcId: `dsh-im-card-${randomUUID()}`,
            payload: {
              sessionId: origin.sessionId,
              mode: 'queue',
              content: [{
                type: 'text',
                text: t('[IM 选项卡 · {session}] 已选择：{choice}', {
                  session: origin.label, choice: selected,
                }),
              }],
            },
          });
          // The gateway reports business failures inside the envelope instead of
          // rejecting, so a disposed or archived Session would otherwise look
          // like a delivered choice.
          if (response?.result?.ok === false) {
            const error = new Error(response.result.error?.message ?? 'session prompt rejected');
            error.code = response.result.error?.code;
            throw error;
          }
        });
      } catch (error) {
        // A Host without the modern Typert gateway simply cannot accept answers;
        // that is a capability gap, not a failure worth warning about.
        if (!/modern Host Typert gateway/u.test(String(error?.message ?? ''))) {
          const log = typeof ctx?.logger === 'function' ? ctx.logger(name) : (ctx?.logger ?? console);
          log?.warn?.('[dsh-im] notification answers are unavailable:', error?.message ?? error);
        }
      }
      // The delivery switches are the master for everything that follows a Session
      // through its targets: with both off, `listSessionSyncTargets` answers empty,
      // so neither the coordinator nor a channel's own mirror (Feishu card) sends.
      // A settings read failure must not disable delivery, so it falls through.
      if (typeof deliveryService.listSessionSyncTargets === 'function') {
        const rawListSessionSyncTargets = deliveryService.listSessionSyncTargets.bind(deliveryService);
        deliveryService.listSessionSyncTargets = async (sessionId) => {
          try {
            if (deliverySwitchesOff(await getDeliverySyncSettingsStore(config).get())) return [];
          } catch {
            // keep the unwrapped behaviour
          }
          return rawListSessionSyncTargets(sessionId);
        };
      }
      /** Sessions already reported, so the log stays one line per session. */
      const describedSessions = new Set();
      const describeConversationLogged = async (sessionId) => {
        const described = await deliveryService.describeConversation(sessionId);
        if (described && !describedSessions.has(sessionId)) {
          describedSessions.add(sessionId);
          const log = typeof ctx?.logger === 'function' ? ctx.logger(name) : (ctx?.logger ?? console);
          try {
            log?.info?.(`describeConversation session=${sessionId} chat=${described.conversationKey} sender=${described.senderId ?? '-'}`);
          } catch {
            // Logging must never break the lookup.
          }
        }
        return described;
      };
      if (typeof ctx?.provide === 'function') {
        ctx.provide('dshIm', Object.freeze({
          contractVersion: 1,
          receiptVersion: 1,
          inboundVersion: 1,
          consumeInbound: (botId, options) => deliveryService.consumeInbound(botId, options),
          historyChecked: (botId, route, query, options) => deliveryService.historyChecked(botId, route, query, options),
          replyChecked: (botId, route, text, options) => deliveryService.replyChecked(botId, route, text, options),
          describeConversation: (sessionId) => describeConversationLogged(sessionId),

          // Prompt assembly is synchronous, so a caller that needs the identity
          // before the first step cannot await the async variant.
          describeConversationSync: (sessionId) => deliveryService.describeConversationSync(sessionId),
          describeBot: (botId) => deliveryService.describeBot(botId),
          sendChecked: (botId, targetId, text, options) => deliveryService.sendChecked(botId, targetId, text, options),
          send: (botId, targetId, text, options) => (
            deliveryService.send(botId, targetId, text, options)
          ),
          listTargets: async (botId) => (await deliveryService.listTargets(botId)).targets,
          createTarget: (botId, target) => deliveryService.createTarget(botId, target),
          listBots: () => deliveryService.listBots(),
        }));
      }
      const activate = async (readyCtx) => {
        await activateChannels(readyCtx, config, deliveryService, notifyStore);
      };
      if (typeof ctx?.inject === 'function') {
        await ctx.inject(
          ['sessionController', 'workspaceController'],
          activate,
        );
        ctx.inject(['webServer'], (httpCtx) => {
          startDeliveryHttp(httpCtx, deliveryService);
        });
        return;
      }
      await activate(ctx);
      if (ctx?.webServer?.register && typeof ctx?.effect === 'function') {
        startDeliveryHttp(ctx, deliveryService);
      }
    },
  });

  async function activateChannels(ctx, config, deliveryService, notifyStore) {
    // Bind the bot message language before any channel connects, so the first
    // command menu a platform stores is already in the interface language.
    const hostLanguage = startHostLanguage(ctx, config);
    const logger = typeof ctx?.logger === 'function'
      ? ctx.logger(name)
      : (ctx?.logger ?? console);
    await hostLanguage?.ready;
    const startTitlePrefix = (titleCtx) => {
      // The installer owns its cleanup through ctx.effect(). Cordis startup
      // callbacks must not return its controller object as an effect.
      installSessionTitlePrefix(titleCtx, {
        logger: typeof titleCtx?.logger === 'function'
          ? titleCtx.logger('dsh-im:session-title') : (titleCtx?.logger ?? console),
      });
    };
    if (typeof ctx?.inject === 'function') {
      ctx.inject(['sessions'], startTitlePrefix);
    } else if (ctx?.sessions && typeof ctx.on === 'function') {
      startTitlePrefix(ctx);
    }
    if (typeof ctx?.inject === 'function') {
      ctx.inject(['tools', 'systemPrompt'], (artifactCtx) => {
        installOutboundArtifactTool(artifactCtx);
        installGroupHistoryTools(artifactCtx);
        installImNotifyTool(artifactCtx, {
          deliveryService,
          store: notifyStore,
          logger: typeof artifactCtx?.logger === 'function'
            ? artifactCtx.logger('dsh-im:notify') : logger,
        });
      });
    } else {
      installOutboundArtifactTool(ctx);
      installGroupHistoryTools(ctx);
      installImNotifyTool(ctx, { deliveryService, store: notifyStore, logger });
    }
    try {
      startInjectedContext(ctx, { logger });
    } catch (error) {
      logger.error?.('[dsh-im] failed to activate injected-context pairing; prompts keep the inline prefix', error);
    }
    if (ctx?.connection?.fetch) {
      if (hostLanguage) {
        try {
          startHostLanguageRpc(ctx, hostLanguage, config.rpcAuthority);
        } catch (error) {
          logger.error?.('[dsh-im] failed to activate interface language mirroring; continuing with channels', error);
        }
      }
      try {
        startUpdate(ctx, { authority: config.rpcAuthority });
      } catch (error) {
        logger.error?.('[dsh-im] failed to activate update management; continuing with channels', error);
      }
      try {
        startSidebarSettings(ctx, { config });
      } catch (error) {
        logger.error?.('[dsh-im] failed to activate sidebar settings; continuing with channels', error);
      }
      // The registry is absent on Hosts that do not expose management RPC yet;
      // that is a capability limit, not an activation failure worth logging.
      if (typeof ctx?.connection?.fetch?.register === 'function') {
        try {
          startNotifyTarget(ctx, { config });
        } catch (error) {
          logger.error?.('[dsh-im] failed to activate default notify target settings; continuing with channels', error);
        }
      }
      try {
        startInboundTtl(ctx, { config });
        startDeliverySync(ctx, { config });
      } catch (error) {
        logger.error?.('[dsh-im] failed to activate inbound TTL settings; continuing with channels', error);
      }
      try {
        startDelivery(ctx, deliveryService, { authority: config.rpcAuthority });
      } catch (error) {
        logger.error?.('[dsh-im] failed to activate delivery management; continuing with channels', error);
      }
    }
    const failures = [];
    // Each channel mounts its management RPC before awaiting initialization.
    // Start them together so a slow channel cannot leave later routes absent.
    await Promise.all(channels.map(async ([channel, start]) => {
      try {
        await start(ctx, channelConfig(config, channel, deliveryService));
      } catch (error) {
        failures.push(error);
        logger.error?.(`[dsh-im] failed to activate ${channel}; continuing with the remaining channels`, error);
      }
    }));
    if (failures.length === channels.length) {
      throw new AggregateError(failures, 'dsh-im failed to activate every channel');
    }
    if (typeof ctx?.on === 'function') {
      try {
        startSessionSync(ctx, deliveryService, {
          logger,
          inputScope: ctx.root ?? ctx,
          config,
        });
        installDsBotQuestionSync(ctx, deliveryService, { logger });
      } catch (error) {
        logger.error?.('[dsh-im] failed to activate Session sync; continuing with channels', error);
      }
    }
  }
}

export async function apply(ctx, config = {}) {
  return createImHostPlugin().apply(ctx, config);
}
