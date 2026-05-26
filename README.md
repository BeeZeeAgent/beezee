<img src="frontend/public/beezee-logo.svg" alt="BeeZee" width="80" />

# BeeZee

BeeZee is an agent orchestrator, observability and convenience tool. I tried to scratch my own itch(es), maybe it will be useful for You, too. :) It runs a local web server, detects available coding agents such as Claude Code and Codex, and gives you one place to launch, resume, and monitor sessions.

## Who is it for?

The target audience are mainly developers and small white collar teams who manage multiple agentic machines, work remotely and would like some clarity and convenience around agentic interactions.

## Why?

I use multiple harnesses in parallel, often on the same project. I also practice "movibe coding" (sorry) by exposing my dev machine through Tailscale and continuing work from a phone or another device. A few things are still frustrating in that workflow:

1. Devices usually need to be on the same private network before they can reach a dev node.
2. Harnesses do not see each other's sessions, so continuing a CC thread in Codex is not ergonomic.
3. Token consumption is opaque. I want to see how much tokens have been spent on what and later analyse and optimise usage.
4. Starting a remote session from mobile usually means navigating folders and SSHing manually.
5. MCP servers and other tools can clutter context unless they are managed deliberately.

BeeZee focuses on the local orchestration side: folders, sessions, remote terminals, harness launchers, and usage visibility. For access from arbitrary devices without joining your private network, use the BeeZee Cloud Relay at `https://app.beezyai.net`. Disclaimer: it's a paywalled service, you can decide if it worths the few bucks. 

## Vision
My goal eventually is to build an ecosystem that supports individuals and small businesses to unlock the full potential of the agentic arsenal with keeping their token consumption at bay, which in the current frenzy is kind skimmed over. And I'm convinced that at least a subset of tasks could be achieved with 50-80% less tokens without quality issues.

## Install

Download the latest release for your platform from:

https://github.com/BeeZeeAgent/beezee/releases/latest

On macOS and Linux, make the downloaded binary executable and run it:

```bash
chmod +x ./beezee-linux-x64
./beezee-linux-x64
```

On Windows, download `beezee-windows-x64.zip`, extract it, and run `beezee-windows-x64.exe`.

BeeZee listens on port `4242` by default:

```text
http://localhost:4242
```

You can override the port with:

```bash
PORT=4243 ./beezee-linux-x64
```

For local development from this repository:

```bash
npm install
bun install
npm run build:frontend
bun server.js
```

## Remote Access With Tailscale

Tailscale is the simplest self-managed option when every device that needs access can join your tailnet.

1. Install Tailscale on the machine running BeeZee.
2. Install Tailscale on the phone, tablet, laptop, or whatever you want to use remotely.
3. Sign in to the same tailnet on every device.
4. Start BeeZee on the dev machine.
5. Find the dev machine's Tailscale address:

```bash
tailscale ip -4
```

6. Open BeeZee from another device on the tailnet:

```text
http://<tailscale-ip>:4242
```

You can also use the machine's MagicDNS name if MagicDNS is enabled:

```text
http://<machine-name>.<tailnet-name>.ts.net:4242
```

This keeps traffic inside your private Tailscale network. It is free for personal setups and gives you full control, but every device must be joined to the tailnet.

## Remote Access With BeeZee Cloud Relay

Use the BeeZee Cloud Relay when you want to access a local BeeZee node from a browser without putting that browser/device on your Tailscale network.

1. Start BeeZee locally and keep it running.
2. Open `https://app.beezyai.net`.
3. Sign in and create or open your workspace.
4. Click **Add instance**.
5. Follow the pairing link or copy the pairing URL into the browser where local BeeZee is open.
6. Confirm the pairing dialog in the local BeeZee app.
7. Dance!

After pairing, BeeZee stores the relay configuration locally in:

```text
~/.launchpad-relay.json
```

The same values can also be supplied with environment variables:

```bash
BEEZEE_RELAY_URL=https://app.beezyai.net \
BEEZEE_RELAY_NODE_ID=<node-id> \
BEEZEE_RELAY_TOKEN=<node-token> \
./beezee-linux-x64
```

When the node is online, it appears in the relay dashboard. From there you can open the instance, create remote agent sessions, invite members, and control which nodes each member can access.

Use Tailscale when you want private-network access and control. Use the BeeZee Cloud Relay when you need browser access from arbitrary devices with team sharing and node-level permissions.

## How It Works

BeeZee scans your local machine and exposes your folder structure through a web UI. It finds available coding harnesses and syncs their sessions so each harness can be used for the same work without manually rebuilding context.

Claude Code supports native remote mode, and Codex supports native remote mode on macOS. BeeZee tries those native paths first and falls back to a PTY-based browser terminal when needed.

BeeZee also applies practical optimizations around tool calls (ok not yet exactly... I use [https://github.com/rtk-ai/rtk] ATM which shall be separately installed), such as trimming very long tool outputs and prefetching relevant metadata for files and folders. The goal is to reduce wasted round trips and make agent sessions easier to observe.

## Updating

BeeZee checks GitHub releases for newer versions. Starting with version `0.4.1`, the local app shows an update banner when a newer release is available.

Versions before `0.4.1` cannot show the banner, so update once manually from the GitHub releases page if you are on an older build.

## Other disclaimers
As you can see this is a brand new repo and most of the code was written by Claude Code and Codex - that's why I created this tool. However I've been working on similar projects for a while, so it's not like Athene who just jumped out of her daddy's head. I'm aware that there are literally dozens of similar attempts on the internet. I've even tried a few. Yet, I wasn't fully satisified with any of them. So here we are. 

Again it's a fresh project so excpect a higher density of bugs. I started to work on a comprehensive test suite, but since my budget and therefore my token limits are narrower I'm focusing on delivering those features that I deem essential first. 

