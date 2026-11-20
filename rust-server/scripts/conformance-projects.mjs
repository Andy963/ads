#!/usr/bin/env node
/**
 * Black-box project conformance: compare the TypeScript and Rust project APIs
 * against the same workspace allowlist and isolated state databases.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { assert, compare, loginAs, startServerPair } from "./lib/black-box.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, "../..");
const rustDir = path.join(root, "rust-server");
const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-project-conformance-"));
const projectA = path.join(workspaceDir, "proj-a");
const projectB = path.join(workspaceDir, "proj-b");
const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-project-outside-"));

function jsonRequest(method, body) {
  return {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

async function main() {
  fs.mkdirSync(projectA);
  fs.mkdirSync(projectB);
  const pair = await startServerPair({
    root,
    rustDir,
    env: { ALLOWED_DIRS: workspaceDir },
  });

  try {
    const nodeLogin = await loginAs(pair.nodeBase, "admin", "secret");
    const rustLogin = await loginAs(pair.rustBase, "admin", "secret");

    const nodeHeaders = { cookie: nodeLogin.cookie };
    const rustHeaders = { cookie: rustLogin.cookie };
    const withNode = (options = {}) => ({ ...options, headers: { ...nodeHeaders, ...(options.headers ?? {}) } });
    const withRust = (options = {}) => ({ ...options, headers: { ...rustHeaders, ...(options.headers ?? {}) } });

    async function compareBoth(label, pathname, options = {}) {
      await compare(
        label,
        await pair.nodeRequest(pathname, withNode(options)),
        await pair.rustRequest(pathname, withRust(options)),
        { maskKeys: ["createdAt", "updatedAt"] },
      );
    }

    await compareBoth("projects-empty", "/api/projects");
    await compareBoth("projects-create-a", "/api/projects", jsonRequest("POST", { path: projectA }));
    await compareBoth("projects-create-b", "/api/projects", jsonRequest("POST", { path: projectB }));
    await compareBoth("projects-list", "/api/projects");

    const nodeList = await pair.nodeRequest("/api/projects", withNode());
    const rustList = await pair.rustRequest("/api/projects", withRust());
    const projectAId = nodeList.body.projects.find((project) => project.name === "proj-a")?.id;
    const projectBId = nodeList.body.projects.find((project) => project.name === "proj-b")?.id;
    assert(projectAId && projectBId, "missing project ids in the typescript response");
    assert(
      JSON.stringify(rustList.body.projects.map((project) => project.id)) ===
        JSON.stringify(nodeList.body.projects.map((project) => project.id)),
      "project ids differ between typescript and rust",
    );

    await compareBoth(
      "projects-reorder",
      "/api/projects/reorder",
      jsonRequest("POST", { ids: [projectBId, projectAId] }),
    );
    await compareBoth("projects-list-after-reorder", "/api/projects");
    await compareBoth(
      "projects-update",
      `/api/projects/${projectBId}`,
      jsonRequest("PATCH", { name: "Renamed" }),
    );

    await compareBoth(
      "projects-active-null",
      "/api/projects/active",
      jsonRequest("PATCH", { projectId: null }),
    );
    await compareBoth("projects-list-after-active-null", "/api/projects");
    await compareBoth(
      "projects-active-set",
      "/api/projects/active",
      jsonRequest("PATCH", { projectId: projectBId }),
    );
    await compareBoth("projects-delete", `/api/projects/${projectBId}`, { method: "DELETE" });
    await compareBoth("projects-delete-missing", "/api/projects/missing", { method: "DELETE" });

    await compareBoth(
      "projects-create-outside",
      "/api/projects",
      jsonRequest("POST", { path: outsideDir }),
    );
    await compareBoth("projects-create-empty", "/api/projects", jsonRequest("POST", { path: "" }));
    await compareBoth("projects-active-missing", "/api/projects/active", jsonRequest("PATCH", {}));
    await compareBoth(
      "projects-update-missing",
      "/api/projects/missing",
      jsonRequest("PATCH", { name: "Nope" }),
    );

    console.log("[conformance] project contract matched");
  } finally {
    await pair.stop();
    fs.rmSync(workspaceDir, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  }
}

await main();
