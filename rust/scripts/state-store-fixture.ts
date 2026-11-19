import fs from "node:fs";
import path from "node:path";

import { legacyModulePath } from "./legacy-module-path.ts";

type Mode = "create" | "verify";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

async function openState(dbPath: string) {
  process.env.ADS_STATE_DB_PATH = dbPath;
  const { getStateDatabase } = await import(legacyModulePath("server/state/database.ts"));
  return getStateDatabase(dbPath);
}

async function create(dbPath: string) {
  const { ensureWebAuthTables } = await import(legacyModulePath("server/web/auth/schema.ts"));
  const { ensureWebProjectTables } = await import(legacyModulePath("server/web/projects/schema.ts"));
  const projectStore = await import(legacyModulePath("server/web/projects/store.ts"));
  const { createGlobalModelConfigStore } = await import(
    legacyModulePath("server/state/globalModelConfigStore.ts")
  );

  const db = await openState(dbPath);
  ensureWebAuthTables(db);
  ensureWebProjectTables(db);
  db.prepare(
    "INSERT OR REPLACE INTO web_users (id, username, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  ).run("user-ts", "ts-admin", "hash", 1, 1);

  const project = projectStore.upsertWebProject(
    db,
    {
      userId: "user-ts",
      projectId: "project-ts",
      workspaceRoot: "/work/ts-project",
      name: "TS Project",
      chatSessionId: "main",
    },
    1_700_000_000_000,
  );
  projectStore.setActiveWebProjectId(db, "user-ts", project.id, 1_700_000_000_000);

  const modelStore = createGlobalModelConfigStore(db);
  modelStore.upsertModelConfig(
    {
      id: "model-ts",
      modelId: "gpt-ts",
      displayName: "TS Model",
      provider: "openai",
      providerId: null,
      isEnabled: true,
      isDefault: true,
      configJson: {
        max_input_tokens: 8192,
        max_output_tokens: 4096,
        reasoningEfforts: ["HIGH", "low"],
        defaultReasoningEffort: "high",
      },
    },
    1_700_000_000_000,
  );

  console.log(
    JSON.stringify({
      mode: "create",
      user: "user-ts",
      project: projectStore.getWebProjectRecord(db, "user-ts", "project-ts"),
      activeProjectId: projectStore.getActiveWebProjectId(db, "user-ts"),
      models: modelStore.listModelConfigs(),
    }),
  );
}

async function verify(dbPath: string) {
  const projectStore = await import(legacyModulePath("server/web/projects/store.ts"));
  const { createGlobalModelConfigStore } = await import(
    legacyModulePath("server/state/globalModelConfigStore.ts")
  );

  const db = await openState(dbPath);
  const projects = projectStore.listWebProjects(db, "user-ts");
  const models = createGlobalModelConfigStore(db).listModelConfigs();

  const rustProject = projects.find((project) => project.id === "project-rust");
  assert(rustProject, "TypeScript did not see the Rust-created project");
  assert(rustProject.name === "Rust Project", `unexpected Rust project name: ${rustProject.name}`);
  assert(rustProject.chatSessionId === "rt", `unexpected Rust chat session: ${rustProject.chatSessionId}`);

  const activeProjectId = projectStore.getActiveWebProjectId(db, "user-ts");
  assert(activeProjectId === "project-rust", `unexpected active project: ${activeProjectId}`);

  const rustModel = models.find((model) => model.id === "model-rust");
  assert(rustModel, "TypeScript did not see the Rust-created model config");
  assert(rustModel.modelId === "gpt-rust", `unexpected Rust model id: ${rustModel.modelId}`);
  assert(rustModel.isDefault === true, "Rust model config should be the default");
  assert(
    (rustModel.configJson as Record<string, unknown> | null | undefined)?.max_input_tokens === 2048,
    "Rust model config lost max_input_tokens",
  );

  projectStore.upsertWebProject(
    db,
    {
      userId: "user-ts",
      projectId: "project-ts-after",
      workspaceRoot: "/work/ts-after-rust",
      name: "TS After Rust",
    },
    1_700_000_002_000,
  );

  const modelStore = createGlobalModelConfigStore(db);
  modelStore.upsertModelConfig(
    {
      id: "model-ts-after",
      modelId: "gpt-ts-after",
      displayName: "TS After Rust",
      provider: "openai",
      isEnabled: true,
      isDefault: false,
      updatedAt: null,
    },
    1_700_000_002_000,
  );

  console.log(
    JSON.stringify({
      mode: "verify",
      projects: projects.map((project) => project.id),
      activeProjectId,
      models: models.map((model) => model.id),
    }),
  );
}

async function main() {
  const [, , modeArg, dbPath] = process.argv;
  const mode = modeArg as Mode | undefined;
  if (!mode || !dbPath || !fs.existsSync(path.dirname(dbPath))) {
    throw new Error("usage: state-store-fixture.ts <create|verify> <dbPath>");
  }
  if (mode === "create") {
    await create(dbPath);
    return;
  }
  if (mode === "verify") {
    await verify(dbPath);
    return;
  }
  throw new Error(`unknown mode: ${mode}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
