declare module "@tavily/core" {
  export class TavilyClient {
    constructor(options: { apiKey: string });
    // The official SDK accepts a search payload and returns a Promise with results.
    // We keep the shape loose here to avoid coupling to SDK internals.
    search(params: Record<string, unknown>): Promise<Record<string, unknown>>;
  }
}
