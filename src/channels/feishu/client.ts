import type { Logger } from "../../observability/logger.ts";

export interface FeishuClientConfig {
  appId: string;
  appSecret: string;
  apiBaseUrl?: string;
  tokenRefreshBeforeMs?: number;
  fetchFn?: typeof fetch;
}

export class FeishuClient {
  private readonly appId: string;
  private readonly appSecret: string;
  private readonly apiBaseUrl: string;
  private readonly refreshBeforeMs: number;
  private readonly fetch: typeof fetch;

  private cachedToken: string | null = null;
  private tokenExpiresAt = 0;
  private pendingTokenRequest: Promise<string> | null = null;

  constructor(
    config: FeishuClientConfig,
    private readonly logger?: Logger,
  ) {
    this.appId = config.appId.trim();
    this.appSecret = config.appSecret.trim();
    this.apiBaseUrl = (config.apiBaseUrl ?? "https://open.feishu.cn").replace(/\/+$/, "");
    this.refreshBeforeMs = config.tokenRefreshBeforeMs ?? 60_000;
    this.fetch = config.fetchFn ?? fetch;
  }

  isConfigured(): boolean {
    return Boolean(this.appId && this.appSecret);
  }

  async getTenantAccessToken(): Promise<string> {
    if (!this.isConfigured()) {
      throw new Error("FeishuClient is not configured with appId and appSecret");
    }

    if (this.cachedToken && Date.now() + this.refreshBeforeMs < this.tokenExpiresAt) {
      return this.cachedToken;
    }

    // Coalesce concurrent token requests
    if (this.pendingTokenRequest) {
      return this.pendingTokenRequest;
    }

    this.pendingTokenRequest = (async () => {
      try {
        const url = `${this.apiBaseUrl}/open-apis/auth/v3/tenant_access_token/internal`;
        const res = await this.fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json; charset=utf-8" },
          body: JSON.stringify({
            app_id: this.appId,
            app_secret: this.appSecret,
          }),
        });

        if (!res.ok) {
          const body = await res.text().catch(() => "");
          throw new Error(`Feishu tenant_access_token HTTP ${res.status}: ${body}`);
        }

        const data = (await res.json()) as {
          code: number;
          msg: string;
          tenant_access_token?: string;
          expire?: number;
        };

        if (data.code !== 0 || !data.tenant_access_token || !data.expire) {
          throw new Error(`Feishu tenant_access_token failed (${data.code}): ${data.msg}`);
        }

        this.cachedToken = data.tenant_access_token;
        this.tokenExpiresAt = Date.now() + data.expire * 1000;
        return data.tenant_access_token;
      } finally {
        this.pendingTokenRequest = null;
      }
    })();

    return this.pendingTokenRequest;
  }

  async sendCard(params: {
    receiveId: string;
    receiveIdType?: "chat_id" | "open_id";
    rootId?: string;
    card: Record<string, unknown> | string;
  }): Promise<string> {
    const token = await this.getTenantAccessToken();
    const receiveIdType = params.receiveIdType ?? "chat_id";
    const url = `${this.apiBaseUrl}/open-apis/im/v1/messages?receive_id_type=${receiveIdType}`;

    const cardContent = typeof params.card === "string" ? params.card : JSON.stringify(params.card);

    const payload: Record<string, unknown> = {
      receive_id: params.receiveId,
      msg_type: "interactive",
      content: cardContent,
    };
    if (params.rootId) {
      payload.root_id = params.rootId;
    }

    const res = await this.fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Feishu sendCard HTTP ${res.status}: ${body}`);
    }

    const data = (await res.json()) as {
      code: number;
      msg: string;
      data?: { message_id: string };
    };

    if (data.code !== 0 || !data.data?.message_id) {
      throw new Error(`Feishu sendCard failed (${data.code}): ${data.msg}`);
    }

    return data.data.message_id;
  }

  async updateCard(params: {
    messageId: string;
    card: Record<string, unknown> | string;
  }): Promise<void> {
    const token = await this.getTenantAccessToken();
    const url = `${this.apiBaseUrl}/open-apis/im/v1/messages/${encodeURIComponent(params.messageId)}`;

    const cardContent = typeof params.card === "string" ? params.card : JSON.stringify(params.card);

    const res = await this.fetch(url, {
      method: "PATCH",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({ content: cardContent }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      this.logger?.warn("Feishu updateCard HTTP failure", {
        messageId: params.messageId,
        status: res.status,
        body,
      });
      throw new Error(`Feishu updateCard HTTP ${res.status}: ${body}`);
    }

    const data = (await res.json()) as { code: number; msg: string };
    if (data.code !== 0) {
      this.logger?.warn("Feishu updateCard business error", {
        messageId: params.messageId,
        code: data.code,
        msg: data.msg,
      });
      throw new Error(`Feishu updateCard failed (${data.code}): ${data.msg}`);
    }
  }
}
