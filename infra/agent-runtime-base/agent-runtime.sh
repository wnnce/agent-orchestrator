#!/usr/bin/env bash
set -Eeuo pipefail

mode="${1:-run}"

case "${mode}" in
  run)
    shift

    if [[ "${AGENT_RUNTIME_SKIP_CHECKS:-false}" != "true" ]]; then
      required=(go python node bun uv git ssh rg jq curl task tman)
      missing=()
      for command_name in "${required[@]}"; do
        if ! command -v "${command_name}" >/dev/null 2>&1; then
          missing+=("${command_name}")
        fi
      done
      if ((${#missing[@]} > 0)); then
        printf 'agent-runtime-base: missing commands: %s\n' "${missing[*]}" >&2
        exit 127
      fi
    fi

    dirs=(/workspace /app)
    [[ -n "${CODEX_HOME:-}" ]] && dirs+=("${CODEX_HOME}")
    mkdir -p "${dirs[@]}" 2>/dev/null || true

    if (($# == 0)); then
      set -- bash
    fi
    exec "$@"
    ;;
  install)
    shift
    ;;
  *)
    printf 'usage: %s install | run [command [args...]]\n' "$0" >&2
    exit 2
    ;;
esac

: "${TARGETARCH:=amd64}"
: "${GO_VERSION:?GO_VERSION is required}"
: "${NODE_VERSION:?NODE_VERSION is required}"
: "${UV_VERSION:?UV_VERSION is required}"
: "${BUN_VERSION:?BUN_VERSION is required}"
: "${TASK_VERSION:?TASK_VERSION is required}"
: "${TMAN_VERSION:?TMAN_VERSION is required}"

export DEBIAN_FRONTEND=noninteractive

# Keep the Dockerfile declarative: all image initialization belongs in this
# script, including the entrypoint permissions and temporary-file cleanup.
chmod 0755 /usr/local/bin/agent-runtime

case "${TARGETARCH}" in
  amd64)
    go_arch=amd64
    node_arch=x64
    uv_arch=x86_64-unknown-linux-gnu
    bun_arch=x64
    task_arch=amd64
    tman_arch=x64
    ;;
  arm64)
    go_arch=arm64
    node_arch=arm64
    uv_arch=aarch64-unknown-linux-gnu
    bun_arch=aarch64
    task_arch=arm64
    tman_arch=arm64
    ;;
  *)
    echo "unsupported architecture: ${TARGETARCH}" >&2
    exit 1
    ;;
esac

apt-get update
apt-get install --no-install-recommends -y \
  bash \
  bzip2 \
  build-essential \
  ca-certificates \
  curl \
  file \
  findutils \
  git \
  git-lfs \
  gzip \
  jq \
  less \
  locales \
  openssh-client \
  pkg-config \
  procps \
  psmisc \
  python-is-python3 \
  python3 \
  python3-dev \
  python3-pip \
  python3-venv \
  ripgrep \
  tar \
  tini \
  tree \
  unzip \
  wget \
  xz-utils \
  zip \
  zstd

sed -i -e 's/^# \(en_US.UTF-8 UTF-8\)/\1/' -e 's/^# \(zh_CN.UTF-8 UTF-8\)/\1/' /etc/locale.gen
locale-gen

curl --fail --location --silent --show-error \
  "https://go.dev/dl/go${GO_VERSION}.linux-${go_arch}.tar.gz" \
  -o /tmp/go.tgz
tar -xzf /tmp/go.tgz -C /usr/local

curl --fail --location --silent --show-error \
  "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${node_arch}.tar.xz" \
  -o /tmp/node.tar.xz
mkdir -p /opt/node
tar -xJf /tmp/node.tar.xz -C /opt/node --strip-components=1

curl --fail --location --silent --show-error \
  "https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-${uv_arch}.tar.gz" \
  -o /tmp/uv.tgz
mkdir -p /tmp/uv
tar -xzf /tmp/uv.tgz -C /tmp/uv --strip-components=1
install -m 0755 /tmp/uv/uv /usr/local/bin/uv
install -m 0755 /tmp/uv/uvx /usr/local/bin/uvx

curl --fail --location --silent --show-error \
  "https://github.com/go-task/task/releases/download/v${TASK_VERSION}/task_linux_${task_arch}.tar.gz" \
  -o /tmp/task.tgz
mkdir -p /tmp/task
tar -xzf /tmp/task.tgz -C /tmp/task
install -m 0755 /tmp/task/task /usr/local/bin/task

curl --fail --location --silent --show-error \
  "https://github.com/TEN-framework/ten-framework/releases/download/${TMAN_VERSION}/tman-linux-release-${tman_arch}.zip" \
  -o /tmp/tman.zip
mkdir -p /tmp/tman
unzip -q /tmp/tman.zip -d /tmp/tman
install -m 0755 /tmp/tman/ten_manager/bin/tman /usr/local/bin/tman

curl --fail --location --silent --show-error \
  "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-${bun_arch}.zip" \
  -o /tmp/bun.zip
mkdir -p /tmp/bun
unzip -q /tmp/bun.zip -d /tmp/bun
install -m 0755 "/tmp/bun/bun-linux-${bun_arch}/bun" /usr/local/bin/bun

git config --system --add safe.directory '*'
git lfs install --system

cat > /etc/profile.d/agent-runtime-path.sh <<'EOF'
export PATH="/usr/local/bin:/opt/node/bin:/usr/local/go/bin:${HOME}/.local/bin:${PATH}"
export BUN_INSTALL=/usr/local
EOF
chmod 0644 /etc/profile.d/agent-runtime-path.sh

useradd --create-home --uid 10001 --shell /bin/bash agent
mkdir -p /app /workspace
chown -R agent:agent /app /workspace /home/agent

rm -rf \
  /tmp/go.tgz \
  /tmp/node.tar.xz \
  /tmp/uv.tgz \
  /tmp/uv \
  /tmp/bun.zip \
  /tmp/bun \
  /tmp/task.tgz \
  /tmp/task \
  /tmp/tman.zip \
  /tmp/tman \
  /var/lib/apt/lists/*
