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
      const message = text.trim() || `HTTP ${res.status}`;
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

  put<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("PUT", path, body);
  }

  delete<T>(path: string): Promise<T> {
    return this.request<T>("DELETE", path);
  }
}
