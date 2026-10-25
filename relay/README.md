# Hobwork push relay

Sends APNs pushes to the Hobwork app for every Hobwork host. The API and the design are under Push relay in `docs/architecture.md`.

## Development

```sh
cargo test
cargo clippy --all-targets
cargo fmt
```

`cargo test -- --ignored` also sends one request to Apple's sandbox with a made-up key, which checks TLS and HTTP/2 to APNs.

To run it locally you need an APNs key (`.p8`) from the Apple developer account:

```sh
HOBWORK_RELAY_APNS_KEY_FILE=AuthKey_XXXXXXXXXX.p8 HOBWORK_RELAY_APNS_KEY_ID=XXXXXXXXXX cargo run
```

## Docker

CI builds the image and pushes it to `ghcr.io/barmore-genc/hobwork-relay` (`main`, version tags and `sha-<commit>`). To build and run it yourself:

```sh
docker build -t hobwork-relay relay/
docker run -d --name hobwork-relay -p 127.0.0.1:8080:8080 \
  -v hobwork-relay:/data -v /etc/hobwork-relay/AuthKey.p8:/key.p8:ro \
  -e HOBWORK_RELAY_APNS_KEY_FILE=/key.p8 -e HOBWORK_RELAY_APNS_KEY_ID=XXXXXXXXXX \
  -e HOBWORK_RELAY_TRUSTED_PROXIES=172.16.0.0/12 \
  --log-opt max-size=10m --restart unless-stopped hobwork-relay
```

Put a TLS proxy in front of it that sets `X-Forwarded-For`, and list the proxy's address in `HOBWORK_RELAY_TRUSTED_PROXIES`. The database is `/data/relay.db`; losing it means every app registers again on its next launch.
