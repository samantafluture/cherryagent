import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";

interface FitbitTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

const DEFAULT_TOKEN_PATH = join(
  process.env.HOME ?? ".",
  ".cherryagent",
  "fitbit-tokens.json",
);

export class FitbitAuth {
  private clientId: string;
  private clientSecret: string;
  private redirectUri: string;
  private tokenPath: string;
  private tokens: FitbitTokens | null = null;

  constructor(config: {
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    tokenPath?: string;
  }) {
    this.clientId = config.clientId;
    this.clientSecret = config.clientSecret;
    this.redirectUri = config.redirectUri;
    this.tokenPath = config.tokenPath ?? DEFAULT_TOKEN_PATH;
  }

  getAuthUrl(): string {
    const params = new URLSearchParams({
      response_type: "code",
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      scope: "nutrition",
      expires_in: "604800",
    });
    return `https://www.fitbit.com/oauth2/authorize?${params.toString()}`;
  }

  async exchangeCode(code: string): Promise<void> {
    const res = await fetch("https://api.fitbit.com/oauth2/token", {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: this.redirectUri,
      }).toString(),
    });

    if (!res.ok) {
      const error = await res.text();
      throw new Error(`Fitbit token exchange failed (${res.status}): ${error}`);
    }

    const data = (await res.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
    };

    this.tokens = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: Date.now() + data.expires_in * 1000,
    };

    await this.persistTokens();
  }

  async getAccessToken(): Promise<string> {
    if (!this.tokens) {
      await this.loadTokens();
    }
    if (!this.tokens) {
      throw new Error(
        "Fitbit not authorized. Run /fitbit_auth to connect.",
      );
    }

    // Refresh if expired or expiring within 5 minutes
    if (Date.now() > this.tokens.expiresAt - 300_000) {
      await this.refreshTokens();
    }

    return this.tokens.accessToken;
  }

  isAuthorized(): boolean {
    return this.tokens !== null;
  }

  private async refreshTokens(): Promise<void> {
    if (!this.tokens) throw new Error("No tokens to refresh");

    const res = await fetch("https://api.fitbit.com/oauth2/token", {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: this.tokens.refreshToken,
      }).toString(),
    });

    if (!res.ok) {
      const error = await res.text();
      throw new Error(`Fitbit token refresh failed (${res.status}): ${error}`);
    }

    const data = (await res.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
    };

    this.tokens = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: Date.now() + data.expires_in * 1000,
    };

    await this.persistTokens();
  }

  private async persistTokens(): Promise<void> {
    if (!this.tokens) return;
    await mkdir(dirname(this.tokenPath), { recursive: true });
    await writeFile(
      this.tokenPath,
      JSON.stringify(this.tokens, null, 2),
      "utf-8",
    );
  }

  private async loadTokens(): Promise<void> {
    try {
      const raw = await readFile(this.tokenPath, "utf-8");
      this.tokens = JSON.parse(raw) as FitbitTokens;
    } catch {
      // No saved tokens — user needs to authorize
      this.tokens = null;
    }
  }
}
