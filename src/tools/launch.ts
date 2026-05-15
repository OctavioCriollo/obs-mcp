import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { OBSWebSocketClient } from "../client.js";
import { z } from "zod";
import { spawn, ChildProcess, execSync } from "child_process";
import { existsSync } from "fs";
import * as net from "net";
import * as path from "path";

/**
 * Launch/health/close tools that allow the user to manage the OBS Studio
 * process itself from the MCP, similar to TradingView's tv_launch.
 *
 * Design goals:
 *  - obs-launch: auto-detect the OBS executable on Windows/macOS/Linux,
 *    spawn it detached, wait for the WebSocket port to open, then connect.
 *  - obs-health-check: report current state without throwing (safe to call
 *    even when OBS is not running).
 *  - obs-close: cleanly disconnect the MCP client (does NOT kill OBS itself
 *    by design — closing the user's OBS GUI is too destructive to expose).
 */

let lastLaunchedProcess: ChildProcess | null = null;

/**
 * Search common install locations for the OBS Studio executable.
 * Returns the absolute path of the first match or null.
 */
/**
 * Locate the OBS Studio executable in a portable way.
 *
 * Lookup order (most specific to most generic):
 *   1. `OBS_EXECUTABLE_PATH` env var — explicit user override (for non-standard
 *      installs: Chocolatey, Scoop, MSIX Store, portable, custom drive, etc.).
 *   2. PATH lookup via `where.exe` (Windows) / `which` (Unix) — works if OBS
 *      is on PATH regardless of where it lives.
 *   3. Standard install locations per OS — covers the official installer.
 *      Uses environment variables (e.g. `%ProgramFiles%`) so it adapts to
 *      Windows in non-English locales (e.g. `C:\Archivos de programa`).
 *
 * Returns the absolute path of the first match, or null if none found.
 */
