import { test, expect } from "bun:test";
import { EncryptedTokenStore } from "../src/integrations/token-store.ts";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";

test("encrypted OAuth token store round-trips tokens", async () => {
  const root = await mkdtemp("/tmp/oauth-store-");
  const key = Buffer.alloc(32, 7).toString("base64");
  const store = new EncryptedTokenStore(path.join(root, "tokens.json"), key);
  await store.set("github", { accessToken: "secret", refreshToken: "refresh", expiresAt: 123 });
  expect(await store.get("github")).toEqual({
    accessToken: "secret",
    refreshToken: "refresh",
    expiresAt: 123,
  });
  await rm(root, { recursive: true, force: true });
});
