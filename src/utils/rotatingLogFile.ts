import fs from "node:fs";
import path from "node:path";

export interface RotatingLogFileOptions {
  maxBytes: number;
  mode?: number;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function statSizeOrZero(filePath: string): number {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

function openAppendStream(filePath: string, mode: number): fs.WriteStream {
  const stream = fs.createWriteStream(filePath, { flags: "a", mode });
  try {
    fs.chmodSync(filePath, mode);
  } catch {
    // ignore
  }
  return stream;
}

function resolveRotationIndex(dir: string, baseName: string, ext: string): number {
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return 0;
  }

  const baseEscaped = escapeRegExp(baseName);
  const extEscaped = escapeRegExp(ext);
  const pattern = new RegExp(`^${baseEscaped}\\.(\\d+)${extEscaped}$`);

  let max = 0;
  for (const entry of entries) {
    const match = pattern.exec(entry);
    if (!match) continue;
    const num = Number.parseInt(match[1] ?? "", 10);
    if (Number.isFinite(num) && num > max) {
      max = num;
    }
  }
  return max;
}

function buildRotatedPath(basePath: string, index: number): string {
  const dir = path.dirname(basePath);
  const ext = path.extname(basePath);
  const base = path.basename(basePath, ext);
  const rotatedName = ext ? `${base}.${index}${ext}` : `${base}.${index}`;
  return path.join(dir, rotatedName);
}

export class RotatingLogFile {
  private readonly basePath: string;
  private readonly maxBytes: number;
  private readonly mode: number;
  private rotationIndex: number;
  private currentPath: string;
  private currentBytes: number;
  private stream: fs.WriteStream;
  private closed = false;
  private readonly pendingCloses: Array<Promise<void>> = [];

  constructor(basePath: string, options: RotatingLogFileOptions) {
    this.basePath = path.resolve(basePath);
    this.maxBytes = Math.max(0, Math.floor(options.maxBytes));
    this.mode = options.mode ?? 0o600;

    const dir = path.dirname(this.basePath);
    fs.mkdirSync(dir, { recursive: true });

    const ext = path.extname(this.basePath);
    const base = path.basename(this.basePath, ext);
    this.rotationIndex = resolveRotationIndex(dir, base, ext);

    const baseSize = statSizeOrZero(this.basePath);
    if (this.maxBytes > 0 && baseSize >= this.maxBytes) {
      this.rotationIndex += 1;
      this.currentPath = buildRotatedPath(this.basePath, this.rotationIndex);
      this.currentBytes = statSizeOrZero(this.currentPath);
      this.stream = openAppendStream(this.currentPath, this.mode);
      return;
    }

    this.currentPath = this.basePath;
    this.currentBytes = baseSize;
    this.stream = openAppendStream(this.currentPath, this.mode);
  }

  get path(): string {
    return this.currentPath;
  }

  write(line: string): void {
    if (this.closed) {
      return;
    }
    const payload = String(line);
    const bytes = Buffer.byteLength(payload, "utf8");
    if (this.maxBytes > 0 && this.currentBytes + bytes > this.maxBytes) {
      this.rotate();
    }
    this.stream.write(payload);
    this.currentBytes += bytes;
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.stream.end();
  }

  async closeAsync(): Promise<void> {
    if (this.closed) {
      await Promise.allSettled(this.pendingCloses);
      return;
    }
    this.closed = true;
    const current = this.endStream(this.stream);
    await Promise.allSettled([...this.pendingCloses, current]);
  }

  private rotate(): void {
    const previous = this.stream;
    this.pendingCloses.push(this.endStream(previous));

    this.rotationIndex += 1;
    this.currentPath = buildRotatedPath(this.basePath, this.rotationIndex);
    this.currentBytes = statSizeOrZero(this.currentPath);
    this.stream = openAppendStream(this.currentPath, this.mode);
  }

  private endStream(stream: fs.WriteStream): Promise<void> {
    return new Promise((resolve) => {
      const done = () => resolve();
      try {
        stream.once("error", done);
        stream.end(done);
      } catch {
        resolve();
      }
    });
  }
}