function findObsExecutable(): string | null {
  // 1. Explicit override
  const override = process.env.OBS_EXECUTABLE_PATH;
  if (override && existsSync(override)) {
    return override;
  }
  if (override && !existsSync(override)) {
    // Override set but invalid — surface a clear error path rather than
    // silently falling back, so the user can fix the typo.
    throw new Error(
      `OBS_EXECUTABLE_PATH is set to "${override}" but no such file exists. ` +
      `Either correct the path or unset the variable to use auto-detection.`
    );
  }

  // 2. PATH lookup
  try {
    const lookupCmd = process.platform === "win32" ? "where obs64" : "which obs";
    const found = execSync(lookupCmd, { encoding: "utf8", windowsHide: true })
      .split(/\r?\n/)
      .map(s => s.trim())
      .find(s => s.length > 0 && existsSync(s));
    if (found) {
      return found;
    }
  } catch {
    // not on PATH — fall through to standard locations
  }

  // 3. Standard install locations per OS
  const candidates: string[] = [];

  if (process.platform === "win32") {
    // Use env vars so this works on localized Windows (e.g. Spanish: "Archivos de programa")
    // Fall back to common English paths only if the env var is missing.
    const programFiles = process.env["ProgramFiles"] || "C:\\Program Files";
    const programFilesX86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
    const localAppData = process.env["LOCALAPPDATA"];
    candidates.push(path.join(programFiles, "obs-studio", "bin", "64bit", "obs64.exe"));
    candidates.push(path.join(programFilesX86, "obs-studio", "bin", "64bit", "obs64.exe"));
    // Scoop default install path
    if (process.env["USERPROFILE"]) {
      candidates.push(
        path.join(process.env["USERPROFILE"]!, "scoop", "apps", "obs-studio", "current", "bin", "64bit", "obs64.exe")
      );
    }
    // Chocolatey default install path
    candidates.push("C:\\ProgramData\\chocolatey\\lib\\obs-studio\\tools\\obs-studio\\bin\\64bit\\obs64.exe");
    // MSIX Store install (the OBS Store package, not the user's TradingView pattern).
    // Path varies by package version, so this is best-effort.
    if (localAppData) {
      // Some MSIX builds expose obs via the user's WindowsApps mirror, but those are
      // sandboxed and typically not runnable as plain executables. Documented for completeness.
    }
  } else if (process.platform === "darwin") {
    candidates.push("/Applications/OBS.app/Contents/MacOS/OBS");
    if (process.env["HOME"]) {
      candidates.push(path.join(process.env["HOME"]!, "Applications", "OBS.app", "Contents", "MacOS", "OBS"));
    }
  } else {
    // Linux: standard package manager locations + Flatpak / Snap.
    candidates.push("/usr/bin/obs", "/usr/local/bin/obs", "/snap/bin/obs");
    // Flatpak typically exposes a wrapper script
    candidates.push("/var/lib/flatpak/exports/bin/com.obsproject.Studio");
    if (process.env["HOME"]) {
      candidates.push(
        path.join(process.env["HOME"]!, ".local", "share", "flatpak", "exports", "bin", "com.obsproject.Studio")
      );
    }
  }

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * Parse OBS_WEBSOCKET_URL (default ws://localhost:4455) into host/port.
 */
function getObsWsHostPort(): { host: string; port: number } {
  const url = process.env.OBS_WEBSOCKET_URL || "ws://localhost:4455";
  const match = url.match(/^wss?:\/\/([^:\/]+)(?::(\d+))?/);
  return {
    host: match?.[1] ?? "localhost",
    port: parseInt(match?.[2] ?? "4455", 10),
  };
}

/**
 * Cross-platform check: is the OBS process currently alive?
 */
function isObsRunning(): boolean {
  try {
    if (process.platform === "win32") {
      const out = execSync('tasklist /FI "IMAGENAME eq obs64.exe" /NH', {
        encoding: "utf8",
        windowsHide: true,
      });
      return out.toLowerCase().includes("obs64.exe");
    }
    // unix-like
    execSync("pgrep -x obs", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Open a TCP connection briefly to verify the WebSocket port is reachable.
 * This does NOT speak the WebSocket protocol — it only checks that something
 * is listening. Used to detect "OBS is ready for handshake".
 */
async function isPortOpen(host: string, port: number, timeoutMs: number = 1000): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = new net.Socket();
    const finish = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    socket.connect(port, host);
  });
}

export async function initialize(server: McpServer, client: OBSWebSocketClient): Promise<void> {
  // ───────────────────────── obs-launch ─────────────────────────
  server.tool(
    "obs-launch",
    "Launch OBS Studio with WebSocket server enabled. Auto-detects the install location on Windows/macOS/Linux, spawns OBS detached, waits up to `wait_seconds` for the WebSocket to become available, then connects the MCP client. If OBS is already running, it just tries to connect. Use this when you want to control OBS from the LLM without manually opening it first.",
    {
      wait_seconds: z
        .number()
        .min(1)
        .max(120)
        .optional()
        .describe("Max seconds to wait for the OBS WebSocket to become ready (default 30)."),
    },
    async ({ wait_seconds }) => {
      const waitMs = (wait_seconds ?? 30) * 1000;
      const { host, port } = getObsWsHostPort();

      // Case 1: OBS already running — just (re)connect.
      if (isObsRunning()) {
        try {
          await client.ensureConnected();
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    success: true,
                    already_running: true,
                    connected: true,
                    websocket: `ws://${host}:${port}`,
                  },
                  null,
                  2
                ),
              },
            ],
          };
        } catch (error) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    success: false,
                    already_running: true,
                    connected: false,
                    error: error instanceof Error ? error.message : String(error),
                  },
                  null,
                  2
                ),
              },
            ],
            isError: true,
          };
        }
      }

      // Case 2: OBS not running — find executable and spawn it.
      let exe: string | null;
      try {
        exe = findObsExecutable();
      } catch (error) {
        // findObsExecutable throws when OBS_EXECUTABLE_PATH is set but invalid.
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: false,
                  error: error instanceof Error ? error.message : String(error),
                },
                null,
                2
              ),
            },
          ],
          isError: true,
        };
      }
      if (!exe) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: false,
                  error:
                    "OBS Studio executable not found in standard locations or on PATH. " +
                    "Install OBS from https://obsproject.com/, OR set the OBS_EXECUTABLE_PATH " +
                    "environment variable to the full path of obs64.exe / OBS / obs.",
                },
                null,
                2
              ),
            },
          ],
          isError: true,
        };
      }

      lastLaunchedProcess = spawn(exe, [], {
        detached: true,
        stdio: "ignore",
        cwd: path.dirname(exe),
      });
      lastLaunchedProcess.unref();

      // Poll the WebSocket port until ready or timeout.
      const start = Date.now();
      while (Date.now() - start < waitMs) {
        if (await isPortOpen(host, port, 500)) {
          try {
            await client.ensureConnected();
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(
                    {
                      success: true,
                      launched: true,
                      pid: lastLaunchedProcess.pid,
                      executable: exe,
                      websocket: `ws://${host}:${port}`,
                      elapsed_ms: Date.now() - start,
                    },
                    null,
                    2
                  ),
                },
              ],
            };
          } catch {
            // Port is open but handshake failed (OBS still initialising).
            // Wait a bit more and retry.
          }
        }
        await new Promise((r) => setTimeout(r, 500));
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                success: false,
                launched: true,
                pid: lastLaunchedProcess?.pid,
                error: `OBS was launched but the WebSocket server did not become available within ${
                  wait_seconds ?? 30
                }s. Verify that "Enable WebSocket server" is checked in Tools → WebSocket Server Settings.`,
                executable: exe,
              },
              null,
              2
            ),
          },
        ],
        isError: true,
      };
    }
  );

  // ──────────────────────── obs-health-check ────────────────────────
  server.tool(
    "obs-health-check",
    "Report current OBS / MCP connection state WITHOUT throwing. Returns whether the OBS process is running, whether the WebSocket port is open, and whether the MCP client is connected and identified. Safe to call at any time, including when OBS is closed.",
    {},
    async () => {
      const { host, port } = getObsWsHostPort();
      const obsRunning = isObsRunning();
      const wsReachable = await isPortOpen(host, port, 500);
      const mcpConnected = client.isConnected();
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                obs_process_running: obsRunning,
                websocket_port_open: wsReachable,
                mcp_client_connected: mcpConnected,
                websocket: `ws://${host}:${port}`,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // ───────────────────────── obs-close ─────────────────────────
  server.tool(
    "obs-close",
    "Disconnect the MCP client from OBS. Does NOT terminate OBS Studio itself (the GUI stays open). Use this if you want to release the WebSocket connection without killing the user's session.",
    {},
    async () => {
      try {
        client.disconnect();
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ success: true, disconnected: true }, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: false,
                  error: error instanceof Error ? error.message : String(error),
                },
                null,
                2
              ),
            },
          ],
          isError: true,
        };
      }
    }
  );
}
