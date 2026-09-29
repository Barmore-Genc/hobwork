# Home Assistant test instance

Local HA in Docker for developing and testing the Home Assistant integration. No hardware needed.

```
node dev/homeassistant/setup.ts          # start, onboard, write .env.local (idempotent)
node dev/homeassistant/smoke.ts          # end-to-end check over the WebSocket API
node dev/homeassistant/setup.ts down     # stop, keep state
node dev/homeassistant/setup.ts reset    # stop and wipe state and token
```

- URL: `http://localhost:18123` (login `hobwork` / `hobwork-dev-password`).
- Tests read `HOBWORK_HA_URL` and `HOBWORK_HA_TOKEN` from the environment, or from the gitignored `.env.local` written by `setup.ts`.
- The host's integration tests against this instance are skipped unless `HOBWORK_HA_TESTS=1` is set:

  ```
  HOBWORK_HA_TESTS=1 pnpm --filter @hobwork/server test src/homeassistant
  ```

- To connect a local host to it, enter the URL and token from `.env.local` on the web UI's Settings page, or start the host with them in its environment (`HOBWORK_HA_URL`, `HOBWORK_HA_TOKEN`), which wins over the Settings page.
- `HOBWORK_HA_TESTS=1 pnpm --filter @hobwork/server test src/api/homeassistant-settings` saves it through the settings API.
- Config is `configuration.yaml` (committed, mounted read-only). HA state lives in `data/` (gitignored).

## Available entities

- `input_boolean.test_switch`, `input_button.test_button`, `input_number.test_number`, `sensor.test_doubled` (template).
- Pressing `input_button.test_button` fires the bus event `hobwork_test_event` with data `{"source": "test_button"}`.
- `demo` and `kitchen_sink` integrations provide about 76 virtual devices, about 47 of them with device triggers (for example `button` `pressed`). List them with `config/device_registry/list` and `device_automation/trigger/list`.
