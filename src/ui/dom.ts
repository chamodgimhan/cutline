// Minimal DOM helpers. The UI is plain elements; no framework.

type Child = Node | string | number | null | undefined | false;
type Props = Record<string, unknown>;

/** Create an element. Props starting with "on" are listeners; "class", "style" and attributes are set; the rest are assigned. */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    else if (k === 'class') el.className = String(v);
    else if (k === 'style') el.style.cssText = String(v);
    else if (k.startsWith('aria-') || k.startsWith('data-') || k === 'role' || k === 'for' || k === 'title' || k === 'draggable' || k === 'tabindex') el.setAttribute(k, String(v));
    else (el as unknown as Props)[k] = v;
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

/** Replace an element's children. */
export function fill(el: Element, ...children: Child[]): void {
  el.replaceChildren(...children.filter((c): c is Node | string | number => c !== null && c !== undefined && c !== false).map((c) => (c instanceof Node ? c : String(c))));
}

/** Run `fn` at most once per animation frame. */
export function framed(fn: () => void): () => void {
  let queued = false;
  return () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      fn();
    });
  };
}

export function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback; // storage blocked or corrupt: use defaults
  }
}

export function save(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // storage full or blocked: the setting just does not persist
  }
}
