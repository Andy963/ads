import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { link, mkdir, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { Input } from "../agents/protocol/types.js";
import { detectImageInfo } from "../attachments/images.js";
import { resolveWorkspaceStatePath } from "../workspace/adsPaths.js";
import type { NativeChatMessage, NativeImageReference } from "./openAiCompatibleClient.js";

const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
export const MAX_NATIVE_REQUEST_IMAGE_BYTES = 50 * 1024 * 1024;

export class NativeImageInputError extends Error {
  readonly code = "NATIVE_IMAGE_INPUT_INVALID";

  constructor(detail: string) {
    super(`Native image input: ${detail}`);
    this.name = "NativeImageInputError";
  }
}

async function readImageFile(filePath: string, signal: AbortSignal): Promise<Buffer> {
  signal.throwIfAborted();
  let handle;
  try {
    // Nonblocking open also prevents a malicious FIFO from hanging the turn.
    handle = await open(filePath, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_IMAGE_BYTES) {
      throw new NativeImageInputError("each image must be a regular file between 1 byte and 25 MiB.");
    }
    const bytes = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      signal.throwIfAborted();
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, null);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset !== stat.size) throw new NativeImageInputError("the image changed while being read; attach it again.");
    return bytes.subarray(0, offset);
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof NativeImageInputError) throw error;
    throw new NativeImageInputError("the image file is unavailable; attach it again.");
  } finally {
    await handle?.close();
  }
}

function imageMetadata(bytes: Buffer): Pick<NativeImageReference, "mediaType" | "width" | "height"> {
  const info = detectImageInfo(bytes);
  if (info) return { mediaType: info.contentType, width: info.width, height: info.height };
  const signature = bytes.subarray(0, 6).toString("ascii");
  if (bytes.length >= 13 && (signature === "GIF87a" || signature === "GIF89a")) {
    const width = bytes.readUInt16LE(6);
    const height = bytes.readUInt16LE(8);
    if (width > 0 && height > 0 && width <= 20_000 && height <= 20_000) {
      return { mediaType: "image/gif", width, height };
    }
  }
  throw new NativeImageInputError("unsupported or invalid image; use PNG, JPEG, WebP, or GIF.");
}

function extension(mediaType: string): string {
  switch (mediaType) {
    case "image/png": return "png";
    case "image/jpeg": return "jpg";
    case "image/webp": return "webp";
    case "image/gif": return "gif";
    default: throw new NativeImageInputError("invalid stored image type; attach it again.");
  }
}

export class NativeImageStore {
  private readonly memory = new Map<string, Buffer>();

  constructor(private readonly workspaceRoot: string, private readonly durable: boolean) {}

  private storagePath(image: NativeImageReference): string {
    if (!/^[a-f0-9]{64}$/.test(image.sha256)) {
      throw new NativeImageInputError("invalid stored image reference; attach it again.");
    }
    return resolveWorkspaceStatePath(this.workspaceRoot,
      "attachments", image.sha256.slice(0, 2), `${image.sha256}.${extension(image.mediaType)}`);
  }

  async prepare(input: Input, workingDirectory: string, signal: AbortSignal): Promise<NativeChatMessage["content"]> {
    if (typeof input === "string") return input;
    if (!input.some(part => part.type === "local_image")) {
      return input.filter(part => part.type === "text").map(part => part.text).join("\n");
    }
    const content: Exclude<NativeChatMessage["content"], string | null> = [];
    let totalBytes = 0;
    for (const part of input) {
      signal.throwIfAborted();
      if (part.type === "text") {
        content.push({ type: "text", text: part.text });
        continue;
      }
      const bytes = await readImageFile(path.resolve(workingDirectory, part.path), signal);
      totalBytes += bytes.length;
      if (totalBytes > MAX_NATIVE_REQUEST_IMAGE_BYTES) {
        throw new NativeImageInputError("the combined images exceed 50 MiB; send fewer or smaller images.");
      }
      const image: NativeImageReference = {
        type: "image_ref",
        sha256: createHash("sha256").update(bytes).digest("hex"),
        ...imageMetadata(bytes),
      };
      if (this.durable) {
        const destination = this.storagePath(image);
        await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
        const staging = await mkdtemp(path.join(path.dirname(destination), ".native-image-"));
        try {
          const stagedFile = path.join(staging, "image");
          await writeFile(stagedFile, bytes, { flag: "wx", mode: 0o600, signal });
          signal.throwIfAborted();
          // Publish complete bytes atomically without overwriting a shared attachment.
          try {
            await link(stagedFile, destination);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
            const existing = await readImageFile(destination, signal);
            if (!existing.equals(bytes)) throw new NativeImageInputError("stored image integrity check failed.");
          }
        } finally {
          await rm(staging, { recursive: true, force: true });
        }
      } else {
        this.memory.set(image.sha256, bytes);
      }
      content.push(image);
    }
    return content;
  }

  async read(image: NativeImageReference, signal: AbortSignal): Promise<Buffer> {
    const source = this.storagePath(image);
    signal.throwIfAborted();
    const bytes = this.durable ? await readImageFile(source, signal) : this.memory.get(image.sha256);
    if (!bytes) throw new NativeImageInputError("the stored image is unavailable; attach it again.");
    if (createHash("sha256").update(bytes).digest("hex") !== image.sha256) {
      throw new NativeImageInputError("stored image integrity check failed.");
    }
    if (imageMetadata(bytes).mediaType !== image.mediaType) {
      throw new NativeImageInputError("stored image type does not match its contents.");
    }
    return bytes;
  }

  clearMemory(): void {
    this.memory.clear();
  }

  retain(messages: NativeChatMessage[]): void {
    const used = new Set(messages.flatMap(message => Array.isArray(message.content)
      ? message.content.filter(part => part.type === "image_ref").map(part => part.sha256)
      : []));
    for (const sha256 of this.memory.keys()) {
      if (!used.has(sha256)) this.memory.delete(sha256);
    }
  }
}
