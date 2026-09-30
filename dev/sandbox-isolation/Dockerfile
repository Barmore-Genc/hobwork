FROM node:24-trixie-slim

RUN case "$(uname -m)" in aarch64) qemu=qemu-system-arm ;; *) qemu=qemu-system-x86 ;; esac \
  && apt-get update \
  && apt-get install -y --no-install-recommends "$qemu" ipxe-qemu qemu-utils bubblewrap git openssh-client ca-certificates procps \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable \
  && mkdir -p /home/node/.pnpm-store \
  && chown node:node /home/node/.pnpm-store

ENV COREPACK_HOME=/home/node/.pnpm-store/corepack
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
USER node
WORKDIR /home/node
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["bash"]
