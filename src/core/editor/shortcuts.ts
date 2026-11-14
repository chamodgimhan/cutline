// Shortcut map: key combos to action ids, user overrides, conflict detection.
import type { Action } from './actions.ts';

export interface KeyLike {
  key: string;
  code?: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'AltGraph', 'CapsLock']);

/** Canonical combo for a key event, e.g. 'Ctrl+Shift+Z', 'Space', 'ArrowLeft'. Null for a bare modifier. */
export function comboOf(e: KeyLike): string | null {
  if (MODIFIER_KEYS.has(e.key)) return null;
  let key = e.key === ' ' ? 'Space' : e.key.length === 1 ? e.key.toUpperCase() : e.key;
  // With Alt held some layouts produce another character; fall back to the physical key.
  if (e.altKey && e.code?.startsWith('Key')) key = e.code.slice(3);
  // Shift is part of the combo for named keys and letters; for symbols it is already in the character.
  const shift = e.shiftKey && (key.length > 1 || /[A-Z]/.test(key));
  return `${e.ctrlKey || e.metaKey ? 'Ctrl+' : ''}${e.altKey ? 'Alt+' : ''}${shift ? 'Shift+' : ''}${key}`;
}

/** True when the event target is somewhere the user types text, so shortcuts must not fire. */
export function isTypingTarget(target: { tagName?: string; isContentEditable?: boolean; type?: string } | null): boolean {
  if (!target) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName?.toUpperCase();
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  // Buttons, checkboxes and sliders are inputs too, but nobody types into them.
  return tag === 'INPUT' && !['button', 'checkbox', 'radio', 'range', 'submit', 'reset', 'color', 'file'].includes((target.type ?? 'text').toLowerCase());
}

/** User overrides: action id -> its combos (an empty list removes the shortcut). */
export type Overrides = Record<string, string[]>;

export class ShortcutMap {
  private readonly actions: readonly Action[];
  private overrides: Overrides;

  constructor(actions: readonly Action[], overrides: Overrides = {}) {
    this.actions = actions;
    this.overrides = { ...overrides };
  }

  keysFor(id: string): string[] {
    return this.overrides[id] ?? this.actions.find((a) => a.id === id)?.keys ?? [];
  }

  /** Action id bound to a combo. When several are (a conflict), the first in registry order wins. */
  actionFor(combo: string): string | null {
    return this.actions.find((a) => this.keysFor(a.id).includes(combo))?.id ?? null;
  }

  /** Combos bound to more than one action. */
  conflicts(): { combo: string; actions: string[] }[] {
    const by = new Map<string, string[]>();
    for (const a of this.actions) for (const k of this.keysFor(a.id)) by.set(k, [...(by.get(k) ?? []), a.id]);
    return [...by].filter(([, ids]) => ids.length > 1).map(([combo, actions]) => ({ combo, actions }));
  }

  /** Other actions already using `combo`. */
  usedBy(combo: string, except: string): string[] {
    return this.actions.filter((a) => a.id !== except && this.keysFor(a.id).includes(combo)).map((a) => a.id);
  }

  set(id: string, keys: string[]): void {
    this.overrides[id] = [...new Set(keys)];
  }

  reset(id?: string): void {
    if (id) delete this.overrides[id];
    else this.overrides = {};
  }

  /** Overrides to persist. */
  toJSON(): Overrides {
    return { ...this.overrides };
  }
}
