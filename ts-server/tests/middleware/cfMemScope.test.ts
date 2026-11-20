import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { resolveCfMemScope } from "../../server/middleware/builtin/cfMemScope.js";

function withTempDir<T>(fn: (tempDir: string) => T): T {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-cfmem-scope-test-"));
  const realTempDir = fs.realpathSync(tempDir);
  try {
    return fn(realTempDir);
  } finally {
    try {
      fs.rmSync(realTempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors in temporary test directories
    }
  }
}

describe("resolveCfMemScope", () => {
  it("resolves scope for a normal git repository with a .git directory", () => {
    withTempDir((tempDir) => {
      const repoDir = path.join(tempDir, "sample-repo");
      fs.mkdirSync(path.join(repoDir, ".git"), { recursive: true });

      const scope = resolveCfMemScope(repoDir);
      assert.ok(scope !== null);
      assert.equal(scope.projectId, "sample-repo");
      assert.equal(scope.workspaceName, "sample-repo");
      assert.equal(scope.repositoryRoot, repoDir);

      const expectedHash = crypto.createHash("sha256").update(repoDir).digest("hex").slice(0, 16);
      assert.equal(scope.workspaceId, `ws_sample-repo_${expectedHash}`);
      assert.ok(!scope.workspaceId.includes("/"));
      assert.ok(!scope.workspaceId.includes("\\"));
      assert.ok(!scope.workspaceId.includes(repoDir));
    });
  });

  it("resolves scope for a git worktree with .git file and relative commondir", () => {
    withTempDir((tempDir) => {
      const mainRepoDir = path.join(tempDir, "main-app");
      const worktreeAdminDir = path.join(mainRepoDir, ".git", "worktrees", "issue-42");
      fs.mkdirSync(worktreeAdminDir, { recursive: true });
      fs.writeFileSync(path.join(worktreeAdminDir, "commondir"), "../..\n", "utf-8");

      const worktreeDir = path.join(tempDir, "worktrees", "issue-42");
      fs.mkdirSync(worktreeDir, { recursive: true });
      fs.writeFileSync(path.join(worktreeDir, ".git"), `gitdir: ${worktreeAdminDir}\n`, "utf-8");

      const scope = resolveCfMemScope(worktreeDir);
      assert.ok(scope !== null);
      assert.equal(scope.projectId, "main-app");
      assert.equal(scope.workspaceName, "issue-42");
      assert.equal(scope.repositoryRoot, mainRepoDir);

      const expectedHash = crypto.createHash("sha256").update(worktreeDir).digest("hex").slice(0, 16);
      assert.equal(scope.workspaceId, `ws_main-app_${expectedHash}`);
      assert.ok(!scope.workspaceId.includes("/"));
      assert.ok(!scope.workspaceId.includes("\\"));
      assert.ok(!scope.workspaceId.includes(worktreeDir));
    });
  });

  it("resolves scope for a git worktree with relative gitdir and absolute commondir", () => {
    withTempDir((tempDir) => {
      const mainRepoDir = path.join(tempDir, "my-service");
      const worktreeAdminDir = path.join(mainRepoDir, ".git", "worktrees", "wt-rel");
      fs.mkdirSync(worktreeAdminDir, { recursive: true });
      fs.writeFileSync(path.join(worktreeAdminDir, "commondir"), path.join(mainRepoDir, ".git"), "utf-8");

      const worktreeDir = path.join(tempDir, "wt-rel");
      fs.mkdirSync(worktreeDir, { recursive: true });
      const relGitDir = path.relative(worktreeDir, worktreeAdminDir);
      fs.writeFileSync(path.join(worktreeDir, ".git"), `gitdir: ${relGitDir}\n`, "utf-8");

      const scope = resolveCfMemScope(worktreeDir);
      assert.ok(scope !== null);
      assert.equal(scope.projectId, "my-service");
      assert.equal(scope.workspaceName, "wt-rel");
      assert.equal(scope.repositoryRoot, mainRepoDir);
      assert.ok(scope.workspaceId.startsWith("ws_my-service_"));
    });
  });

  it("returns null for missing, empty, invalid-type, or non-directory roots", () => {
    assert.equal(resolveCfMemScope(""), null);
    assert.equal(resolveCfMemScope("   "), null);
    assert.equal(resolveCfMemScope("/path/does/not/exist/at/all"), null);
    assert.equal(resolveCfMemScope(null as unknown as string), null);
    assert.equal(resolveCfMemScope(undefined as unknown as string), null);

    withTempDir((tempDir) => {
      const regularFile = path.join(tempDir, "not-a-dir.txt");
      fs.writeFileSync(regularFile, "content", "utf-8");
      assert.equal(resolveCfMemScope(regularFile), null);
    });
  });

  it("returns null for non-git roots and corrupted .git files", () => {
    withTempDir((tempDir) => {
      const nonGitDir = path.join(tempDir, "plain-directory");
      fs.mkdirSync(nonGitDir);
      assert.equal(resolveCfMemScope(nonGitDir), null);

      const emptyGitFileDir = path.join(tempDir, "empty-git-file");
      fs.mkdirSync(emptyGitFileDir);
      fs.writeFileSync(path.join(emptyGitFileDir, ".git"), "", "utf-8");
      assert.equal(resolveCfMemScope(emptyGitFileDir), null);

      const badGitFileDir = path.join(tempDir, "bad-git-file");
      fs.mkdirSync(badGitFileDir);
      fs.writeFileSync(path.join(badGitFileDir, ".git"), "some random string without gitdir\n", "utf-8");
      assert.equal(resolveCfMemScope(badGitFileDir), null);

      const nonExistentTargetDir = path.join(tempDir, "missing-target-gitdir");
      fs.mkdirSync(nonExistentTargetDir);
      fs.writeFileSync(path.join(nonExistentTargetDir, ".git"), "gitdir: /no/such/path/exists\n", "utf-8");
      assert.equal(resolveCfMemScope(nonExistentTargetDir), null);
    });
  });

  it("rejects invalid repository basenames and the personal project id", () => {
    withTempDir((tempDir) => {
      const createRepo = (name: string): string => {
        const repoPath = path.join(tempDir, name);
        fs.mkdirSync(path.join(repoPath, ".git"), { recursive: true });
        return repoPath;
      };

      // Exact "personal" and case variations must return null
      assert.equal(resolveCfMemScope(createRepo("personal")), null);
      assert.equal(resolveCfMemScope(createRepo("Personal")), null);
      assert.equal(resolveCfMemScope(createRepo("PERSONAL")), null);

      // Invalid starting characters
      assert.equal(resolveCfMemScope(createRepo("-leading-hyphen")), null);
      assert.equal(resolveCfMemScope(createRepo("_leading-underscore")), null);
      assert.equal(resolveCfMemScope(createRepo(".leading-dot")), null);

      // Invalid characters
      assert.equal(resolveCfMemScope(createRepo("repo with spaces")), null);
      assert.equal(resolveCfMemScope(createRepo("repo$invalid")), null);

      // Length > 32 characters (33 chars)
      const tooLongName = "a".repeat(33);
      assert.equal(resolveCfMemScope(createRepo(tooLongName)), null);

      // Length == 32 characters (valid boundary)
      const valid32Name = "a".repeat(32);
      const valid32Scope = resolveCfMemScope(createRepo(valid32Name));
      assert.ok(valid32Scope !== null);
      assert.equal(valid32Scope.projectId, valid32Name);

      // Valid special characters in project-id: alphanumeric, ., _, :, -
      const validSpecialName = "proj.1-test_v2:alpha";
      const validSpecialScope = resolveCfMemScope(createRepo(validSpecialName));
      assert.ok(validSpecialScope !== null);
      assert.equal(validSpecialScope.projectId, validSpecialName);

      // Worktree pointing back to a repo named personal must also return null
      const personalRepo = createRepo("personal-main");
      const wtAdmin = path.join(personalRepo, ".git", "worktrees", "wt-child");
      fs.mkdirSync(wtAdmin, { recursive: true });
      fs.writeFileSync(path.join(wtAdmin, "commondir"), "../..\n", "utf-8");

      const personalBaseRepo = createRepo("personal");
      const wtAdminPersonal = path.join(personalBaseRepo, ".git", "worktrees", "wt-child");
      fs.mkdirSync(wtAdminPersonal, { recursive: true });
      fs.writeFileSync(path.join(wtAdminPersonal, "commondir"), "../..\n", "utf-8");

      const wtDir = path.join(tempDir, "wt-child");
      fs.mkdirSync(wtDir, { recursive: true });
      fs.writeFileSync(path.join(wtDir, ".git"), `gitdir: ${wtAdminPersonal}\n`, "utf-8");
      assert.equal(resolveCfMemScope(wtDir), null);
    });
  });

  it("guarantees deterministic workspaceId without absolute paths", () => {
    withTempDir((tempDir) => {
      const repoDir = path.join(tempDir, "nested", "sub", "test-project");
      fs.mkdirSync(path.join(repoDir, ".git"), { recursive: true });

      const scope1 = resolveCfMemScope(repoDir);
      const scope2 = resolveCfMemScope(repoDir);

      assert.ok(scope1 !== null);
      assert.ok(scope2 !== null);
      assert.equal(scope1.workspaceId, scope2.workspaceId);
      assert.match(scope1.workspaceId, /^ws_[A-Za-z0-9._:-]{1,32}_[0-9a-f]{16}$/);
      assert.ok(!scope1.workspaceId.includes("/"));
      assert.ok(!scope1.workspaceId.includes("\\"));
      assert.ok(!scope1.workspaceId.includes(tempDir));
      assert.ok(!scope1.workspaceId.includes(repoDir));
    });
  });

  it("resolves the live ADS worktree environment correctly", () => {
    const cwd = process.cwd();
    const scope = resolveCfMemScope(cwd);
    assert.ok(scope !== null);
    assert.equal(scope.projectId, "ads");
    assert.equal(scope.workspaceName, path.basename(fs.realpathSync(cwd)));
    assert.ok(scope.repositoryRoot.endsWith("/ads"));
    assert.ok(scope.workspaceId.startsWith("ws_ads_"));
    assert.ok(!scope.workspaceId.includes("/"));
  });
});
