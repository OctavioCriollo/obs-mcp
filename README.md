# OBS MCP Server — Lazy Connect + Auto-Launch Fork

> **Fork of [zeke/obs-mcp](https://github.com/zeke/obs-mcp)** with two operational improvements that make the MCP usable without having OBS already running.

An MCP server for OBS Studio that provides tools to control OBS via the OBS WebSocket protocol.

## What this fork adds (vs upstream)

The upstream `obs-mcp` connects to OBS WebSocket eagerly at startup. If OBS is not running, the process crashes with `WebSocket error` and the MCP shows as `failed` in Claude Desktop / Claude Code. This fork fixes that:

1. **Lazy connect.** The MCP loads cleanly even when OBS Studio is closed. The WebSocket connection happens automatically the first time a tool is invoked.
2. **`obs-launch` tool.** Inspired by TradingView MCP's `tv_launch`: auto-detects the OBS executable on Windows / macOS / Linux, spawns it detached, waits for the WebSocket port to open, then connects. You can ask the LLM "launch OBS" and the MCP handles everything.
3. **`obs-health-check` tool.** Non-throwing state report (process running? port open? identified?) — safe to call any time.
4. **`obs-close` tool.** Disconnect the MCP client without killing OBS itself.

The 120+ original tools are unchanged and now also work on-demand (auto-connect via `client.ensureConnected()`).

### Configuration with this fork

```json
{
  "mcpServers": {
    "obs": {
      "command": "npx",
      "args": ["-y", "github:OctavioCriollo/obs-mcp"],
      "env": {
        "OBS_WEBSOCKET_PASSWORD": "<password_from_obs>"
      }
    }
  }
}
```

The compiled `build/` folder is tracked in git so `npx github:` runs the prebuilt JavaScript without needing a TypeScript compile step on the consumer's machine.

---

## Upstream documentation (unchanged)


## Features

- Connect to OBS WebSocket server
- Control OBS via MCP tools
- Provides tools for:
  - General operations
  - Scene management
  - Source control
  - Scene item manipulation
  - Streaming and recording
  - Transitions


## Usage

1. Make sure OBS Studio is running with WebSocket server enabled (Tools > WebSocket Server Settings). Note the password for the WS.
2. Set the WebSocket password in environment variable (if needed):

```bash
export OBS_WEBSOCKET_PASSWORD="your_password_here"
```

3. Add the MCP server to Claude desktop with the MCP server settings:

```json
{
  "mcpServers": {
    "obs": {
      "command": "npx",
      "args": ["-y", "obs-mcp@latest"],
      "env": {
        "OBS_WEBSOCKET_PASSWORD": "<password_from_obs>"
      }
    }
  }
}
```

4. Use Claude to control your OBS!

## Development

If you want to run the server locally using the code in this git repo, you can do the following:


```bash
npm run build
npm run start
```

Then configure Claude desktop:

```json
{
  "mcpServers": {
    "obs": {
      "command": "node",
      "args": [
        "<obs-mcp_root>/build/index.js"
      ],
      "env": {
        "OBS_WEBSOCKET_PASSWORD": "<password_from_obs>"
      }
    }
  }
}
```

## Available Tools

The server provides tools organized by category:

- **Lifecycle tools (added in this fork):** `obs-launch`, `obs-health-check`, `obs-close`
- General tools: Version info, stats, hotkeys, studio mode
- Scene tools: List scenes, switch scenes, create/remove scenes
- Source tools: Manage sources, settings, audio levels, mute/unmute
- Scene item tools: Manage items in scenes (position, visibility, etc.)
- Streaming tools: Start/stop streaming, recording, virtual camera
- Transition tools: Set transitions, durations, trigger transitions

## Environment Variables

- `OBS_WEBSOCKET_URL`: WebSocket URL (default: ws://localhost:4455)
- `OBS_WEBSOCKET_PASSWORD`: Password for authenticating with OBS WebSocket (if required)

## Requirements

- Node.js 16+
- OBS Studio 31+ with WebSocket server enabled
- Claude desktop

## Related Projects

- [obsx](https://github.com/zeke/obsx) - A Python library and CLI for controlling OBS Studio with LLMs.

## License

See the [LICENSE](LICENSE) file for details.