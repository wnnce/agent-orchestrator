import type { TitlesConfig } from "../config/service.ts";
import { Logger } from "../observability/logger.ts";

const TITLE_PROMPT =
  "你是一个会话标题生成器。根据用户的第一句话或问题，提炼一个极其精炼的中文标题（4到10个字）。" +
  "直接返回标题文本，严禁包含任何标点符号、前缀、引号或解释说明。";

/** Names a session after its first message. */
export class SessionTitleGenerator {
  constructor(
    private readonly config: TitlesConfig | undefined,
    private readonly logger = new Logger(),
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  /** A title from the configured model, falling back to the message's first line. */
  async generate(message: string): Promise<string | undefined> {
    const text = message.trim();
    if (!text) return undefined;
    return (await this.fromModel(text)) ?? firstLineTitle(text);
  }

  private async fromModel(text: string): Promise<string | undefined> {
    const { apiKey, model, baseUrl } = this.config ?? {};
    if (!apiKey || !model || !baseUrl) return undefined;
    try {
      const response = await this.fetchFn(`${baseUrl.replace(/\/+$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          temperature: 0.3,
          messages: [
            { role: "system", content: TITLE_PROMPT },
            { role: "user", content: text.slice(0, 500) },
          ],
        }),
      });
      if (!response.ok) {
        this.logger.warn("session title model request failed", { status: response.status });
        return undefined;
      }
      const data = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      return cleanTitle(data.choices?.[0]?.message?.content ?? "");
    } catch (error) {
      this.logger.warn("session title model request failed", { error });
      return undefined;
    }
  }
}

function cleanTitle(raw: string): string | undefined {
  const title = raw
    .replace(/[。？！\n\r]/g, "")
    .replace(/^["'“”‘’#\s*`]+|["'“”‘’#\s*`]+$/g, "")
    .slice(0, 50);
  return title || undefined;
}

function firstLineTitle(text: string): string | undefined {
  const line = text.split("\n")[0]?.replace(/[#*`]/g, "").trim() ?? "";
  return line.slice(0, 24) || undefined;
}
