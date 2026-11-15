FROM debian:13-slim

ARG TARGETARCH
ARG GO_VERSION=1.27.3
ARG NODE_VERSION=24.22.1
ARG UV_VERSION=0.12.8
ARG BUN_VERSION=1.4.4
ARG TASK_VERSION=3.54.0
ARG TMAN_VERSION=0.11.75

COPY agent-runtime.sh /usr/local/bin/agent-runtime

RUN bash /usr/local/bin/agent-runtime install

ENV PATH=/usr/local/bin:/opt/node/bin:/usr/local/go/bin:/home/agent/.local/bin:$PATH \
    LANG=zh_CN.UTF-8 \
    LC_ALL=zh_CN.UTF-8 \
    BUN_INSTALL=/usr/local

WORKDIR /app
VOLUME ["/data", "/workspace"]
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/agent-runtime", "run"]
CMD ["bash"]
