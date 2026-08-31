import { beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { addProfile, listProfiles, profileDir, renameProfile } from "../src/profiles.js";
import { EMPTY_CAPABILITIES, registerDriver } from "../src/agents/index.js";

describe("profiles", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "tiny-profiles-"));
  });

  it("returns agent and model/effort defaults from settings.json", () => {
    const p = addProfile(root, "work");
    expect(p.agent).toBe("claude");
    expect(p.defaultModel).toBeNull();
    expect(p.defaultEffort).toBeNull();
    fs.writeFileSync(path.join(p.dir, "settings.json"),
      JSON.stringify({ model: "claude-opus-5", effort: "high" }));
    const again = listProfiles(root)[0]!;
    expect(again.defaultModel).toBe("claude-opus-5");
    expect(again.defaultEffort).toBe("high");
    // does not crash on broken settings.json
    fs.writeFileSync(path.join(p.dir, "settings.json"), "{broken");
    expect(listProfiles(root)[0]!.defaultModel).toBeNull();
  });

  it("addProfile creates the directory and it appears in listProfiles", () => {
    const p = addProfile(root, "work");
    expect(p.name).toBe("work");
    expect(fs.existsSync(p.dir)).toBe(true);
    expect(p.loggedIn).toBe(false);
    expect(listProfiles(root).map((x) => x.name)).toEqual(["work"]);
  });

  it("is loggedIn when .credentials.json exists", () => {
    const p = addProfile(root, "personal");
    fs.writeFileSync(path.join(p.dir, ".credentials.json"), "{}");
    expect(listProfiles(root).find((x) => x.name === "personal")?.loggedIn).toBe(true);
  });

  it("rejects invalid names", () => {
    expect(() => addProfile(root, "Bad Name")).toThrow();
    expect(() => addProfile(root, "../evil")).toThrow();
  });

  it("profileDir throws for a nonexistent profile", () => {
    addProfile(root, "work");
    expect(profileDir(root, "work")).toBe(path.join(root, "work"));
    expect(() => profileDir(root, "nope")).toThrow();
  });

  it("is loggedIn when .claude.json has oauthAccount (token stored in macOS Keychain)", () => {
    const p = addProfile(root, "mac");
    fs.writeFileSync(path.join(p.dir, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "x@example.com" } }));
    expect(listProfiles(root).find((x) => x.name === "mac")?.loggedIn).toBe(true);
  });

  it("exposes oauthAccount's emailAddress as email", () => {
    const p = addProfile(root, "work");
    expect(p.email).toBeNull();
    fs.writeFileSync(path.join(p.dir, ".claude.json"),
      JSON.stringify({ oauthAccount: { emailAddress: "y@example.com" } }));
    expect(listProfiles(root)[0]!.email).toBe("y@example.com");
    // does not crash when emailAddress is missing/broken
    fs.writeFileSync(path.join(p.dir, ".claude.json"), JSON.stringify({ oauthAccount: {} }));
    expect(listProfiles(root)[0]!.email).toBeNull();
    fs.writeFileSync(path.join(p.dir, ".claude.json"), "{broken");
    expect(listProfiles(root)[0]!.email).toBeNull();
  });

  it("is not loggedIn when .claude.json exists without oauthAccount", () => {
    const p = addProfile(root, "nologin");
    fs.writeFileSync(path.join(p.dir, ".claude.json"), JSON.stringify({ theme: "dark" }));
    expect(listProfiles(root).find((x) => x.name === "nologin")?.loggedIn).toBe(false);
  });

  it("renameProfile renames the whole directory", () => {
    const p = addProfile(root, "work");
    fs.writeFileSync(path.join(p.dir, ".claude.json"),
      JSON.stringify({ oauthAccount: { emailAddress: "y@example.com" } }));
    const renamed = renameProfile(root, "work", "profile-3");
    expect(renamed.name).toBe("profile-3");
    expect(renamed.email).toBe("y@example.com");
    expect(fs.existsSync(path.join(root, "work"))).toBe(false);
    expect(listProfiles(root).map((x) => x.name)).toEqual(["profile-3"]);
  });

  it("renameProfile rejects invalid, missing, conflicting, and identical names", () => {
    addProfile(root, "work");
    addProfile(root, "other");
    expect(() => renameProfile(root, "work", "Bad Name")).toThrow();
    expect(() => renameProfile(root, "work", "../evil")).toThrow();
    expect(() => renameProfile(root, "nope", "fine")).toThrow(/not found/);
    expect(() => renameProfile(root, "work", "other")).toThrow(/already exists/);
    expect(() => renameProfile(root, "work", "work")).toThrow(/already named/);
    expect(fs.existsSync(path.join(root, "work"))).toBe(true);
  });
});

describe("profiles: agent kind (tiny-profile.json)", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "tiny-profiles-agent-"));
  });

  it("addProfile defaults to claude and returns label and capabilities", () => {
    const p = addProfile(root, "work");
    expect(p.agent).toBe("claude");
    expect(p.label).toBe("Claude");
    expect(p.capabilities.permissionModes.map((m) => m.id)).toContain("acceptEdits");
    expect(p.capabilities.models.length).toBeGreaterThan(0);
    // write tiny-profile.json even for the default (newer tinyd holds the agent explicitly)
    const meta = JSON.parse(fs.readFileSync(path.join(p.dir, "tiny-profile.json"), "utf8"));
    expect(meta.agent).toBe("claude");
  });

  it("treats an existing profile without tiny-profile.json as claude", () => {
    fs.mkdirSync(path.join(root, "legacy"));
    const p = listProfiles(root)[0]!;
    expect(p.name).toBe("legacy");
    expect(p.agent).toBe("claude");
    expect(p.label).toBe("Claude");
  });

  it("addProfile rejects an unregistered agent", () => {
    expect(() => addProfile(root, "cx", "not-an-agent")).toThrow(/unknown agent/);
  });

  it("listing does not crash on a profile with an unknown agent (created by a newer tinyd)", () => {
    fs.mkdirSync(path.join(root, "future"));
    fs.writeFileSync(path.join(root, "future", "tiny-profile.json"), JSON.stringify({ agent: "future-agent" }));
    const p = listProfiles(root)[0]!;
    expect(p.agent).toBe("future-agent");
    expect(p.label).toBe("future-agent");
    expect(p.loggedIn).toBe(false);
    expect(p.capabilities.models).toEqual([]);
  });

  it("treats a broken tiny-profile.json as claude", () => {
    fs.mkdirSync(path.join(root, "broken"));
    fs.writeFileSync(path.join(root, "broken", "tiny-profile.json"), "{nope");
    expect(listProfiles(root)[0]!.agent).toBe("claude");
  });

  it("addProfile calls the driver's prepareProfile with the profile dir", () => {
    const prepared: string[] = [];
    registerDriver({
      id: "fake-prep",
      label: "Fake",
      bin: "fake",
      adapter: "acp",
      launch: { command: "fake", args: ["acp"] },
      homeEnv: () => ({}),
      stripEnv: [],
      isLoggedIn: () => false,
      login: () => ({ bin: "fake", args: ["login"] }),
      attach: () => ({ bin: "fake", args: [] }),
      capabilities: () => EMPTY_CAPABILITIES,
      prepareProfile: (dir) => prepared.push(dir),
    });
    const p = addProfile(root, "prep", "fake-prep");
    expect(prepared).toEqual([p.dir]);
  });
});
