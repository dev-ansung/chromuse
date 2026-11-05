import { Client } from "@langchain/langgraph-sdk";
import { APP_CONFIG } from "./app-config.ts";

/** LangGraph SDK client for the dev server, reached through the same-origin proxy. */
export const client = new Client({ apiUrl: new URL(APP_CONFIG.apiPath, window.location.href).href });
