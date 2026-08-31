import { describe, expect, it } from "vitest";
import { PermissionBroker } from "../src/permission-broker.js";

describe("PermissionBroker", () => {
  it("resolve settles the decision Promise", async () => {
    const b = new PermissionBroker();
    const { id, decision } = b.request("s1", "Bash", { command: "ls" });
    expect(b.listPending("s1")).toHaveLength(1);
    expect(b.resolve(id, { behavior: "allow" })).toBe(true);
    await expect(decision).resolves.toEqual({ behavior: "allow" });
    expect(b.listPending("s1")).toHaveLength(0);
  });

  it("allow's updatedInput passes through to the decision as-is", async () => {
    const b = new PermissionBroker();
    const { id, decision } = b.request("s1", "AskUserQuestion", { questions: [] });
    const updatedInput = { questions: [], answers: { "Which one?": "Option A" } };
    expect(b.resolve(id, { behavior: "allow", updatedInput })).toBe(true);
    await expect(decision).resolves.toEqual({ behavior: "allow", updatedInput });
  });

  it("resolving an unknown id is false", () => {
    const b = new PermissionBroker();
    expect(b.resolve("nope", { behavior: "allow" })).toBe(false);
  });

  it("a double resolve is false", async () => {
    const b = new PermissionBroker();
    const { id, decision } = b.request("s1", "Bash", {});
    b.resolve(id, { behavior: "deny", message: "no" });
    expect(b.resolve(id, { behavior: "allow" })).toBe(false);
    await expect(decision).resolves.toEqual({ behavior: "deny", message: "no" });
  });

  it("auto-denies on timeout", async () => {
    const b = new PermissionBroker(50);
    const { decision } = b.request("s1", "Bash", {});
    await expect(decision).resolves.toEqual({ behavior: "deny", message: "timeout" });
    expect(b.listPending("s1")).toHaveLength(0);
  });
});
