# SPDX-License-Identifier: Apache-2.0
# Imagem comum dos roteadores e das pontas do laboratório de NAT. Os binários
# Go (cialai-tunnel e netlab-node) não entram na imagem: chegam montados em
# /opt/netlab, compilados para linux pelo teste com a tag netlab.
FROM alpine:3.22

RUN apk add --no-cache iptables iproute2 conntrack-tools procps

COPY node/netlab-router node/netlab-endpoint /usr/local/bin/
RUN chmod 0755 /usr/local/bin/netlab-router /usr/local/bin/netlab-endpoint
