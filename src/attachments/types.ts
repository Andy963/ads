export type AttachmentKind = "image";

export interface Attachment {
  id: string;
  taskId?: string | null;
  kind: AttachmentKind;
  filename: string | null;
  contentType: string;
  sizeBytes: number;
  width: number;
  height: number;
  sha256: string;
  storageKey: string;
  createdAt: number;
}

export interface ImageAttachmentResponse {
  id: string;
  url: string;
  sha256: string;
  width: number;
  height: number;
  contentType: string;
  sizeBytes: number;
}

export type ImageFormat = "png" | "jpeg" | "webp";

export interface ImageInfo {
  format: ImageFormat;
  contentType: "image/png" | "image/jpeg" | "image/webp";
  ext: "png" | "jpg" | "webp";
  width: number;
  height: number;
}
