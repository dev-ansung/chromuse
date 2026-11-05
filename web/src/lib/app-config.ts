// Names of the graphs registered in server/langgraph.json, and where the dev server is reachable.
export const APP_CONFIG = {
  agentGraphId: "agent",
  connectGraphId: "connect",
  documentsGraphId: "documents",
  /** Same-origin path that vite proxies to the LangGraph dev server (see vite.config.ts). */
  apiPath: "/api",
  /** Frames kept for the live view's history (each is roughly 50-150 KB of base64). */
  maxScreenshots: 60,
} as const;
