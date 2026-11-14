// Menu bar and context menus, generated from the action registry.
import type { Menu } from '../core/editor/actions.ts';
import type { App } from './app.ts';
import { h } from './dom.ts';

const MENUS: Menu[] = ['Edit', 'Clip', 'Mark', 'Sequence', 'Titles', 'Track', 'Playback', 'View', 'Tools', 'Help'];
let open: { el: HTMLElement; close: () => void } | null = null;

export function closeMenu(): void {
  open?.close();
}

/** Show a menu of actions at a point. '-' is a separator. Arrow keys move, Escape closes. */
export function openMenu(app: App, x: number, y: number, ids: readonly string[], returnFocus?: HTMLElement): void {
  closeMenu();
  const items = ids.map((id) => {
    if (id === '-') return h('hr', {});
    const a = app.actions.find((v) => v.id === id);
    if (!a) return null;
    const keys = app.shortcuts.keysFor(id)[0];
    return h('button', { role: 'menuitem', 'data-action': id, onclick: () => {
      closeMenu();
      app.run(id);
    } }, h('span', {}, `${a.checked?.(app.session) ? '✓ ' : ''}${a.label}`), keys ? h('kbd', {}, keys) : null);
  });
  const el = h('div', { class: 'menu', role: 'menu', style: `left:${x}px;top:${y}px` }, ...items);
  const buttons = (): HTMLButtonElement[] => [...el.querySelectorAll('button')];
  const onKey = (e: KeyboardEvent): void => {
    const list = buttons();
    const i = list.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowDown') list[(i + 1) % list.length]?.focus();
    else if (e.key === 'ArrowUp') list[(i - 1 + list.length) % list.length]?.focus();
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  const onDown = (e: PointerEvent): void => {
    if (!el.contains(e.target as Node)) close();
  };
  function close(): void {
    el.remove();
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('pointerdown', onDown, true);
    open = null;
    returnFocus?.focus();
  }
  document.body.append(el);
  // Keep the menu on screen.
  const r = el.getBoundingClientRect();
  if (r.right > innerWidth) el.style.left = `${Math.max(0, innerWidth - r.width)}px`;
  if (r.bottom > innerHeight) el.style.top = `${Math.max(0, innerHeight - r.height)}px`;
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('pointerdown', onDown, true);
  open = { el, close };
  buttons()[0]?.focus();
}

export function menuBar(app: App): HTMLElement {
  return h(
    'nav', { class: 'menubar', 'aria-label': 'Main menu' },
    h('span', { class: 'brand' }, 'CUTLINE'),
    ...MENUS.map((menu) => {
      const b: HTMLButtonElement = h('button', { 'aria-haspopup': 'menu', 'data-menu': menu, onclick: () => {
        const r = b.getBoundingClientRect();
        openMenu(app, r.left, r.bottom, app.actions.filter((a) => a.menu === menu).map((a) => a.id), b);
      } }, menu);
      return b;
    }),
  );
}
