// Audio files in the chat box: the file is transcribed (Muse Voice Transcribe, through the server) when the message is sent,
// and the model receives the transcript as text. The model itself takes no audio.

import type { AttachmentAdapter, CompleteAttachment, PendingAttachment } from "@assistant-ui/react";
import { transcribeAudio } from "./transcribe.ts";

const escapeName = (name: string) => name.replace(/"/g, "&quot;");

export class AudioTranscriptAttachmentAdapter implements AttachmentAdapter {
  accept = "audio/*";

  async add({ file }: { file: File }): Promise<PendingAttachment> {
    return { id: crypto.randomUUID(), type: "file", name: file.name, contentType: file.type, file, status: { type: "requires-action", reason: "composer-send" } };
  }

  async send(attachment: PendingAttachment): Promise<CompleteAttachment> {
    const text = (await transcribeAudio(attachment.file as File)).trim();
    return {
      ...attachment,
      status: { type: "complete" },
      content: [{ type: "text", text: `<audio-transcript name="${escapeName(attachment.name)}">\n${text || "(no speech was heard)"}\n</audio-transcript>` }],
    };
  }

  async remove() {}
}
