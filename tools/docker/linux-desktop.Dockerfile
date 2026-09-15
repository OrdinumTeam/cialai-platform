# SPDX-License-Identifier: Apache-2.0
FROM ubuntu:22.04

ARG TARGETARCH
ENV DEBIAN_FRONTEND=noninteractive
ENV PATH=/root/.cargo/bin:/usr/local/bin:/usr/bin:/bin

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      build-essential \
      ca-certificates \
      curl \
      libayatana-appindicator3-dev \
      libdbus-1-dev \
      libgtk-3-dev \
      librsvg2-dev \
      libssl-dev \
      libwebkit2gtk-4.1-dev \
      patchelf \
      pkg-config \
      xdg-utils \
      xz-utils \
    && rm -rf /var/lib/apt/lists/*

RUN case "$TARGETARCH" in \
      amd64) node_arch=x64 ;; \
      arm64) node_arch=arm64 ;; \
      *) echo "Unsupported Docker architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac \
    && curl -fsSLo /tmp/node.tar.xz "https://nodejs.org/dist/v22.23.2/node-v22.23.2-linux-${node_arch}.tar.xz" \
    && tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 \
    && rm /tmp/node.tar.xz \
    && node --version \
    && npm --version

RUN curl --proto '=https' --tlsv1.2 -fsSL https://sh.rustup.rs \
      | sh -s -- -y --profile minimal --default-toolchain 1.98.1 \
    && rustc --version \
    && cargo --version

WORKDIR /workspace
