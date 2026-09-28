import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { extractRelatedContexts } from "../../server/reviewer/contextExtractor.js";
import { boundRelatedContexts } from "../../server/reviewer/contextBudget.js";

describe("committed Reviewer context extraction", () => {
  let repo: string;
  let base: string;
  function git(...args: string[]): string {
    const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  }
  function write(file: string, content: string): void {
    fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
    fs.writeFileSync(path.join(repo, file), content);
  }
  function commit(): string {
    git("add", ".");
    git("commit", "-qm", "fixture");
    return git("rev-parse", "HEAD");
  }
  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), "ads-review-context-"));
    git("init", "-q");
    git("config", "user.email", "fixture@example.invalid");
    git("config", "user.name", "Fixture");
    write("README.md", "Fixture\n");
    base = commit();
  });
  afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

  it("extracts complete directly imported declarations from the reviewed commit, not the working tree", () => {
    const contract = "export interface Contract {\n  payload: { nested: string };\n}";
    write("types.ts", `${"// unrelated header\n".repeat(400)}${contract}\nexport type Other = number;\nexport const irrelevant = 'not requested';`);
    base = commit();
    write("src/a.ts", "import type {\n Contract as Input\n} from '../types.js';\nexport type A = Input;");
    write("src/b.ts", "import { type Other } from '../types.js';\nexport type B = Other;");
    const head = commit();
    write("types.ts", "export interface Contract { wrongRevision: true }");
    commit();
    write("src/a.ts", "import type { Wrong } from '../uncommitted.js';");
    git("add", ".");
    const result = extractRelatedContexts(repo, base, head);
    assert.equal(result.relatedContexts.length, 1);
    assert.equal(result.relatedContexts[0]?.file, "types.ts");
    assert.equal(result.relatedContexts[0]?.content, `${contract}\n\nexport type Other = number;`);
    assert.deepEqual(result.relatedContextOmissions, []);
  });

  it("includes same-file supporting types and local export aliases without expanding other modules", () => {
    write("external.ts", "export type External = 'not-expanded';");
    write("types.ts", [
      "import type { External } from './external.js';",
      "interface Node { next?: Node; value: External }",
      "interface Internal { node: Node }",
      "export type { Internal as Contract };",
      "export default Internal;",
      "interface NotExported { private: true }",
    ].join("\n"));
    base = commit();
    write("consumer.ts", "import type Default, { Contract, NotExported } from './types.js';");
    const result = extractRelatedContexts(repo, base, commit());
    assert.equal(result.relatedContexts.length, 1);
    const content = result.relatedContexts[0]!.content;
    assert.match(content, /interface Internal \{ node: Node \}/);
    assert.match(content, /interface Node \{ next\?: Node; value: External \}/);
    assert.match(content, /import type \{ External \} from '.\/external.js'/);
    assert.match(content, /Internal as Contract/);
    assert.doesNotMatch(content, /not-expanded|private: true/);
    assert.ok(result.relatedContextOmissions.some(({ reason }) => reason.includes("NotExported")));
  });

  it("resolves declaration files, index modules, default/namespace imports and NodeNext suffixes", () => {
    write("defs.d.ts", "export interface A { id: string }");
    write("folder/index.ts", "export default interface B { ok: boolean }");
    write("esm.mts", "export type C = 'esm';");
    write("common.cts", "export interface D { count: number }");
    base = commit();
    write("consumer.tsx", "import type { A } from './defs.js';\nimport type B from './folder';\nimport type * as C from './esm.mjs';\nimport type { D } from './common.cjs';\n");
    const result = extractRelatedContexts(repo, base, commit());
    assert.deepEqual(result.relatedContexts.map(({ file }) => file), ["common.cts", "defs.d.ts", "esm.mts", "folder/index.ts"]);
    assert.deepEqual(result.relatedContextOmissions, []);
  });

  it("does not mistake comments or strings for imports, recurse through barrels, or read external files", () => {
    write("secret.ts", "export type Secret = 'must-not-appear';");
    write("barrel.ts", "export type { Secret } from './secret.js';");
    write("real.ts", "export type Safe = string;");
    fs.symlinkSync(path.join(repo, "secret.ts"), path.join(repo, "link.ts"));
    base = commit();
    write("consumer.ts", [
      "// import type { Secret } from './secret.js';",
      'const text = "import type { Secret } from \'./secret.js\';";',
      "import type { Secret } from './barrel.js';",
      "import type { Safe } from './real.js';",
      "import type { Secret as Linked } from './link.js';",
      "import type { Outside } from '../outside.ts';",
      "import type { External } from 'external-package';",
    ].join("\n"));
    const result = extractRelatedContexts(repo, base, commit());
    assert.deepEqual(result.relatedContexts.map(({ file }) => file), ["real.ts"]);
    assert.ok(result.relatedContextOmissions.some(({ file, reason }) => file === "barrel.ts" && /re-exported/.test(reason)));
    assert.ok(result.relatedContextOmissions.some(({ file, reason }) => file === "link.ts" && reason.includes("symlinks")));
    assert.ok(result.relatedContextOmissions.some(({ reason }) => reason.includes("../outside.ts")));
    assert.doesNotMatch(JSON.stringify(result), /must-not-appear/);
  });

  it("handles renamed sources with quoted/non-ASCII paths and ignores deleted sources", () => {
    const moduleFile = "types with spaces.ts";
    write(moduleFile, "export interface Shape { size: number }");
    write('before "quoted".ts', `import type { Shape } from './${moduleFile}';\n`);
    write("deleted.ts", "import type { Missing } from './missing.js';");
    base = commit();
    git("mv", 'before "quoted".ts', 'after "quoted" ü.ts');
    git("rm", "deleted.ts");
    const result = extractRelatedContexts(repo, base, commit());
    assert.deepEqual(result.relatedContexts.map(({ file }) => file), [moduleFile]);
    assert.deepEqual(result.relatedContextOmissions, []);
  });

  it("caps actual extraction at 32 files with deterministic omission reporting", () => {
    const imports = [];
    for (let index = 0; index < 33; index++) {
      const file = `types/t${String(index).padStart(2, "0")}.ts`;
      write(file, `export type T${index} = number;`);
      imports.push(`import type { T${index} } from './${file}';`);
    }
    base = commit();
    write("consumer.ts", imports.reverse().join("\n"));
    const head = commit();
    const result = extractRelatedContexts(repo, base, head);
    assert.equal(result.relatedContexts.length, 32);
    assert.deepEqual(result.relatedContextOmissions.map(({ file }) => file), ["types/t32.ts"]);
    assert.deepEqual(extractRelatedContexts(repo, base, head), result);
  });

  it("reports oversized source omissions without losing other direct context", () => {
    write("large.ts", `${"// filler\n".repeat(30_000)}export type Large = number;`);
    write("large.d.ts", "export type Large = 'wrong-shadowed-contract';");
    write("small.ts", "export type Small = number;");
    base = commit();
    write("consumer.ts", "import type { Large } from './large.js';\nimport type { Small } from './small.js';");
    const result = extractRelatedContexts(repo, base, commit());
    assert.deepEqual(result.relatedContexts.map(({ file }) => file), ["small.ts"]);
    assert.ok(result.relatedContextOmissions.some(({ file, reason }) => file === "large.ts" && /256 KiB/.test(reason)));
    assert.doesNotMatch(JSON.stringify(result.relatedContexts), /wrong-shadowed-contract/);
  });

  it("uses the TypeScript candidate order for explicit JSX imports with colliding basenames", () => {
    write("view.ts", "export interface View { fromTs: string }");
    write("view.tsx", "export interface View { fromTsx: number }");
    write("view.jsx", "export const View = 'fromJsx';");
    base = commit();
    write("consumer.tsx", "import type { View } from './view.jsx';");
    const result = extractRelatedContexts(repo, base, commit());
    assert.deepEqual(result.relatedContexts, [{ file: "view.tsx", content: "export interface View { fromTsx: number }" }]);
    assert.deepEqual(result.relatedContextOmissions, []);
  });
});

