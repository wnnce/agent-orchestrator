import type { AppConfig } from "../config/config.ts";
import type { EventHub } from "../events/hub.ts";
import type { Logger } from "../observability/logger.ts";
import type { SessionManager } from "../session/index.ts";
import { FeishuChannel } from "./feishu/channel.ts";
import type { Channel } from "./types.ts";
import { WeComChannel } from "./wecom/channel.ts";

export interface ChannelDeps {
  readonly eventHub: EventHub;
  readonly sessionManager: SessionManager;
  readonly logger: Logger;
}

/** The chat channels enabled in `config`. */
export function createChannels(config: AppConfig, deps: ChannelDeps): Channel[] {
  const channels: Channel[] = [];
  const feishu = config.feishu;
  if (feishu?.enabled && feishu.appId && feishu.appSecret) {
    channels.push(
      new FeishuChannel(
        {
          appId: feishu.appId,
          appSecret: feishu.appSecret,
          ...(feishu.apiBaseUrl ? { apiBaseUrl: feishu.apiBaseUrl } : {}),
        },
        deps,
      ),
    );
  }
  const wecom = config.wecom;
  if (wecom?.enabled && wecom.botId && wecom.secret) {
    channels.push(
      new WeComChannel(
        {
          botId: wecom.botId,
          secret: wecom.secret,
          ...(wecom.wsUrl ? { wsUrl: wecom.wsUrl } : {}),
        },
        deps,
      ),
    );
  }
  return channels;
}
