# TODO

## Warm VM pool

Keep one booted spare VM per kind (runtime, workspace, pipeline) so a cold start takes an exec instead of a boot. Boot is about 0.7s on `colossus` and 0.5s on the Mac; a running VM answers a command in a few ms. Each spare costs about 175MB of host RSS. The spare has to be configured for the project after boot (mounts, env, egress allowlist, secrets), so the `Sandbox` interface needs a way to apply these to a running VM, or the pool holds VMs per project that is likely to start soon.

Other boot costs left, smaller and with more upkeep: a custom `rootfsInit` in the image (no debug output, parallel `modprobe`, no `update-ca-certificates` at boot), about 100-200ms; a custom kernel with the virtio and fuse drivers built in.

## Connect agents over OAuth from the Agent access page

The Agent access page (`web/src/pages/Agents.tsx`) leads with "Give an agent access", which creates a static key and offers a `claude mcp add ... --header "Authorization: Bearer <key>"` command. The intro mentions signing in "when you connect them from the app", but the page never says how. OAuth is the easier path and should come first: show the MCP URL (`<public URL>/mcp`) with a copy button, and short steps for claude.ai/Claude Desktop (Settings > Connectors > Add custom connector, OAuth fields left empty) and Claude Code (`claude mcp add --transport http hobwork <url>`, then `claude mcp login hobwork`). Keep static keys as the option for clients without OAuth.
