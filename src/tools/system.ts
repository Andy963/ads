import { getAllWorkflowTemplates, getAllNodeTypes } from "../graph/workflowConfig.js";
import { getEdgeTypes } from "../graph/edgeTypes.js";
import { safeStringify } from "../utils/json.js";

export async function getSystemInfo(): Promise<string> {
  try {
    const nodeTypes = getAllNodeTypes().map((node) => node.key);
    const templates = Object.keys(getAllWorkflowTemplates());

    return safeStringify({
      name: "AD Assistant",
      version: "1.0.0",
      description: "AI-Driven Specification 开发协作系统",
      capabilities: {
        rules: {
          categories: ["architecture", "code", "security", "test", "tech", "business"],
          supports_global_rules: true,
          supports_workspace_rules: true,
        },
        workflow: {
          node_types: nodeTypes,
          templates,
        },
        graph: {
          supports_nodes: true,
          supports_edges: true,
          supports_draft_finalized: true,
          edge_types: getEdgeTypes(),
        },
      },
      mcp: {
        protocol_version: "1.0",
        tools: [
          "read_rules",
          "list_rules",
          "list_workflow_templates",
          "get_workflow_template",
          "get_node_type_config",
          "get_workspace_info",
          "list_nodes",
          "get_node",
          "get_node_context",
          "create_node",
          "update_node",
          "create_edge",
          "finalize_node",
          "get_system_info",
        ],
      },
    });
  } catch (error) {
    return safeStringify({ error: (error as Error).message });
  }
}
