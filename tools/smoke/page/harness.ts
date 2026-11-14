// Loaded by the smoke page. Exposes page-side test functions on window.T.
import * as phase2 from './phase2.page.ts';
import * as phase3 from './phase3.page.ts';
import * as phase5 from './phase5.page.ts';
import * as phase6 from './phase6.page.ts';
import * as phase7 from './phase7.page.ts';
import * as phase8 from './phase8.page.ts';
import * as phase9 from './phase9.page.ts';
import * as playback from './playback.page.ts';

const T = { phase2, phase3, phase5, phase6, phase7, phase8, phase9, playback, ready: true };
export type Harness = typeof T;
(window as unknown as { T: Harness }).T = T;
