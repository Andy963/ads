import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ConversationLogger } from "../../server/utils/conversationLogger.js";

async function waitForFileContent(filePath: string, predicate: (content: string) => boolean): Promise<string> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, "utf8");
      if (predicate(content)) {
        return content;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for conversation log content: ${filePath}`);
}

describe("ConversationLogger", () => {
  it("does not persist or attach Native execution ids when thread persistence is disabled", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ads-native-conversation-log-"));
    const logger = new ConversationLogger(workspace, 1, "native-execution-id", {
      persistThreadId: false,
    });

    try {
      assert.equal(path.basename(logger.path).includes("native-execution-id"), false);
      logger.attachThreadId("native-execution-id");
      logger.logOutput("done");
      logger.close();

      const content = await waitForFileContent(
        logger.path,
        (value) => value.includes("done"),
      );
      assert.equal(content.includes("native-execution-id"), false);
      assert.equal(content.includes("Thread ID"), false);
    } finally {
      logger.close();
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });
});
