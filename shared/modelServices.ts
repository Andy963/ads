export const MODEL_SERVICES = ["conversation", "transcription", "correction"] as const;
export type ModelService = typeof MODEL_SERVICES[number];

export interface ModelServiceSelection {
  service: ModelService;
  modelIds: string[];
  defaultModelId: string | null;
}
