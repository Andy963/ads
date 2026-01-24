export interface ApiClientOptions {
  baseUrl?: string;
  token?: string;
}

export class ApiClient {
  private readonly baseUrl: string;
  private token: string;

  constructor(options?: ApiClientOptions) {
    this.baseUrl = (options?.baseUrl ?? "").replace(/\/+$/g, "");
    this.token = options?.token ?? "";
  }

  setToken(token: string): void {
    this.token = token;
  }

  private buildUrl(path: string): string {
    const cleaned = path.startsWith("/") ? path : `/${path}`;
    return `${this.baseUrl}${cleaned}`;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.token) {
      headers.Authorization = `Bearer ${this.token}`;
    }
    const res = await fetch(this.buildUrl(path), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(text || `HTTP ${res.status}`);
    }
    return (await res.json()) as T;
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
