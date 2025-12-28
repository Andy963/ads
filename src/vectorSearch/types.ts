export interface VectorUpsertItem {
  id: string;
  text: string;
  metadata?: Record<string, unknown>;
}

export interface VectorQueryHit {
  id: string;
  score?: number;
  metadata?: Record<string, unknown>;
  snippet?: string;
  text?: string;
}

export interface VectorQueryResponse {
  ok: boolean;
  hits: VectorQueryHit[];
}

