export const EDGE_TYPES = ["next", "contain", "reference"] as const;

export function getEdgeTypes(): string[] {
  return [...EDGE_TYPES];
}

export function getDefaultEdgeType(): string {
  return "next";
}
