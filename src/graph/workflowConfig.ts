import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import yaml from "yaml";

export interface NodeTypeConfig {
  key: string;
  label: string;
  prefix: string;
  next_types: string[];
  color: string;
  icon: string;
  description?: string;
  ai_prompt_template?: string;
}

export interface WorkflowStepOption {
  node_type: string;
  label: string;
  description: string;
}

export interface WorkflowStep {
  step_number: number;
  label: string;
  required: boolean;
  options: WorkflowStepOption[];
  default_option?: string;
}

export interface WorkflowTemplateConfig {
  key: string;
  name: string;
  description: string;
  icon: string;
  steps: WorkflowStep[];
}

interface WorkflowRulesFile {
  node_types?: Record<string, NodeTypeConfig>;
  connection_rules?: Record<string, string[]>;
  workflow_templates?: Record<string, WorkflowTemplateConfig>;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..", "..");

function loadYamlFile(filePath: string): WorkflowRulesFile {
  const content = fs.readFileSync(filePath, "utf-8");
  return (yaml.parse(content) ?? {}) as WorkflowRulesFile;
}

function resolveConfigPath(): string {
  const envPath = process.env.ADS_CONFIG_PATH;
  if (envPath && fs.existsSync(envPath)) {
    return envPath;
  }

  const fallbackPaths = [
    // When running from source (tsx/dev) or tests
    path.join(PROJECT_ROOT, "src", "graph", "config.yaml"),
    // When running compiled code from dist, hop back to repo src
    path.join(PROJECT_ROOT, "..", "src", "graph", "config.yaml"),
    path.join(PROJECT_ROOT, "ads", "graph", "config.yaml"),
    path.join(PROJECT_ROOT, "..", "ads", "graph", "config.yaml"),
    path.join(PROJECT_ROOT, "graph", "config.yaml"),
  ];

  for (const candidate of fallbackPaths) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    "无法找到工作流配置文件。请设置 ADS_CONFIG_PATH 指向 config.yaml，或确保构建产物包含 dist/src/graph/config.yaml，或仓库存在 src/graph/config.yaml",
  );
}

class WorkflowRulesConfigSingleton {
  private static instance: WorkflowRulesConfigSingleton | null = null;

  static getInstance(): WorkflowRulesConfigSingleton {
    if (!WorkflowRulesConfigSingleton.instance) {
      WorkflowRulesConfigSingleton.instance = new WorkflowRulesConfigSingleton();
    }
    return WorkflowRulesConfigSingleton.instance;
  }

  readonly nodeTypes: Map<string, NodeTypeConfig> = new Map();
  readonly connectionRules: Map<string, string[]> = new Map();
  readonly workflowTemplates: Map<string, WorkflowTemplateConfig> = new Map();

  private constructor() {
    const configData = this.loadConfiguration();

    if (configData.node_types) {
      for (const [key, value] of Object.entries(configData.node_types)) {
        this.nodeTypes.set(key, value);
      }
    }

    if (configData.connection_rules) {
      for (const [key, value] of Object.entries(configData.connection_rules)) {
        this.connectionRules.set(key, value);
      }
    }

    if (configData.workflow_templates) {
      for (const [key, value] of Object.entries(configData.workflow_templates)) {
        this.workflowTemplates.set(key, value);
      }
    }
  }

  private loadConfiguration(): WorkflowRulesFile {
    const configPath = resolveConfigPath();
    return loadYamlFile(configPath);
  }

  getNodeTypeConfig(nodeType: string): NodeTypeConfig | undefined {
    return this.nodeTypes.get(nodeType);
  }

  getAllNodeTypes(): NodeTypeConfig[] {
    return Array.from(this.nodeTypes.values());
  }

  getConnectionRules(nodeType: string): string[] {
    return this.connectionRules.get(nodeType) ?? [];
  }

  getAllConnectionRules(): Record<string, string[]> {
    return Object.fromEntries(this.connectionRules.entries());
  }

  getWorkflowTemplate(templateKey: string): WorkflowTemplateConfig | undefined {
    return this.workflowTemplates.get(templateKey);
  }

  getAllWorkflowTemplates(): Record<string, WorkflowTemplateConfig> {
    return Object.fromEntries(this.workflowTemplates.entries());
  }
}

export function getWorkflowConfig(): WorkflowRulesConfigSingleton {
  return WorkflowRulesConfigSingleton.getInstance();
}

export function getNodeTypeConfig(nodeType: string): NodeTypeConfig | undefined {
  return getWorkflowConfig().getNodeTypeConfig(nodeType);
}

export function getAllNodeTypes(): NodeTypeConfig[] {
  return getWorkflowConfig().getAllNodeTypes();
}

export function getWorkflowTemplate(templateKey: string): WorkflowTemplateConfig | undefined {
  return getWorkflowConfig().getWorkflowTemplate(templateKey);
}

export function getAllWorkflowTemplates(): Record<string, WorkflowTemplateConfig> {
  return getWorkflowConfig().getAllWorkflowTemplates();
}

export function getConnectionRules(nodeType: string): string[] {
  return getWorkflowConfig().getConnectionRules(nodeType);
}

export function getAllConnectionRules(): Record<string, string[]> {
  return getWorkflowConfig().getAllConnectionRules();
}

export function generateNodeId(nodeType: string): string {
  const config = getNodeTypeConfig(nodeType);
  const prefix = config?.prefix ?? "node";
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let random = "";
  for (let i = 0; i < 8; i += 1) {
    random += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }
  return `${prefix}_${random}`;
}

export function getNodeTypeLabel(nodeType: string): string | null {
  const config = getNodeTypeConfig(nodeType);
  return config?.label ?? null;
}
