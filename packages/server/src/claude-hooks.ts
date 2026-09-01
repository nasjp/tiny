import fs from "node:fs";
import path from "node:path";

/**
 * "always" mode is nothing but a pair of hooks in the agent's settings.json, so the mode has a
 * single source of truth and `tiny doctor` can read it back.
 */


/**
 * Build the hook command line from a launch spec (`tinyLaunch()` gives {command, args}).
 * The daemon's PATH is minimal, so this must be an absolute node + entry path, not bare `tiny`.
 */
export function buildHookCommand(command: string, args: string[]): string {
  const quote = (s: string) => (/^[A-Za-z0-9_/.:=-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);
  return [command, ...args, "handoff", "--auto"].map(quote).join(" ");
}

/**
 * The tail that turns the handoff command line into the question hook's. Claude Code does not write
 * an AskUserQuestion to the transcript until it is answered (measured on 2.1.252: a question left on
 * screen for 60s wrote nothing), so the transcript alone would show the phone a question only after
 * it was over. This hook fires before the prompt is drawn and carries tool_use_id + the questions.
 */
function questionCommand(handoffCommand: string): string {
  return handoffCommand.replace(/handoff --auto$/, "question --auto");
}

interface HookCommand { type?: string; command?: string }
interface HookEntry { matcher?: string; hooks?: HookCommand[] }
type Settings = Record<string, unknown> & { hooks?: Record<string, HookEntry[]> };

function settingsFile(configDir: string): string {
  return path.join(configDir, "settings.json");
}

function load(configDir: string): Settings {
  const file = settingsFile(configDir);
  if (!fs.existsSync(file)) return {};
  const raw = fs.readFileSync(file, "utf8");
  if (raw.trim() === "") return {};
  try {
    return JSON.parse(raw) as Settings;
  } catch {
    // Never overwrite something we could not read — it is the user's own config
    throw new Error(`${file} could not be parsed; fix it before changing the mode`);
  }
}

/**
 * A hook is ours when its command *ends* with tiny's handoff invocation. Matching a bare
 * substring would also claim an unrelated hook that merely mentions it, and `tiny live off`
 * deletes whatever it claims. The leading path varies by install shape (dist vs source via
 * tsx), so only the tail can be relied on.
 */
const OURS = /(^|\s)(handoff\s+--auto(\s+--ended)?|question\s+--auto)$/;

function isOurs(cmd: HookCommand): boolean {
  return typeof cmd.command === "string" && OURS.test(cmd.command);
}

/** Whether the always-on handoff hook is installed */
export function readLiveMode(configDir: string): boolean {
  let s: Settings;
  try {
    s = load(configDir);
  } catch {
    return false;
  }
  return (s.hooks?.SessionStart ?? []).some((e) => (e.hooks ?? []).some(isOurs));
}

/** Install or remove tiny's SessionStart / SessionEnd hooks, leaving every other hook alone */
export function setLiveMode(configDir: string, on: boolean, command: string): void {
  const s = load(configDir);
  const hooks = (s.hooks ?? {}) as Record<string, HookEntry[]>;

  const wanted = [
    ["SessionStart", command, ""],
    ["SessionEnd", `${command} --ended`, ""],
    // Only AskUserQuestion: every other tool call would pay the cost of a hook process
    ["PreToolUse", questionCommand(command), "AskUserQuestion"],
  ] as const;
  for (const [event, cmd, matcher] of wanted) {
    const entries = (hooks[event] ?? [])
      .map((e) => ({ ...e, hooks: (e.hooks ?? []).filter((h) => !isOurs(h)) }))
      .filter((e) => (e.hooks ?? []).length > 0);
    if (on) entries.push({ matcher, hooks: [{ type: "command", command: cmd }] });
    if (entries.length > 0) hooks[event] = entries;
    else delete hooks[event];
  }

  if (Object.keys(hooks).length > 0) s.hooks = hooks;
  else delete s.hooks;

  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(settingsFile(configDir), JSON.stringify(s, null, 2) + "\n");
}
