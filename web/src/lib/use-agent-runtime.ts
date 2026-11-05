// The chat runtime: assistant-ui's LangGraph adapter, pointed at the "agent" graph. It converts LangChain messages
// (reasoning, tool calls, results) into chat parts itself; this file only wires threads, cancel and our custom events.

import { CompositeAttachmentAdapter, SimpleImageAttachmentAdapter } from "@assistant-ui/react";
import {
  unstable_createLangGraphStream,
  useLangGraphRuntime,
  type LangChainMessage,
} from "@assistant-ui/react-langgraph";
import { APP_CONFIG } from "./app-config.ts";
import { AudioTranscriptAttachmentAdapter } from "./audio-attachment.ts";
import { MuseDictationAdapter } from "./muse-dictation.ts";
import { dispatch } from "./browser-store.ts";
import { client } from "./client.ts";
import { documentsController } from "./documents.ts";
import { describeError, parseCustomEvent } from "./parse.ts";

// Images go to the model as they are (Muse Spark Open reads text and images). The model takes no audio, so voice and audio files
// are transcribed first (Muse Voice Transcribe, through the server) and arrive as text.
const adapters = {
  attachments: new CompositeAttachmentAdapter([new SimpleImageAttachmentAdapter(), new AudioTranscriptAttachmentAdapter()]),
  dictation: new MuseDictationAdapter((message) => dispatch({ type: "custom", event: { kind: "warning", message }, at: new Date().toISOString() })),
};

const stream = unstable_createLangGraphStream({ client, assistantId: APP_CONFIG.agentGraphId });

// Stable identity: the runtime memoizes on this object.
const eventHandlers = {
  onCustomEvent: (type: string, data: unknown) => {
    const event = parseCustomEvent(type, data);
    if (!event) return;
    if (event.kind === "memory_change") void documentsController.onAgentChange(event);
    else dispatch({ type: "custom", event, at: new Date().toISOString() });
  },
  onError: (error: unknown) => dispatch({ type: "run_failed", message: describeError(error) }),
};

export function useAgentRuntime() {
  return useLangGraphRuntime({
    unstable_allowCancellation: true,
    stream: (messages, config) => {
      dispatch({ type: "run_started" });
      return stream(messages, config);
    },
    create: async () => {
      const { thread_id } = await client.threads.create();
      return { externalId: thread_id };
    },
    load: async (externalId) => {
      const state = await client.threads.getState<{ messages: LangChainMessage[] }>(externalId);
      return { messages: state.values.messages ?? [], interrupts: state.tasks?.[0]?.interrupts };
    },
    adapters,
    eventHandlers,
  });
}
