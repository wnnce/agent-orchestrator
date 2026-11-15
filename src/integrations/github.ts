export interface PullRequest {
  number: number;
  title: string;
  body: string;
  url: string;
  state: string;
  updatedAt?: string;
}
export class GitHubClient {
  constructor(
    private readonly baseUrl = "https://api.github.com",
    private readonly token?: string,
  ) {}
  async listPullRequests(
    owner: string,
    repo: string,
    state = "open",
    limit = 50,
  ): Promise<PullRequest[]> {
    const url = new URL(
      `${this.baseUrl.replace(/\/$/, "")}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`,
    );
    url.searchParams.set("state", state);
    url.searchParams.set("per_page", String(limit));
    const response = await fetch(url, {
      headers: {
        accept: "application/vnd.github+json",
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
      },
    });
    if (!response.ok) throw new Error(`GitHub pull request query failed: ${response.status}`);
    const data = (await response.json()) as any[];
    return data.map((item) => {
      const updatedAt = item.updated_at ? String(item.updated_at) : undefined;
      return {
        number: Number(item.number),
        title: String(item.title),
        body: String(item.body ?? ""),
        url: String(item.html_url),
        state: String(item.state),
        ...(updatedAt ? { updatedAt } : {}),
      };
    });
  }
}
