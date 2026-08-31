import { describe, expect, it } from "vitest";
import { detectTailscaleIp, TAILSCALE_APP_BIN } from "../src/tailscale.js";

describe("detectTailscaleIp", () => {
  it("returns the first line of tailscale ip -4 from PATH", () => {
    const ip = detectTailscaleIp((cmd, args) => (cmd === "/opt/homebrew/bin/tailscale" && args.join(" ") === "ip -4" ? "100.101.102.103\n" : ""), () => "/opt/homebrew/bin/tailscale");
    expect(ip).toBe("100.101.102.103");
  });

  it("tries the Tailscale.app CLI when not on PATH", () => {
    const seen: string[] = [];
    const ip = detectTailscaleIp((cmd) => { seen.push(cmd); return "100.64.0.9\n"; }, () => null);
    expect(seen).toEqual([TAILSCALE_APP_BIN]);
    expect(ip).toBe("100.64.0.9");
  });

  it("null on execution failure or non-IPv4 output", () => {
    expect(detectTailscaleIp(() => { throw new Error("not running"); }, () => "/opt/homebrew/bin/tailscale")).toBeNull();
    expect(detectTailscaleIp(() => "Tailscale is stopped.\n", () => "/opt/homebrew/bin/tailscale")).toBeNull();
  });
});
