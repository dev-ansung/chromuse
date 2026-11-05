// Interface text shown ABOVE each document. It is not part of the documents and is never sent to the model.

const DEFAULT_INFO = "A document the agent and you can both edit. This note is not part of the file.";

const INFO: Record<string, string> = {
  "SOUL.md":
    "This is the agent's persona: the values and habits it tries to hold to in every conversation. It starts from a template. The agent may refine it over time and tells you when it does. You can edit it at any time. This note is not part of the file.",
  "MEMORY.md":
    "This is the agent's long-term memory: durable facts and preferences it keeps about you, read at the start of every conversation. It reflects the agent's understanding and can be out of date. Edit anything here, or ask the agent to forget something. This note is not part of the file.",
};

export const docInfo = (path: string): string => INFO[path] ?? (path.startsWith("notes/") ? "A day's raw notes. The agent and you can both add to it. This note is not part of the file." : DEFAULT_INFO);
