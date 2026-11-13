// Loaded by the smoke page. Exposes page-side test functions on window.T.
import * as phase2 from './phase2.page.ts';

const T = { phase2, ready: true };
export type Harness = typeof T;
(window as unknown as { T: Harness }).T = T;
