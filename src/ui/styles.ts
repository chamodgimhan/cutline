// All UI CSS. Every colour, space and size comes from theme variables.
import { themeCssVariables } from '../theme/theme.ts';

const CSS = `
* { box-sizing: border-box; }
html, body { height: 100%; margin: 0; }
body { background: var(--c-bg0); color: var(--c-text); font: var(--t-md)/1.4 var(--t-family); overflow: hidden; user-select: none; }
button, input, select { font: inherit; color: inherit; }
button { background: var(--c-bg2); border: 1px solid var(--c-line); border-radius: var(--z-radius); height: var(--z-control); padding: 0 var(--s-x3); cursor: pointer; }
button:hover { background: var(--c-bg3); }
button[aria-pressed="true"], button.on { background: var(--c-accent); color: var(--c-accent-text); border-color: var(--c-accent); }
button:disabled { color: var(--c-text-faint); cursor: default; }
input, select { background: var(--c-bg2); border: 1px solid var(--c-line); border-radius: var(--z-radius); height: var(--z-control); padding: 0 var(--s-x2); min-width: 0; }
input[type=checkbox] { height: auto; }
input[type=range] { padding: 0; border: 0; background: none; accent-color: var(--c-accent); }
:focus-visible { outline: var(--z-focus-ring) solid var(--c-select); outline-offset: 1px; }
#app { display: grid; grid-template-rows: auto 1fr auto; height: 100%; }
.menubar { display: flex; gap: var(--s-x1); padding: var(--s-x1) var(--s-x3); background: var(--c-bg1); border-bottom: 1px solid var(--c-line); align-items: center; }
.menubar > button { border-color: transparent; background: none; }
.menubar .brand { font-weight: 700; color: var(--c-accent); margin-right: var(--s-x4); letter-spacing: 0.04em; }
.menu { position: fixed; z-index: 50; background: var(--c-bg2); border: 1px solid var(--c-line); border-radius: var(--z-radius); padding: var(--s-x1); min-width: 220px; box-shadow: 0 8px 24px var(--c-overlay); max-height: 80vh; overflow: auto; }
.menu button { display: flex; justify-content: space-between; gap: var(--s-x6); width: 100%; border: 0; background: none; text-align: left; }
.menu button:hover, .menu button:focus-visible { background: var(--c-bg3); }
.menu kbd { color: var(--c-text-dim); font: var(--t-sm) var(--t-mono); }
.menu hr { border: 0; border-top: 1px solid var(--c-line); margin: var(--s-x1) 0; }
.work { display: grid; min-height: 0; }
.row { display: grid; min-height: 0; min-width: 0; }
.panel { display: grid; grid-template-rows: var(--z-panel-header) 1fr; min-width: 0; min-height: 0; background: var(--c-bg1); border: 1px solid var(--c-line); }
.panel > header { display: flex; align-items: center; gap: var(--s-x3); padding: 0 var(--s-x3); color: var(--c-text-dim); font-size: var(--t-sm); text-transform: uppercase; letter-spacing: 0.06em; border-bottom: 1px solid var(--c-line); }
.panel > .body { min-height: 0; min-width: 0; overflow: auto; position: relative; }
.split { background: var(--c-bg0); }
.split.v { cursor: col-resize; width: var(--s-x2); }
.split.h { cursor: row-resize; height: var(--s-x2); }
.split:hover, .split:focus-visible { background: var(--c-select); }
.stack { display: grid; grid-template-rows: 3fr 2fr; min-height: 0; }
.status { display: flex; gap: var(--s-x5); padding: var(--s-x1) var(--s-x3); background: var(--c-bg1); border-top: 1px solid var(--c-line); color: var(--c-text-dim); font-size: var(--t-sm); min-height: 22px; }
.status .msg { color: var(--c-danger); }
.bin { padding: var(--s-x2); display: flex; flex-direction: column; gap: var(--s-x1); min-height: 100%; }
.bin.over { outline: 2px dashed var(--c-select); outline-offset: -4px; }
.bin .item { display: grid; grid-template-columns: 64px 1fr auto; gap: var(--s-x3); align-items: center; padding: var(--s-x1); border-radius: var(--z-radius); cursor: grab; }
.bin .item:hover, .bin .item.sel { background: var(--c-bg3); }
.bin .item canvas, .bin .item .ph { width: 64px; height: 36px; background: var(--c-bg0); border-radius: 2px; }
.bin .item small { color: var(--c-text-dim); display: block; }
.bin .item.offline strong { color: var(--c-danger); }
.bin .empty { color: var(--c-text-faint); padding: var(--s-x6); text-align: center; }
.monitor { display: grid; grid-template-rows: 1fr auto auto; height: 100%; }
.monitor .stage { min-height: 0; display: flex; align-items: center; justify-content: center; background: var(--c-bg0); overflow: hidden; }
.monitor canvas { max-width: 100%; max-height: 100%; }
.monitor .bar { display: flex; align-items: center; gap: var(--s-x2); padding: var(--s-x2) var(--s-x3); flex-wrap: wrap; }
.monitor .tc { font: var(--t-lg) var(--t-mono); color: var(--c-accent); min-width: 11ch; }
.monitor input[type=range] { width: 100%; display: block; }
.monitor .scrub { padding: 0 var(--s-x3); }
.grow { flex: 1; }
.timeline { display: grid; grid-template-columns: auto var(--z-track-header-width) 1fr; height: 100%; }
.tools { display: flex; flex-direction: column; gap: var(--s-x1); padding: var(--s-x2); border-right: 1px solid var(--c-line); }
.tools button { width: 34px; padding: 0; }
.heads { position: relative; overflow: hidden; border-right: 1px solid var(--c-line); }
.heads .head { position: absolute; left: 0; right: 0; height: var(--z-track-height); padding: var(--s-x2); border-bottom: 1px solid var(--c-line); display: flex; flex-direction: column; gap: var(--s-x1); }
.heads .head.active { background: var(--c-bg3); }
.heads .head .flags { display: flex; gap: var(--s-x1); }
.heads .head .flags button { height: 18px; padding: 0 var(--s-x2); font-size: var(--t-xs); }
.lanes { position: relative; min-width: 0; }
.lanes canvas { position: absolute; inset: 0; width: 100%; height: 100%; touch-action: none; }
.inspector { padding: var(--s-x3); display: grid; grid-template-columns: auto 1fr; gap: var(--s-x2) var(--s-x3); align-items: center; }
.inspector h3 { grid-column: 1 / -1; margin: var(--s-x3) 0 0; font-size: var(--t-sm); color: var(--c-text-dim); text-transform: uppercase; }
.inspector label { color: var(--c-text-dim); }
.inspector .none { grid-column: 1 / -1; color: var(--c-text-faint); }
.meters { height: 100%; padding: var(--s-x2); }
.meters canvas { width: 100%; height: 100%; display: block; }
.history { padding: var(--s-x1); }
.history button { display: block; width: 100%; text-align: left; border: 0; background: none; }
.history button.undone { color: var(--c-text-faint); }
.history button.current { background: var(--c-bg3); }
.dialog-back { position: fixed; inset: 0; background: var(--c-overlay); z-index: 60; display: flex; align-items: center; justify-content: center; }
.dialog { background: var(--c-bg1); border: 1px solid var(--c-line); border-radius: var(--z-radius); width: min(720px, 92vw); max-height: 86vh; display: grid; grid-template-rows: auto auto 1fr auto; gap: var(--s-x3); padding: var(--s-x5); }
.dialog h2 { margin: 0; font-size: var(--t-xl); }
.dialog .list { overflow: auto; border: 1px solid var(--c-line); border-radius: var(--z-radius); }
.dialog .list .r { display: grid; grid-template-columns: 1fr auto auto auto; gap: var(--s-x3); align-items: center; padding: var(--s-x1) var(--s-x3); border-bottom: 1px solid var(--c-line); }
.dialog .list .r .warn { color: var(--c-danger); font-size: var(--t-sm); grid-column: 1 / -1; }
.dialog .foot { display: flex; gap: var(--s-x3); justify-content: flex-end; }
kbd { font: var(--t-sm) var(--t-mono); color: var(--c-text-dim); }
`;

export function installStyles(): void {
  const style = document.createElement('style');
  style.textContent = themeCssVariables() + CSS;
  document.head.append(style);
}
