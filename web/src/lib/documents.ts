// The Documents panel wired to the real server: the "documents" graph through the LangGraph SDK client.

import { APP_CONFIG } from "./app-config.ts";
import { client } from "./client.ts";
import { createDocumentsApi } from "./documents-api.ts";
import { createDocumentsController } from "./documents-controller.ts";
import { dispatchDocuments, getDocumentsState } from "./documents-store.ts";

const api = createDocumentsApi(async (input) => {
  const values = await client.runs.wait(null, APP_CONFIG.documentsGraphId, { input });
  return typeof values === "object" && values !== null ? (values as { result?: unknown }).result : undefined;
});

export const documentsApi = api;
export const documentsController = createDocumentsController({ api, dispatch: dispatchDocuments, getState: getDocumentsState });
