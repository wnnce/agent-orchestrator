export interface OAuthToken {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  tokenType?: string;
}
export interface OAuthConfig {
  authorizationUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
  scopes: string[];
}
export class OAuthClient {
  constructor(private readonly config: OAuthConfig) {}
  authorizationUrl(state: string, codeChallenge?: string): string {
    const url = new URL(this.config.authorizationUrl);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", this.config.clientId);
    url.searchParams.set("redirect_uri", this.config.redirectUri);
    url.searchParams.set("scope", this.config.scopes.join(" "));
    url.searchParams.set("state", state);
    if (codeChallenge) {
      url.searchParams.set("code_challenge", codeChallenge);
      url.searchParams.set("code_challenge_method", "S256");
    }
    return url.toString();
  }
  async exchangeCode(code: string, verifier?: string): Promise<OAuthToken> {
    return this.tokenRequest({
      grant_type: "authorization_code",
      code,
      redirect_uri: this.config.redirectUri,
      ...(verifier ? { code_verifier: verifier } : {}),
    });
  }
  async refresh(refreshToken: string): Promise<OAuthToken> {
    return this.tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken });
  }
  private async tokenRequest(payload: Record<string, string>): Promise<OAuthToken> {
    const auth = Buffer.from(`${this.config.clientId}:${this.config.clientSecret ?? ""}`).toString(
      "base64",
    );
    const response = await fetch(this.config.tokenUrl, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: `Basic ${auth}`,
      },
      body: new URLSearchParams(payload),
    });
    if (!response.ok) throw new Error(`OAuth token request failed: ${response.status}`);
    const data = (await response.json()) as any;
    const token: OAuthToken = { accessToken: String(data.access_token) };
    if (data.refresh_token) token.refreshToken = String(data.refresh_token);
    if (data.expires_in) token.expiresAt = Date.now() + Number(data.expires_in) * 1000;
    if (data.token_type) token.tokenType = String(data.token_type);
    return token;
  }
}
