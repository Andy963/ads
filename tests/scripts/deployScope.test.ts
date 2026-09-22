import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { classifyChangedFiles, isClientScopedFile } from "../../scripts/lib/deploy-scope.js";

describe("scripts/lib/deploy-scope", () => {
  describe("isClientScopedFile", () => {
    it("treats client sources as client-scoped", () => {
      assert.equal(isClientScopedFile("client/src/App.vue"), true);
      assert.equal(isClientScopedFile("client/vite.config.ts"), true);
      assert.equal(isClientScopedFile("client/public/icons/icon.svg"), true);
    });

    it("treats docs and markdown files as client-scoped", () => {
      assert.equal(isClientScopedFile("docs/web.md"), true);
      assert.equal(isClientScopedFile("docs/adr/0013-native-agent-runtime-phase-1.md"), true);
      assert.equal(isClientScopedFile("README.md"), true);
      assert.equal(isClientScopedFile("CHANGELOG.MD"), true);
    });

    it("normalizes leading ./ and backslashes", () => {
      assert.equal(isClientScopedFile("./client/src/App.vue"), true);
      assert.equal(isClientScopedFile("client\\src\\App.vue"), true);
    });

    it("treats backend and tooling files as not client-scoped", () => {
      assert.equal(isClientScopedFile("server/web/server.ts"), false);
      assert.equal(isClientScopedFile("connectors/telegram/src/bot.ts"), false);
      assert.equal(isClientScopedFile("package.json"), false);
      assert.equal(isClientScopedFile("package-lock.json"), false);
      assert.equal(isClientScopedFile("tsconfig.build.json"), false);
      assert.equal(isClientScopedFile("scripts/deploy-local.js"), false);
      assert.equal(isClientScopedFile(".github/workflows/ci.yml"), false);
      assert.equal(isClientScopedFile("client"), false);
      assert.equal(isClientScopedFile(""), false);
    });
  });

  describe("classifyChangedFiles", () => {
    it("classifies pure client changes as client-only", () => {
      assert.equal(classifyChangedFiles(["client/src/App.vue", "client/src/styles.css"]), "client-only");
    });

    it("classifies pure docs/markdown changes as client-only", () => {
      assert.equal(classifyChangedFiles(["docs/configuration.md", "README.md"]), "client-only");
    });

    it("classifies server changes as full", () => {
      assert.equal(classifyChangedFiles(["server/web/server/httpServer.ts"]), "full");
    });

    it("classifies package.json changes as full", () => {
      assert.equal(classifyChangedFiles(["package.json"]), "full");
      assert.equal(classifyChangedFiles(["client/src/App.vue", "package-lock.json"]), "full");
    });

    it("classifies mixed client and backend changes as full", () => {
      assert.equal(
        classifyChangedFiles(["client/src/App.vue", "docs/web.md", "connectors/telegram/src/bot.ts"]),
        "full",
      );
    });

    it("classifies an empty diff as full (conservative)", () => {
      assert.equal(classifyChangedFiles([]), "full");
    });

    it("classifies a missing baseline as full (conservative)", () => {
      assert.equal(classifyChangedFiles(null), "full");
      assert.equal(classifyChangedFiles(undefined), "full");
      assert.equal(classifyChangedFiles("client/src/App.vue"), "full");
    });
  });
});
