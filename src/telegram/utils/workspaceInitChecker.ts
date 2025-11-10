import fs from "node:fs";
import path from "node:path";

export interface WorkspaceInitStatus {
  initialized: boolean;
  missingArtifact?: string;
  details?: string;
}

const REQUIRED_ARTIFACTS = [
  { relativePath: path.join(".ads", "workspace.json"), label: ".ads/workspace.json" },
  {
    relativePath: path.join(".ads", "templates", "instructions.md"),
    label: ".ads/templates/instructions.md",
  },
];

export function checkWorkspaceInit(targetDir: string): WorkspaceInitStatus {
  try {
    const normalized = path.resolve(targetDir);

    for (const artifact of REQUIRED_ARTIFACTS) {
      const artifactPath = path.join(normalized, artifact.relativePath);
      if (!fs.existsSync(artifactPath)) {
        return {
          initialized: false,
          missingArtifact: artifact.label,
          details: `missing ${artifact.label}`,
        };
      }
    }

    return { initialized: true };
  } catch (error) {
    return {
      initialized: false,
      missingArtifact: "unknown",
      details: error instanceof Error ? error.message : "unknown error",
    };
  }
}
