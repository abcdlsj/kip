/** Shared prompt submission path for the composer and message retry. */
import type { ChatTurn, PromptDelivery } from "../../shared/types";
import { request } from "../rpc-client";
import { useChatStore } from "../stores/chat-store";
import { useUiStore } from "../stores/ui-store";

export interface SubmitPromptOptions {
  threadId: string;
  text: string;
  referencedFiles?: string[];
  images?: Array<{ mimeType: string; base64Data: string; name: string }>;
  /** Set when the thread is running; the message is queued instead of shown at once. */
  delivery?: PromptDelivery;
}

export async function submitPrompt(
  options: SubmitPromptOptions,
): Promise<void> {
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
  // A queued message appears in the transcript when the agent picks it up.
  if (!options.delivery) {
    useChatStore
      .getState()
      .appendUserTurn(
        options.threadId,
        options.text,
        attachments.length ? attachments : undefined,
      );
  }
  try {
    await request("sendPrompt", {
      threadId: options.threadId,
      text: options.text,
      referencedFiles: options.referencedFiles,
      images: options.images?.map(({ mimeType, base64Data }) => ({
        mimeType,
        base64Data,
      })),
      delivery: options.delivery,
    });
  } catch (error) {
    useChatStore
      .getState()
      .setError(
        options.threadId,
        error instanceof Error ? error.message : "Could not start the run",
      );
  }
}

/** Stops a run and puts any queued, undelivered messages back into the composer. */
export async function stopThread(threadId: string): Promise<void> {
  const restored = await useChatStore.getState().abort(threadId);
  if (!restored.length) return;
  const ui = useUiStore.getState();
  const current = ui.drafts[threadId] ?? "";
  ui.setDraft(
    threadId,
    [current, ...restored].filter((text) => text.trim()).join("\n\n"),
  );
}
