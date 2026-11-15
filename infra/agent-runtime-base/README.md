# Agent Runtime Base

Debian slim execution environment for the TypeScript Agent Orchestrator.

It contains:

- Go
- Python and `uv`
- Node.js and Bun
- Git, Git LFS, OpenSSH
- `rg`, `jq`, `curl`, `wget`, `tar`, `unzip`, `tree`, `file`, `less`
- Go Task (`task`)
- TEN Framework Manager (`tman`)
- build and archive utilities

The image uses one script, `agent-runtime.sh`. Docker runs it with the
`install` subcommand while building the image; the container entrypoint runs
the same script with the `run` subcommand to check the tools and start the
requested command.

## Build

```bash
docker buildx build --load \\
  --platform linux/amd64 \\
  --tag agent-orchestrator-runtime-base:local \\
  --file infra/agent-runtime-base/Dockerfile \\
  infra/agent-runtime-base
```

The image uses named volumes for `/data` and `/workspace`. SSH keys and other
credentials must be injected at runtime through Docker/Kubernetes secrets.

## Included versions

| Tool     | Version   |
| -------- | --------- |
| Debian   | `13-slim` |
| Go       | `1.27.3`  |
| Node.js  | `24.22.1` |
| Bun      | `1.4.4`   |
| uv       | `0.12.8`  |
| Go Task  | `3.54.0`  |
| TEN tman | `0.11.75` |

`tman` is installed from the official TEN Framework release asset for the
container architecture. It is not built from the application repository.
