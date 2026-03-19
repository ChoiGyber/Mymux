import fs from "node:fs";
import { APP_DIR, LOGS_DIR, STATE_FILE } from "./config.js";
import type { PersistedState, SessionRecord } from "./types.js";

export function ensureAppDir(): void {
  fs.mkdirSync(APP_DIR, { recursive: true });
  fs.mkdirSync(LOGS_DIR, { recursive: true });
}

export function loadState(): PersistedState {
  ensureAppDir();

  if (!fs.existsSync(STATE_FILE)) {
    return { sessions: [] };
  }

  const raw = fs.readFileSync(STATE_FILE, "utf8");
  const parsed = JSON.parse(raw) as PersistedState;
  return {
    sessions: parsed.sessions ?? [],
  };
}

export function saveState(sessions: Iterable<SessionRecord>): void {
  ensureAppDir();
  const state: PersistedState = {
    sessions: [...sessions],
  };
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}
