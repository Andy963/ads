import fs from "node:fs";
import path from "node:path";

import yaml from "yaml";

export interface NodeTemplate {
  name: string;
  nodeType: string;
  titleTemplate: string;
  contentTemplate: string;
  variables: string[];
  metadata: Record<string, unknown>;
  filePath: string;
}

export interface WorkflowTemplate {
  name: string;
  title: string;
  description: string;
  nodes: Array<Record<string, unknown>>;
  edges: Array<Record<string, unknown>>;
  filePath: string;
}

function exists(target: string): boolean {
  return fs.existsSync(target);
}

function readYamlFile(filePath: string): unknown {
  const content = fs.readFileSync(filePath, "utf-8");
  return yaml.parse(content);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string");
}

function parseMarkdownVariables(content: string): string[] {
  const matches = content.match(/\{\{(\w+)\}\}/g) ?? [];
  const unique: string[] = [];
  for (const match of matches) {
    const variable = match.replace(/[{}]/g, "");
    if (!unique.includes(variable)) {
      unique.push(variable);
    }
  }
  return unique;
}

function parseNodeTemplateYaml(filePath: string): NodeTemplate {
  const raw = readYamlFile(filePath);
  const data = isRecord(raw) ? raw : {};
  const metadata = isRecord(data.metadata) ? (data.metadata as Record<string, unknown>) : {};
  const contentTemplate = typeof data.content === "string" ? data.content : "";
  const titleTemplate = typeof data.title === "string" ? data.title : "{{title}}";
  const nodeType = typeof data.node_type === "string" ? data.node_type : "default";
  const name = typeof data.name === "string" ? data.name : path.basename(filePath, path.extname(filePath));

  return {
    name,
    nodeType,
    titleTemplate,
    contentTemplate,
    variables: toStringArray(data.variables),
    metadata,
    filePath,
  };
}

function parseNodeTemplateMarkdown(filePath: string): NodeTemplate {
  const content = fs.readFileSync(filePath, "utf-8");
  return {
    name: path.basename(filePath, path.extname(filePath)),
    nodeType: path.basename(filePath, path.extname(filePath)),
    titleTemplate: "{{title}}",
    contentTemplate: content,
    variables: parseMarkdownVariables(content),
    metadata: {},
    filePath,
  };
}

function parseWorkflowTemplateYaml(filePath: string): WorkflowTemplate {
  const raw = readYamlFile(filePath);
  const data = isRecord(raw) ? raw : {};
  const name = typeof data.name === "string" ? data.name : path.basename(filePath, path.extname(filePath));
  const title = typeof data.title === "string" ? data.title : "";
  const description = typeof data.description === "string" ? data.description : "";
  const nodes = Array.isArray(data.nodes)
    ? data.nodes.filter((node): node is Record<string, unknown> => isRecord(node))
    : [];
  const edges = Array.isArray(data.edges)
    ? data.edges.filter((edge): edge is Record<string, unknown> => isRecord(edge))
    : [];

  return {
    name,
    title,
    description,
    nodes,
    edges,
    filePath,
  };
}

export class TemplateLoader {
  constructor(private readonly root: string) {}

  private candidateDirectories(): string[] {
    const base = this.root;
    return [
      path.join(base, ".ads", "templates"),
      path.join(base, "templates"),
      base,
    ];
  }

  static listWorkspaceTemplates(workspace: string): {
    node_templates: NodeTemplate[];
    workflow_templates: WorkflowTemplate[];
  } {
    const loader = new TemplateLoader(workspace);
    return {
      node_templates: loader.loadNodeTemplates(),
      workflow_templates: loader.loadWorkflowTemplates(),
    };
  }

  loadTemplate(templateName: string): NodeTemplate | string | null {
    for (const directory of this.candidateDirectories()) {
      if (!exists(directory)) {
        continue;
      }

      const yamlPath = path.join(directory, `${templateName}.yaml`);
      if (exists(yamlPath)) {
        return parseNodeTemplateYaml(yamlPath);
      }

      const mdPath = path.join(directory, `${templateName}.md`);
      if (exists(mdPath)) {
        return fs.readFileSync(mdPath, "utf-8");
      }
    }
    return null;
  }

  listTemplates(): Array<{ name: string; type: string; path: string }> {
    const templates: Array<{ name: string; type: string; path: string }> = [];
    const seen = new Set<string>();

    for (const directory of this.candidateDirectories()) {
      if (!exists(directory)) {
        continue;
      }

      for (const entry of fs.readdirSync(directory)) {
        const ext = path.extname(entry).toLowerCase();
        if (ext !== ".yaml" && ext !== ".md") {
          continue;
        }

        const name = path.basename(entry, ext);
        if (seen.has(name)) {
          continue;
        }

        seen.add(name);
        templates.push({
          name,
          type: ext === ".yaml" ? "yaml" : "markdown",
          path: path.join(directory, entry),
        });
      }
    }

    return templates;
  }

  loadNodeTemplates(): NodeTemplate[] {
    const templatesDir = path.join(this.root, ".ads", "templates");
    if (!exists(templatesDir)) {
      return [];
    }

    const results: NodeTemplate[] = [];
    for (const entry of fs.readdirSync(templatesDir)) {
      const fullPath = path.join(templatesDir, entry);
      if (!entry.endsWith(".md")) {
        continue;
      }
      if (entry.toLowerCase() === "rules.md") {
        continue;
      }
      try {
        results.push(parseNodeTemplateMarkdown(fullPath));
      } catch (error) {
        console.warn(`Failed to parse node template ${entry}: ${(error as Error).message}`);
      }
    }
    return results;
  }

  loadWorkflowTemplates(): WorkflowTemplate[] {
    const templatesDir = path.join(this.root, ".ads", "templates");
    if (!exists(templatesDir)) {
      return [];
    }

    const results: WorkflowTemplate[] = [];
    for (const entry of fs.readdirSync(templatesDir)) {
      if (!entry.endsWith(".yaml")) {
        continue;
      }
      const fullPath = path.join(templatesDir, entry);
      try {
        results.push(parseWorkflowTemplateYaml(fullPath));
      } catch (error) {
        console.warn(`Failed to parse workflow template ${entry}: ${(error as Error).message}`);
      }
    }
    return results;
  }

  static getNodeTemplate(workspace: string, templateName: string): NodeTemplate | null {
    const loader = new TemplateLoader(workspace);
    const templates = loader.loadNodeTemplates();
    return templates.find((tpl) => tpl.name === templateName) ?? null;
  }

  static getWorkflowTemplate(workspace: string, templateName: string): WorkflowTemplate | null {
    const loader = new TemplateLoader(workspace);
    const templates = loader.loadWorkflowTemplates();
    return templates.find((tpl) => tpl.name === templateName) ?? null;
  }
}
