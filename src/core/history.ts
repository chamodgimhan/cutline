// Undo/redo history. Owns the current project; every change goes through execute().
import { Command } from './command.ts';
import type { Project } from './model.ts';

interface Entry {
  command: Command;
  serial: number;
}

export class History {
  private current: Project;
  private past: Entry[] = [];
  private future: Entry[] = [];
  private open: { label: string; commands: Command[] }[] = [];
  private serial = 0;
  private savedSerial = 0;
  private readonly limit: number;
  private readonly listeners = new Set<() => void>();

  constructor(project: Project, limit = 1000) {
    this.current = project;
    this.limit = limit;
  }

  get project(): Project {
    return this.current;
  }

  /** Apply a command and record it. Empty commands are ignored. */
  execute(command: Command): void {
    if (command.isEmpty) return;
    this.current = command.apply(this.current);
    const group = this.open[this.open.length - 1];
    if (group) group.commands.push(command);
    else this.record(command);
    this.emit();
  }

  private record(command: Command): void {
    this.past.push({ command, serial: ++this.serial });
    this.future = [];
    if (this.past.length > this.limit) this.past.shift();
  }

  /** Start collecting commands into one undo step. Groups may nest. */
  beginGroup(label: string): void {
    this.open.push({ label, commands: [] });
  }

  /** Close the innermost group; its commands become a single undo step. */
  endGroup(): void {
    const group = this.open.pop();
    if (!group || group.commands.length === 0) return;
    const merged = Command.group(group.label, group.commands);
    const outer = this.open[this.open.length - 1];
    if (outer) outer.commands.push(merged);
    else this.record(merged);
    this.emit();
  }

  /** Abandon the innermost group and roll back everything it did. */
  cancelGroup(): void {
    const group = this.open.pop();
    if (!group) return;
    for (const c of group.commands.reverse()) this.current = c.invert().apply(this.current);
    this.emit();
  }

  /** Run `fn` as one undo step. If it throws, its changes are rolled back and the error rethrown. */
  group<T>(label: string, fn: () => T): T {
    this.beginGroup(label);
    try {
      const out = fn();
      this.endGroup();
      return out;
    } catch (e) {
      this.cancelGroup();
      throw e;
    }
  }

  get canUndo(): boolean {
    return this.open.length === 0 && this.past.length > 0;
  }
  get canRedo(): boolean {
    return this.open.length === 0 && this.future.length > 0;
  }
  get undoLabel(): string | null {
    return this.past[this.past.length - 1]?.command.label ?? null;
  }
  get redoLabel(): string | null {
    return this.future[this.future.length - 1]?.command.label ?? null;
  }

  undo(): boolean {
    if (!this.canUndo) return false;
    const e = this.past.pop() as Entry;
    this.current = e.command.invert().apply(this.current);
    this.future.push(e);
    this.emit();
    return true;
  }

  redo(): boolean {
    if (!this.canRedo) return false;
    const e = this.future.pop() as Entry;
    this.current = e.command.apply(this.current);
    this.past.push(e);
    this.emit();
    return true;
  }

  /** Labels of applied steps (oldest first) then undone steps (next redo first), for the history panel. */
  entries(): { label: string; applied: boolean }[] {
    return [
      ...this.past.map((e) => ({ label: e.command.label, applied: true })),
      ...this.future.slice().reverse().map((e) => ({ label: e.command.label, applied: false })),
    ];
  }

  /** Undo or redo until exactly `count` steps are applied. */
  jumpTo(count: number): void {
    while (this.past.length > count && this.undo());
    while (this.past.length < count && this.redo());
  }

  get appliedCount(): number {
    return this.past.length;
  }

  private get stateSerial(): number {
    return this.past[this.past.length - 1]?.serial ?? 0;
  }

  /** True when the project differs from the last saved state. */
  get dirty(): boolean {
    return this.stateSerial !== this.savedSerial;
  }

  markSaved(): void {
    this.savedSerial = this.stateSerial;
    this.emit();
  }

  /** Replace the project and clear history (open, new, recover). */
  reset(project: Project, dirty = false): void {
    this.current = project;
    this.past = [];
    this.future = [];
    this.open = [];
    this.savedSerial = dirty ? -1 : 0;
    this.serial = 0;
    this.emit();
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }
}
