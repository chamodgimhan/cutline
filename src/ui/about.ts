// About and Licence dialog: version, owner, licence status, activate and deactivate.
import type { Action } from '../core/editor/actions.ts';
import { describeLicense, fromB64, verifyLicense, type LicenseStatus } from '../core/license.ts';
import { LICENSE_PUBLIC_KEY } from '../core/licenseKey.ts';
import type { App } from './app.ts';
import { fill, h } from './dom.ts';
import { kv } from './storage.ts';

export const APP_VERSION = '1.0.0';
const today = (): string => new Date().toISOString().slice(0, 10);
const check = (key: string): Promise<LicenseStatus> => verifyLicense(key, fromB64(LICENSE_PUBLIC_KEY), today());

/** Read the stored key at start-up. A key that no longer verifies (expired) leaves the app unlicensed. */
export async function loadLicense(app: App): Promise<void> {
  const key = await kv.get<string>('license');
  app.license = key ? await check(key) : { state: 'none' };
}

function openAbout(app: App): void {
  const status = h('p', { role: 'status', 'data-role': 'license-status' });
  const input = h('textarea', { rows: 3, 'aria-label': 'Licence key', placeholder: 'Paste your licence key here', style: 'width:100%;background:var(--c-bg2);color:inherit;border:1px solid var(--c-line);border-radius:var(--z-radius);font:var(--t-sm) var(--t-mono)' });
  const buttons = h('div', { class: 'foot' });
  const render = (): void => {
    status.textContent = describeLicense(app.license);
    fill(buttons,
      h('button', { 'data-role': 'activate', class: 'on', onclick: async () => {
        const result = await check(input.value);
        if (result.state === 'valid') {
          await kv.set('license', input.value.replace(/\s+/g, ''));
          app.license = result;
          input.value = '';
          render();
        } else status.textContent = result.state === 'invalid' ? result.message : 'Paste a licence key first.';
      } }, 'Activate'),
      app.license.state === 'valid' && h('button', { 'data-role': 'deactivate', onclick: async () => {
        await kv.del('license');
        app.license = { state: 'none' };
        render();
      } }, 'Deactivate'),
      h('button', { 'data-role': 'close', onclick: () => close() }, 'Close'));
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') close();
    e.stopPropagation();
  };
  const back = h('div', { class: 'dialog-back', onpointerdown: (e: Event) => e.target === back && close() },
    h('div', { class: 'dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'About Cutline', style: 'width:min(520px,92vw);grid-template-rows:auto auto auto auto' },
      h('h2', {}, `Cutline ${APP_VERSION}`),
      h('div', {}, h('p', {}, 'Video clipping editor. Works fully offline: no account, no network.'), h('p', {}, '© Chamod Gimhan. All rights reserved.'), h('p', {}, 'Third-party notices are in THIRD_PARTY_LICENSES.txt, installed with the app.')),
      h('div', {}, h('h3', { style: 'margin:0 0 4px;font-size:var(--t-lg)' }, 'Licence'), status, input),
      buttons));
  function close(): void {
    window.removeEventListener('keydown', onKey, true);
    back.remove();
  }
  window.addEventListener('keydown', onKey, true);
  document.body.append(back);
  render();
}

export const aboutActions = (app: App): Action[] => [{ id: 'help.about', label: 'About and Licence…', menu: 'Help', keys: [], run: () => openAbout(app) }];
