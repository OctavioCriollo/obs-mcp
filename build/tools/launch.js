import { z } from "zod";
import { spawn, execSync } from "child_process";
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
let lastLaunchedProcess = null;
/**
 * Search common install locations for the OBS Studio executable.
 * Returns the absolute path of the first match or null.
 */
function findObsExecutable() {
    const candidates = [];
    if (process.platform === "win32") {
        const programFiles = process.env["ProgramFiles"] || "C:\\Program Files";
        const programFilesX86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
        candidates.push(path.join(programFiles, "obs-studio", "bin", "64bit", "obs64.exe"));
        candidates.push(path.join(programFilesX86, "obs-studio", "bin", "64bit", "obs64.exe"));
    }
    else if (process.platform === "darwin") {
        candidates.push("/Applications/OBS.app/Contents/MacOS/OBS");
    }
    else {
        // Linux: common locations / PATH lookup
        candidates.push("/usr/bin/obs", "/usr/local/bin/obs", "/snap/bin/obs");
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
function getObsWsHostPort() {
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
function isObsRunning() {
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
    }
    catch {
        return false;
    }
}
/**
 * Open a TCP connection briefly to verify the WebSocket port is reachable.
 * This does NOT speak the WebSocket protocol — it only checks that something
 * is listening. Used to detect "OBS is ready for handshake".
 */
async function isPortOpen(host, port, timeoutMs = 1000) {
    return new Promise((resolve) => {
        const socket = new net.Socket();
        const finish = (ok) => {
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
export async function initialize(server, client) {
    // ───────────────────────── obs-launch ─────────────────────────
    server.tool("obs-launch", "Launch OBS Studio with WebSocket server enabled. Auto-detects the install location on Windows/macOS/Linux, spawns OBS detached, waits up to `wait_seconds` for the WebSocket to become available, then connects the MCP client. If OBS is already running, it just tries to connect. Use this when you want to control OBS from the LLM without manually opening it first.", {
        wait_seconds: z
            .number()
            .min(1)
            .max(120)
            .optional()
            .describe("Max seconds to wait for the OBS WebSocket to become ready (default 30)."),
    }, async ({ wait_seconds }) => {
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
                            text: JSON.stringify({
                                success: true,
                                already_running: true,
                                connected: true,
                                websocket: `ws://${host}:${port}`,
                            }, null, 2),
                        },
                    ],
                };
            }
            catch (error) {
                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify({
                                success: false,
                                already_running: true,
                                connected: false,
                                error: error instanceof Error ? error.message : String(error),
                            }, null, 2),
                        },
                    ],
                    isError: true,
                };
            }
        }
        // Case 2: OBS not running — find executable and spawn it.
        const exe = findObsExecutable();
        if (!exe) {
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify({
                            success: false,
                            error: "OBS Studio executable not found in standard locations. Install OBS from https://obsproject.com/ or set the executable path manually.",
                        }, null, 2),
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
                                text: JSON.stringify({
                                    success: true,
                                    launched: true,
                                    pid: lastLaunchedProcess.pid,
                                    executable: exe,
                                    websocket: `ws://${host}:${port}`,
                                    elapsed_ms: Date.now() - start,
                                }, null, 2),
                            },
                        ],
                    };
                }
                catch {
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
                    text: JSON.stringify({
                        success: false,
                        launched: true,
                        pid: lastLaunchedProcess?.pid,
                        error: `OBS was launched but the WebSocket server did not become available within ${wait_seconds ?? 30}s. Verify that "Enable WebSocket server" is checked in Tools → WebSocket Server Settings.`,
                        executable: exe,
                    }, null, 2),
                },
            ],
            isError: true,
        };
    });
    // ──────────────────────── obs-health-check ────────────────────────
    server.tool("obs-health-check", "Report current OBS / MCP connection state WITHOUT throwing. Returns whether the OBS process is running, whether the WebSocket port is open, and whether the MCP client is connected and identified. Safe to call at any time, including when OBS is closed.", {}, async () => {
        const { host, port } = getObsWsHostPort();
        const obsRunning = isObsRunning();
        const wsReachable = await isPortOpen(host, port, 500);
        const mcpConnected = client.isConnected();
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify({
                        obs_process_running: obsRunning,
                        websocket_port_open: wsReachable,
                        mcp_client_connected: mcpConnected,
                        websocket: `ws://${host}:${port}`,
                    }, null, 2),
                },
            ],
        };
    });
    // ───────────────────────── obs-close ─────────────────────────
    server.tool("obs-close", "Disconnect the MCP client from OBS. Does NOT terminate OBS Studio itself (the GUI stays open). Use this if you want to release the WebSocket connection without killing the user's session.", {}, async () => {
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
        }
        catch (error) {
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify({
                            success: false,
                            error: error instanceof Error ? error.message : String(error),
                        }, null, 2),
                    },
                ],
                isError: true,
            };
        }
    });
}
