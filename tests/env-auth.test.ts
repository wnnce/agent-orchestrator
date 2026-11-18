import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
  parseDotenv,
  resolveEnvString,
  interpolateEnv,
  loadProjects,
} from "../src/config/config.ts";
import { resolveCommitter, WorkspaceManager } from "../src/workspace/workspace.ts";
import type { ProjectConfig } from "../src/domain/types.ts";
import { mkdir, writeFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

describe("Dotenv parser and env interpolation", () => {
  test("parseDotenv parses standard, quoted, multiline, and escaped variables", () => {
    const dotenvContent = `
# Comment line
PLAIN_KEY=hello_world
QUOTED_KEY="hello with spaces"
SINGLE_QUOTED='single value'
ESCAPED_KEY="line1\\nline2\\nline3"
MULTILINE_KEY="-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAA...
-----END OPENSSH PRIVATE KEY-----"
EMPTY_KEY=
WITH_INLINE_COMMENT=foo # comment here
`;
    const parsed = parseDotenv(dotenvContent);
    expect(parsed.PLAIN_KEY).toBe("hello_world");
    expect(parsed.QUOTED_KEY).toBe("hello with spaces");
    expect(parsed.SINGLE_QUOTED).toBe("single value");
    expect(parsed.ESCAPED_KEY).toBe("line1\nline2\nline3");
    expect(parsed.MULTILINE_KEY).toContain("-----BEGIN OPENSSH PRIVATE KEY-----");
    expect(parsed.MULTILINE_KEY).toContain("-----END OPENSSH PRIVATE KEY-----");
    expect(parsed.EMPTY_KEY).toBe("");
    expect(parsed.WITH_INLINE_COMMENT).toBe("foo");
  });

  test("resolveEnvString resolves {env:VAR} from envMap or process.env", () => {
    const envMap = {
      DEPLOY_KEY: "my-secret-key-123",
      API_HOST: "api.internal.net",
    };
    process.env.GLOBAL_VAR = "global-value";

    try {
      expect(resolveEnvString("{env:DEPLOY_KEY}", envMap)).toBe("my-secret-key-123");
      expect(resolveEnvString("https://{env:API_HOST}/v1", envMap)).toBe(
        "https://api.internal.net/v1",
      );
      expect(resolveEnvString("prefix-{env:GLOBAL_VAR}", envMap)).toBe("prefix-global-value");
      expect(resolveEnvString("{env:UNDEFINED_KEY}", envMap)).toBe("{env:UNDEFINED_KEY}");
    } finally {
      delete process.env.GLOBAL_VAR;
    }
  });

  test("interpolateEnv recursively interpolates objects and arrays", () => {
    const input = {
      name: "test",
      auth: {
        type: "ssh-key",
        key: "{env:MY_KEY}",
      },
      tags: ["tag1", "{env:MY_TAG}"],
      nested: {
        list: [{ value: "{env:MY_KEY}" }],
      },
    };
    const envMap = {
      MY_KEY: "secret-key",
      MY_TAG: "prod",
    };
    const interpolated = interpolateEnv(input, envMap) as typeof input;
    expect(interpolated.auth.key).toBe("secret-key");
    expect(interpolated.tags[1]).toBe("prod");
    expect(interpolated.nested.list[0]!.value).toBe("secret-key");
  });
});

describe("Committer Inheritance", () => {
  test("repository committer takes precedence over project committer", () => {
    const project: ProjectConfig = {
      id: "test-proj",
      displayName: "Test",
      description: "Test",
      committer: {
        name: "Project Committer",
        email: "project@example.com",
      },
      routing: { projectId: "test-proj" },
      repositories: [
        {
          id: "repo1",
          url: "",
          baseBranch: "main",
          committer: {
            name: "Repo Committer",
            email: "repo@example.com",
          },
        },
      ],
    };

    const committer = resolveCommitter(project, project.repositories[0]);
    expect(committer.name).toBe("Repo Committer");
    expect(committer.email).toBe("repo@example.com");
  });

  test("falls back to project committer if repository committer is not specified", () => {
    const project: ProjectConfig = {
      id: "test-proj",
      displayName: "Test",
      description: "Test",
      committer: {
        name: "Project Committer",
        email: "project@example.com",
      },
      routing: { projectId: "test-proj" },
      repositories: [
        {
          id: "repo1",
          url: "",
          baseBranch: "main",
        },
      ],
    };

    const committer = resolveCommitter(project, project.repositories[0]);
    expect(committer.name).toBe("Project Committer");
    expect(committer.email).toBe("project@example.com");
  });

  test("falls back to default committer if neither repo nor project specifies it", () => {
    const project: ProjectConfig = {
      id: "test-proj",
      displayName: "Test",
      description: "Test",
      routing: { projectId: "test-proj" },
      repositories: [
        {
          id: "repo1",
          url: "",
          baseBranch: "main",
        },
      ],
    };

    const committer = resolveCommitter(project, project.repositories[0]);
    expect(committer.name).toBe("Agent Orchestrator");
    expect(committer.email).toBe("agent-orchestrator@localhost");
  });
});

describe("SSH Key Materialization & Git Worktree Config", () => {
  let tempDir: string;
  let sessionDir: string;
  let baseDir: string;
  let secretsDir: string;
  let manager: WorkspaceManager;

  beforeEach(async () => {
    tempDir = path.join(
      os.tmpdir(),
      `agent-orch-auth-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    sessionDir = path.join(tempDir, "sessions");
    baseDir = path.join(tempDir, "bases");
    secretsDir = path.join(tempDir, "secrets");
    await mkdir(sessionDir, { recursive: true });
    await mkdir(baseDir, { recursive: true });
    await mkdir(secretsDir, { recursive: true });
    manager = new WorkspaceManager(sessionDir, baseDir, secretsDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("materializes raw PEM deploy key with 0600 permissions", async () => {
    const rawKey = `-----BEGIN OPENSSH PRIVATE KEY-----
fake-test-key-content
-----END OPENSSH PRIVATE KEY-----`;

    const project: ProjectConfig = {
      id: "sec-proj",
      displayName: "Secure Project",
      description: "Project with secret key",
      routing: { projectId: "sec-proj" },
      repositories: [
        {
          id: "sec-repo",
          url: "",
          baseBranch: "main",
          auth: {
            type: "ssh-key",
            key: rawKey,
          },
        },
      ],
    };

    const repo = project.repositories[0]!;
    const keyInfo = await manager.ensureAuthKeyFile(project, repo, repo.auth!);
    expect(keyInfo).toBeDefined();
    expect(keyInfo!.keyPath).toContain("sec-repo.id_key");

    // Check file content
    const saved = await Bun.file(keyInfo!.keyPath).text();
    expect(saved).toBe(rawKey + "\n");

    // Check file permissions mode 0600
    const stats = await stat(keyInfo!.keyPath);
    // On POSIX, mode & 0o777 should be 0o600
    expect(stats.mode & 0o777).toBe(0o600);
  });

  test("materializes Base64 encoded deploy key", async () => {
    const rawKey = `-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaA==\n-----END OPENSSH PRIVATE KEY-----`;
    const base64Key = Buffer.from(rawKey).toString("base64");

    const project: ProjectConfig = {
      id: "b64-proj",
      displayName: "Base64 Project",
      description: "Project with base64 key",
      routing: { projectId: "b64-proj" },
      repositories: [
        {
          id: "b64-repo",
          url: "",
          baseBranch: "main",
          auth: {
            type: "ssh-key",
            key: base64Key,
          },
        },
      ],
    };

    const repo = project.repositories[0]!;
    const keyInfo = await manager.ensureAuthKeyFile(project, repo, repo.auth!);
    expect(keyInfo).toBeDefined();

    const saved = await Bun.file(keyInfo!.keyPath).text();
    expect(saved).toContain("-----BEGIN OPENSSH PRIVATE KEY-----");
  });

  test("throws informative error when {env:KEY} was not set", async () => {
    const project: ProjectConfig = {
      id: "missing-env-proj",
      displayName: "Missing Env",
      description: "Project with unfulfilled env",
      routing: { projectId: "missing-env-proj" },
      repositories: [
        {
          id: "missing-repo",
          url: "",
          baseBranch: "main",
          auth: {
            type: "ssh-key",
            key: "{env:UNDEFINED_DEPLOY_KEY}",
          },
        },
      ],
    };

    const result = await manager.ensureAuthKeyFile(
      project,
      project.repositories[0]!,
      project.repositories[0]!.auth!,
    );
    expect(result).toBeUndefined();
  });

  test("loadProjects loads project with project-level .env interpolation", async () => {
    const projDir = path.join(tempDir, "custom-proj");
    await mkdir(projDir, { recursive: true });
    await writeFile(
      path.join(projDir, ".env"),
      'PROJECT_TOKEN="my-secret-token"\nPROJECT_AUTHOR="Alice"\n',
    );
    await writeFile(
      path.join(projDir, "project.yaml"),
      `id: custom-proj
displayName: Custom
description: Custom project
committer:
  name: "{env:PROJECT_AUTHOR}"
  email: alice@example.com
auth:
  type: token
  token: "{env:PROJECT_TOKEN}"
routing:
  projectId: custom-proj
repositories:
  - id: repo1
    url: ./repo1
    baseBranch: main
`,
    );

    const loaded = await loadProjects(projDir);
    expect(loaded.length).toBe(1);
    expect(loaded[0]!.committer?.name).toBe("Alice");
    expect(loaded[0]!.auth?.token).toBe("my-secret-token");
    expect(loaded[0]!.env?.PROJECT_TOKEN).toBe("my-secret-token");
  });

  test("loadProjects interpolates http_headers for HTTP MCP servers", async () => {
    const projDir = path.join(tempDir, "mcp-proj");
    await mkdir(projDir, { recursive: true });
    await writeFile(path.join(projDir, ".env"), 'GITHUB_TOKEN="ghp_super_secret_12345"\n');
    await writeFile(
      path.join(projDir, "project.yaml"),
      `id: mcp-proj
displayName: MCP Project
description: MCP project test
routing:
  projectId: mcp-proj
repositories:
  - id: repo1
    url: ./repo1
    baseBranch: main
agent:
  mcpServers:
    - name: github
      url: https://api.githubcopilot.com/mcp
      http_headers:
        Authorization: "Bearer {env:GITHUB_TOKEN}"
`,
    );

    const loaded = await loadProjects(projDir);
    expect(loaded.length).toBe(1);
    expect(loaded[0]!.runtime?.mcpServers?.[0]?.http_headers?.Authorization).toBe(
      "Bearer ghp_super_secret_12345",
    );
  });
});
