/** Shared prompt submission path for the composer and message retry. */
import type { ChatTurn } from "../../shared/types";
import { request } from "../rpc-client";
import { useChatStore } from "../stores/chat-store";

export interface SubmitPromptOptions {
  threadId: string;
  text: string;
  referencedFiles?: string[];
  images?: Array<{ mimeType: string; base64Data: string; name: string }>;
}

export async function submitPrompt(options: SubmitPromptOptions): Promise<void> {
  const attachments: ChatTurn["attachments"] = [
    ...(options.referencedFiles ?? []).map((path) => ({
      name: path.split("/").pop() ?? path,
      path,
      mimeType: "text/plain",
    })),
    ...(options.images ?? []).map((image) => ({
      name: image.name,
      path: image.name,
      mimeType: image.mimeType,
    })),
  ];
  useChatStore
    .getState()
    .appendUserTurn(options.threadId, options.text, attachments.length ? attachments : undefined);
  await request("sendPrompt", {
    threadId: options.threadId,
    text: options.text,
    referencedFiles: options.referencedFiles,
    images: options.images?.map(({ mimeType, base64Data }) => ({ mimeType, base64Data })),
  });
}
