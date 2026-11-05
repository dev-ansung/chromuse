// HTTP route for the camera button. Mounted by the LangGraph dev server next to its own API (langgraph.json -> http.app).
//   GET /live/snapshot    the open tabs + a screenshot of the selected one (see live.js for the response shape)

import { Hono } from "hono";

export function createLiveApp(feed) {
  const app = new Hono();
  app.get("/live/snapshot", async (c) => {
    const result = await feed.snapshot();
    c.header("Cache-Control", "no-store");
    return c.json(result, result.ok ? 200 : 503);
  });
  return app;
}
