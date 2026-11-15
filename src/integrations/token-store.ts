import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { OAuthToken } from "./oauth.ts";

interface StoredToken {
  iv: string;
  tag: string;
  data: string;
}
export class EncryptedTokenStore {
  private readonly key: Buffer;
  constructor(
    private readonly file: string,
    key: string,
  ) {
    this.key = Buffer.from(key, "base64");
    if (this.key.length !== 32)
      throw new Error("OAuth token encryption key must decode to 32 bytes");
  }
  async get(provider: string): Promise<OAuthToken | null> {
    try {
      const raw = JSON.parse(await readFile(this.file, "utf8")) as Record<string, StoredToken>;
      const stored = raw[provider];
      if (!stored) return null;
      const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(stored.iv, "base64"));
      decipher.setAuthTag(Buffer.from(stored.tag, "base64"));
      return JSON.parse(
        Buffer.concat([
          decipher.update(Buffer.from(stored.data, "base64")),
          decipher.final(),
        ]).toString("utf8"),
      ) as OAuthToken;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
  async set(provider: string, token: OAuthToken): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    let raw: Record<string, StoredToken> = {};
    try {
      raw = JSON.parse(await readFile(this.file, "utf8")) as Record<string, StoredToken>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(token)), cipher.final()]);
    raw[provider] = {
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      data: data.toString("base64"),
    };
    await writeFile(this.file, JSON.stringify(raw), { mode: 0o600 });
    await chmod(this.file, 0o600);
  }
}
