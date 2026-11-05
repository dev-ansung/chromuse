// The camera button's driver wired to the real app: the browser's fetch and the shared store.

import { APP_CONFIG } from "./app-config.ts";
import { dispatch } from "./browser-store.ts";
import { createLiveDriver } from "./live-feed.ts";

export const liveDriver = createLiveDriver({
  fetchImpl: (url, init) => fetch(url, init),
  url: `${APP_CONFIG.apiPath}/live/snapshot`,
  dispatch,
});
