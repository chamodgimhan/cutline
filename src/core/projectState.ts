// Small pure pieces of project safety: the recent-projects list, the recovery record, the error log.

export interface Recent {
  name: string;
  /** Where it lives: a path on desktop; on the web, the key of a stored file handle. */
  ref: string;
  openedAt: number;
}

export const MAX_RECENTS = 10;

/** Put a project at the top of the recents list (no duplicates, capped). */
export function addRecent(list: readonly Recent[], entry: Recent): Recent[] {
  return [entry, ...list.filter((r) => r.ref !== entry.ref)].slice(0, MAX_RECENTS);
}

/** Autosaved copy of unsaved work, kept until the project is saved or closed cleanly. */
export interface Recovery {
  name: string;
  savedAt: number;
  /** Serialised project (the .cutline text). */
  text: string;
  /** The file it belongs to, if it had been saved before. */
  ref: string | null;
}

export interface LogEntry {
  time: number;
  level: 'info' | 'warning' | 'error';
  message: string;
  detail?: string;
}

/** Bounded in-memory log of what went wrong, for the user to export when reporting a problem. */
export class ErrorLog {
  private entries: LogEntry[];
  private readonly limit: number;
  /** Called after every new entry (the app persists the log here so it survives a crash). */
  onChange: ((entries: readonly LogEntry[]) => void) | null = null;

  constructor(initial: readonly LogEntry[] = [], limit = 500) {
    this.limit = limit;
    this.entries = initial.slice(-limit);
  }

  add(level: LogEntry['level'], message: string, detail?: string, time = Date.now()): void {
    this.entries.push({ time, level, message, ...(detail ? { detail: detail.slice(0, 4000) } : {}) });
    if (this.entries.length > this.limit) this.entries = this.entries.slice(-this.limit);
    this.onChange?.(this.entries);
  }

  get all(): readonly LogEntry[] {
    return this.entries;
  }

  /** Plain text, one entry per line (details indented beneath). No personal data beyond what the messages contain. */
  toText(header = 'Cutline log'): string {
    const lines = this.entries.map((e) => `${new Date(e.time).toISOString()} ${e.level.toUpperCase().padEnd(7)} ${e.message}${e.detail ? '\n    ' + e.detail.replace(/\n/g, '\n    ') : ''}`);
    return [header, `${this.entries.length} entries`, '', ...lines, ''].join('\n');
  }
}
