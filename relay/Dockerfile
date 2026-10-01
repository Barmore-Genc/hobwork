FROM rust:1-slim-bookworm AS build
WORKDIR /src
COPY . .
RUN cargo build --release --locked

FROM debian:bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --system --uid 10001 --home-dir /data relay \
  && mkdir /data && chown relay /data
COPY --from=build /src/target/release/hobwork-relay /usr/local/bin/hobwork-relay
USER relay
ENV HOBWORK_RELAY_DB=/data/relay.db
VOLUME /data
EXPOSE 8080
CMD ["hobwork-relay"]
