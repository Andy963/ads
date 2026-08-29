export interface ApiClientOptions {
  baseUrl?: string;
}

export class ApiClient {
  private readonly baseUrl: string;

  constructor(options?: ApiClientOptions) {
    this.baseUrl = (options?.baseUrl ?? "").replace(/\/+$/g, "");
  }

  private buildUrl(path: string): string {
    const cleaned = path.startsWith("/") ? path : `/${path}`;
    return `${this.baseUrl}${cleaned}`;
  }

  private async readResponseText(res: Response): Promise<string> {
    try {
      return await res.text();
    } catch {
      return "";
    }
  }

  private truncateBodySnippet(raw: string, maxLen = 400): string {
    const text = String(raw ?? "");
    if (text.length <= maxLen) return text;
    return text.slice(0, maxLen) + "...";
  }

  private parseErrorMessage(raw: string): string | null {
    const trimmed = String(raw ?? "").trim();
    if (!trimmed) return null;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (typeof parsed === "string") {
        return parsed.trim() || null;
      }
      if (parsed && typeof parsed === "object") {
        const record = parsed as { error?: unknown; message?: unknown };
        for (const value of [record.error, record.message]) {
          if (typeof value === "string" && value.trim()) {
            return value.trim();
          }
        }
      }
    } catch {
      // Non-JSON responses, such as an intermediary HTML error page, are not user-facing API messages.
    }
    return null;
  }

  private httpErrorMessage(res: Response): string {
    const statusText = String(res.statusText ?? "").trim();
    return statusText ? `HTTP ${res.status} ${statusText}` : `HTTP ${res.status}`;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    const url = this.buildUrl(path);
    const res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: "include",
    });
    if (!res.ok) {
      const text = await this.readResponseText(res);
      const message = this.parseErrorMessage(text) ?? this.httpErrorMessage(res);
      throw new Error(message, { cause: { method, path, url, status: res.status } });
    }
    const text = await this.readResponseText(res);
    const trimmed = text.trim();
    if (!trimmed) {
      throw new Error("Empty response body", { cause: { method, path, url, status: res.status } });
    }
    try {
      return JSON.parse(trimmed) as T;
    } catch (error) {
      throw new Error(`Invalid JSON response: ${error instanceof Error ? error.message : String(error)}`, {
        cause: { method, path, url, status: res.status, body: this.truncateBodySnippet(trimmed) },
      });
    }
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>("GET", path);
  }

  post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("POST", path, body);
  }

  patch<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("PATCH", path, body);
  }

  delete<T>(path: string): Promise<T> {
    return this.request<T>("DELETE", path);
  }
}
