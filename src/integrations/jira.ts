export interface JiraIssue {
  key: string;
  summary: string;
  status?: string;
  url?: string;
}
export class JiraClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token?: string,
  ) {}
  async search(jql: string, limit = 50): Promise<JiraIssue[]> {
    const url = new URL(`${this.baseUrl.replace(/\/$/, "")}/rest/api/2/search`);
    url.searchParams.set("jql", jql);
    url.searchParams.set("maxResults", String(limit));
    const response = await fetch(url, {
      headers: this.token ? { authorization: `Bearer ${this.token}` } : {},
    });
    if (!response.ok) throw new Error(`Jira search failed: ${response.status}`);
    const data = (await response.json()) as any;
    return (data.issues ?? []).map((issue: any) => ({
      key: String(issue.key),
      summary: String(issue.fields?.summary ?? ""),
      status: issue.fields?.status?.name,
      url: `${this.baseUrl.replace(/\/$/, "")}/browse/${issue.key}`,
    }));
  }
}
