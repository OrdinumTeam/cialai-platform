# SPDX-License-Identifier: Apache-2.0
# Imagem comum dos roteadores e das pontas do laboratório de NAT. Os binários
# Go (cialai-tunnel e netlab-node) não entram na imagem: chegam montados em
# /opt/netlab, compilados para linux pelo teste com a tag netlab.
FROM alpine:3.22@sha256:14358309a308569c32bdc37e2e0e9694be33a9d99e68afb0f5ff33cc1f695dce

RUN apk add --no-cache iptables iproute2 conntrack-tools procps

COPY node/netlab-router node/netlab-endpoint /usr/local/bin/
RUN chmod 0755 /usr/local/bin/netlab-router /usr/local/bin/netlab-endpoint
