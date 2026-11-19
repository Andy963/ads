import { legacyModulePath } from "./legacy-module-path.ts";

async function main() {
  const { AttachmentStore } = await import(legacyModulePath("server/attachments/store.ts"));
  const [mode, dbPath, workspaceRoot] = process.argv.slice(2);
  if (!mode || !dbPath || !workspaceRoot) {
    throw new Error("usage: workspace-attachment-fixture.ts <mode> <db-path> <workspace-root>");
  }
  process.env.ADS_DATABASE_PATH = dbPath;

  const store = new AttachmentStore({ workspacePath: workspaceRoot });

  if (mode === "verify") {
    const rustSha = "a".repeat(64);
    const attachment = store.getAttachmentBySha256(rustSha);
    process.stdout.write(`${JSON.stringify({ attachment })}\n`);
  } else if (mode === "write") {
    const sha256 = "f".repeat(64);
    const attachment = store.createOrGetImageAttachment({
      filename: "C:\\fakepath\\typescript.png",
      contentType: "image/webp",
      sizeBytes: 256,
      width: 32,
      height: 24,
      sha256,
      storageKey: `attachments/ff/${sha256}.webp`,
      now: 500,
    });
    store.assignAttachmentsToTask("task-ts", [attachment.id]);
    const assigned = store.getAttachment(attachment.id);
    process.stdout.write(`${JSON.stringify({ attachment: assigned })}\n`);
  } else {
    throw new Error(`unknown mode: ${mode}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
