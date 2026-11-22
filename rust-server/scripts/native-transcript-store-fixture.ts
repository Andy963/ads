import { legacyModulePath } from "./legacy-module-path.ts";

import { loadTsServerDependency } from "./lib/ts-server-dependencies.mjs";

const Database = loadTsServerDependency("better-sqlite3");

async function main() {
  const { NativeTranscriptStore } = await import(
    legacyModulePath("server/state/nativeTranscriptStore.ts")
  );
  const [mode, dbPath] = process.argv.slice(2);
  if (!mode || !dbPath) {
    throw new Error("usage: native-transcript-store-fixture.ts <mode> <db-path>");
  }

  const db = new Database(dbPath);
  db.pragma("foreign_keys = ON");
  const store = new NativeTranscriptStore(db, { redactions: ["known-secret"] });

  if (mode === "verify") {
    const turns = store.listTurns("cross-rust", "writer-rust");
    const history = store.readHistory("cross-rust", 0, 0);
    process.stdout.write(`${JSON.stringify({ turns, history })}\n`);
  } else if (mode === "write") {
    store.claimTranscript("cross-ts", "writer-ts");
    store.beginTurn({
      transcriptId: "cross-ts",
      turnId: "ts-turn",
      messages: [{ role: "user", content: "hello known-secret" }],
      entries: [],
      provider: { provider: "openai", model: "gpt" },
      writerId: "writer-ts",
      incremental: false,
    });
    store.updateTurn({
      transcriptId: "cross-ts",
      turnId: "ts-turn",
      status: "completed",
      messages: [{ role: "assistant", content: "done" }],
      entries: [],
      usage: { input_tokens: 7, output_tokens: 2 },
      errorMessage: null,
      writerId: "writer-ts",
    });
    process.stdout.write(`${JSON.stringify({ turns: store.listTurns("cross-ts", "writer-ts") })}\n`);
  } else {
    throw new Error(`unknown mode: ${mode}`);
  }
  db.close();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
