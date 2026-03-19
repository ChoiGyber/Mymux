export interface SessionRecord {
  name: string;
  shell: string;
  cwd: string;
  pid: number;
  logPath: string;
  profileName?: string;
  env?: Record<string, string>;
  startupCommand?: string;
  createdAt: string;
  updatedAt: string;
  status: "running" | "attached" | "stopped";
}

export interface PersistedState {
  sessions: SessionRecord[];
}

export type ClientMessage =
  | {
      type: "createSession";
      name: string;
      shell?: string;
      cwd?: string;
      profileName?: string;
      env?: Record<string, string>;
      startupCommand?: string;
    }
  | {
      type: "listSessions";
    }
  | {
      type: "restoreSessions";
    }
  | {
      type: "killSession";
      name: string;
    }
  | {
      type: "renameSession";
      name: string;
      nextName: string;
    }
  | {
      type: "attachSession";
      name: string;
      cols: number;
      rows: number;
    }
  | {
      type: "stdin";
      data: string;
    }
  | {
      type: "resize";
      cols: number;
      rows: number;
    }
  | {
      type: "detach";
    }
  | {
      type: "health";
    }
  | {
      type: "stopDaemon";
    }
  | {
      type: "readLogs";
      name: string;
      lines: number;
      clean?: boolean;
      since?: string;
    };

export type ServerMessage =
  | {
      type: "ready";
      pid: number;
    }
  | {
      type: "success";
      message: string;
      pid?: number;
      session?: SessionRecord;
      sessions?: SessionRecord[];
      log?: string;
    }
  | {
      type: "error";
      message: string;
    }
  | {
      type: "attached";
      session: SessionRecord;
    }
  | {
      type: "output";
      data: string;
    }
  | {
      type: "sessionExit";
      name: string;
      exitCode: number;
    };

export interface SessionProfile {
  cwd?: string;
  shell?: string;
  env?: Record<string, string>;
}

export interface MyCliConfig {
  profiles?: Record<string, SessionProfile>;
}
