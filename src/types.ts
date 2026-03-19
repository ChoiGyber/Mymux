export interface SessionRecord {
  name: string;
  shell: string;
  cwd: string;
  pid: number;
  logPath: string;
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
      type: "readLogs";
      name: string;
      lines: number;
    };

export type ServerMessage =
  | {
      type: "ready";
      pid: number;
    }
  | {
      type: "success";
      message: string;
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
