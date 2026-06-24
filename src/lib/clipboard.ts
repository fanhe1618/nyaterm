import { invoke } from "./invoke";

export type ClipboardPathPayload =
  | { kind: "file_paths"; paths: string[] }
  | { kind: "image_file"; path: string };

export interface RemoteClipboardImagePayload {
  remote_path: string;
}

export async function readClipboardText(): Promise<string> {
  const text = await invoke<string | null>("read_clipboard_text");
  return text ?? "";
}

export async function readClipboardPathPayload(): Promise<ClipboardPathPayload | null> {
  return invoke<ClipboardPathPayload | null>("read_clipboard_path_payload");
}

export async function uploadClipboardImageToSsh(
  sessionId: string,
): Promise<RemoteClipboardImagePayload | null> {
  return invoke<RemoteClipboardImagePayload | null>("upload_clipboard_image_to_ssh", {
    sessionId,
    remoteDir: null,
  });
}