describe("Reviewer context output budget", () => {
  it("accepts exactly 3000 lines and omits the next complete declaration", () => {
    const full = { file: "types.ts", content: `interface Types {\n${"p: number;\n".repeat(2998)}}` };
    const extra = { file: "extra.ts", content: "interface Extra {}" };
    const result = boundRelatedContexts([full, extra]);
    assert.deepEqual(result.relatedContexts, [full]);
    assert.deepEqual(result.relatedContextOmissions.map(({ file }) => file), ["extra.ts"]);
    const tooLarge = { file: "too-large.ts", content: `${full.content}\n` };
    assert.deepEqual(boundRelatedContexts([tooLarge, extra]).relatedContexts, [extra]);
  });

  it("bounds UTF-8 bytes even for a single long line and leaves declarations intact", () => {
    const full = { file: "exact.ts", content: "x".repeat(64 * 1024) };
    assert.deepEqual(boundRelatedContexts([full]).relatedContexts, [full]);
    const wide = { file: "wide.ts", content: `type Wide = '${"é".repeat(33 * 1024)}';` };
    const small = { file: "small.ts", content: "type Small = string;" };
    const result = boundRelatedContexts([wide, small]);
    assert.deepEqual(result.relatedContexts, [small]);
    assert.deepEqual(result.relatedContextOmissions.map(({ file }) => file), ["wide.ts"]);
  });
});
