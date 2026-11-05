// Entry point for `langgraph dev` (graph "agent" in langgraph.json). Thin: reads config, builds model + tools, exports the graph.

import { ChatOpenAI } from "@langchain/openai";
import { buildAgent } from "./agent.js";
import { buildConfig } from "./config.js";
import { sharedDocuments, sharedPlaybooks, sharedRuntime } from "./shared.js";

const { config, apiKey, systemPrompt, tabsTemplate, memoryTemplate, playbooksTemplate, reflectPrompt, templates } = buildConfig();

// The MCP server starts here, but Chrome is only touched on the first tool call (the attach step of each run).
const { telemetry, session } = sharedRuntime(config);
const tools = await session.agentTools(config.tools);

const model = new ChatOpenAI({
  model: config.model,
  apiKey,
  configuration: { baseURL: config.baseURL },
  maxTokens: config.maxTokens,
  reasoning: { effort: config.effort },
  useResponsesApi: config.api === "responses",
  maxRetries: 0, // retries handled (and traced) by modelRetryMiddleware
});

const memory = config.memory.enabled ? { documents: sharedDocuments(config, telemetry, templates), template: memoryTemplate } : undefined;
const playbooks = config.playbooks.enabled && memory ? { playbooks: sharedPlaybooks(config, telemetry), model, template: playbooksTemplate, reflectPrompt } : undefined;

export const graph = buildAgent({ model, tools, session, config, systemPrompt, tabsTemplate, memory, playbooks, telemetry });
