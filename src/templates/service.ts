import path from "node:path";

import { z } from "zod";

import { TemplateLoader } from "./loader.js";
import { TemplateRenderer } from "./renderer.js";
import { detectWorkspace } from "../workspace/detector.js";
import { createNode, createEdge } from "../graph/crud.js";
import { generateNodeId } from "../graph/workflowConfig.js";
import { saveNodeToFile } from "../graph/fileManager.js";
import { parseJsonWithSchema, safeStringify } from "../utils/json.js";
import { getErrorMessage } from "../utils/error.js";

const variablesSchema = z.record(z.unknown());

function parseVariables(payload?: string): Record<string, unknown> {
  if (!payload) {
    return {};
  }
  return parseJsonWithSchema(payload, variablesSchema);
}

export async function listTemplates(params: { workspace_path?: string }): Promise<string> {
  try {
    const workspace = params.workspace_path ? path.resolve(params.workspace_path) : detectWorkspace();
    const templates = TemplateLoader.listWorkspaceTemplates(workspace);
    return safeStringify({
      workspace,
      templates,
      node_template_count: templates.node_templates.length,
      workflow_template_count: templates.workflow_templates.length,
    });
  } catch (error) {
    return safeStringify({ error: getErrorMessage(error) });
  }
}

export async function getNodeTemplateDetails(params: {
  template_name: string;
  workspace_path?: string;
}): Promise<string> {
  try {
    const workspace = params.workspace_path ? path.resolve(params.workspace_path) : detectWorkspace();
    const template = TemplateLoader.getNodeTemplate(workspace, params.template_name);
    if (!template) {
      return safeStringify({ error: `模板不存在: ${params.template_name}` });
    }

    return safeStringify({
      name: template.name,
      node_type: template.nodeType,
      title_template: template.titleTemplate,
      content_template: template.contentTemplate,
      variables: template.variables,
      metadata: template.metadata,
      file_path: template.filePath,
    });
  } catch (error) {
    return safeStringify({ error: getErrorMessage(error) });
  }
}

export async function getWorkflowTemplateDetails(params: {
  template_name: string;
  workspace_path?: string;
}): Promise<string> {
  try {
    const workspace = params.workspace_path ? path.resolve(params.workspace_path) : detectWorkspace();
    const template = TemplateLoader.getWorkflowTemplate(workspace, params.template_name);
    if (!template) {
      return safeStringify({ error: `模板不存在: ${params.template_name}` });
    }

    return safeStringify(template);
  } catch (error) {
    return safeStringify({ error: getErrorMessage(error) });
  }
}

export async function renderTemplate(params: {
  template_content: string;
  variables: string;
}): Promise<string> {
  try {
    const variables = parseVariables(params.variables);
    const rendered = TemplateRenderer.render(params.template_content, variables);
    return safeStringify({
      success: true,
      rendered_content: rendered,
    });
  } catch (error) {
    return safeStringify({ success: false, error: getErrorMessage(error) });
  }
}

export async function validateTemplate(params: {
  template_content: string;
  variables?: string;
}): Promise<string> {
  try {
    const variables = parseVariables(params.variables);
    const result = TemplateRenderer.validate(params.template_content, variables);
    return safeStringify(result);
  } catch (error) {
    return safeStringify({ valid: false, error: getErrorMessage(error) });
  }
}

export async function createNodeFromTemplate(params: {
  workspace_path: string;
  template_name: string;
  variables: string;
  parent_id?: string;
  status?: string;
}): Promise<string> {
  try {
    const workspace = path.resolve(params.workspace_path);
    const variables = parseVariables(params.variables);
    const template = TemplateLoader.getNodeTemplate(workspace, params.template_name);
    if (!template) {
      return safeStringify({ error: `模板不存在: ${params.template_name}` });
    }

    const nodeId = generateNodeId(template.nodeType);
    const title = TemplateRenderer.render(template.titleTemplate, variables);
    const content = TemplateRenderer.render(template.contentTemplate, variables);
    const isDraft = params.status !== "finalized";

    const node = createNode({
      id: nodeId,
      type: template.nodeType,
      label: title,
      content,
      metadata: template.metadata ?? {},
      isDraft,
    });

    if (params.parent_id) {
      createEdge({
        id: `edge_${params.parent_id}_${nodeId}`,
        source: params.parent_id,
        target: nodeId,
        edgeType: "next",
      });
    }

    const filePath = saveNodeToFile(node, workspace);

    return safeStringify({
      success: true,
      node: {
        id: node.id,
        type: node.type,
        label: node.label,
        content: node.content,
        status: node.isDraft ? "draft" : "finalized",
      },
      file: filePath,
    });
  } catch (error) {
    return safeStringify({ success: false, error: getErrorMessage(error) });
  }
}
