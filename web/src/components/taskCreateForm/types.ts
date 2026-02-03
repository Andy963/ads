export type UploadedImageAttachment = {
  id: string;
  url: string;
  sha256: string;
  width: number;
  height: number;
  contentType: string;
  sizeBytes: number;
};

export type LocalAttachment = {
  localId: string;
  file: File;
  previewUrl: string;
  status: "uploading" | "ready" | "error";
  progress: number;
  error?: string;
  uploaded?: UploadedImageAttachment;
  xhr?: XMLHttpRequest;
};

export type VoiceStatusKind = "idle" | "recording" | "transcribing" | "error" | "ok";

export type TranscriptionResponse = { ok?: boolean; text?: string; error?: string; message?: string };

