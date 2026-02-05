import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { escapeTelegramMarkdownV2 } from "../../src/utils/markdown.js";

describe("utils/markdown escapeTelegramMarkdownV2", () => {
  it("preserves fenced code block language", () => {
    const input = ["before", "```go", "package main", "```", "after"].join("\n");
    const out = escapeTelegramMarkdownV2(input);
    assert.match(out, /```go\npackage main\n```/);
  });

  it("infers language from nearby filename hint", () => {
    const input = ["Create `main.go`:", "```", "package main", "", "func main() {}", "```"].join("\n");
    const out = escapeTelegramMarkdownV2(input);
    assert.ok(out.includes("```go\n"), "should infer go from main.go hint");
  });

  it("does not escape MarkdownV2 specials inside code fences", () => {
    const input = ["a_b", "", "```go", 'fmt.Println("a_b")', "```"].join("\n");
    const out = escapeTelegramMarkdownV2(input);
    assert.ok(out.includes("a\\_b"), "should escape underscore outside code fences");
    assert.ok(out.includes('fmt.Println("a_b")'), "should keep underscores inside code fences");
  });

  it("infers bash for shell scripts without an explicit language", () => {
    const input = ["```", "#!/bin/bash", "echo hi", "```"].join("\n");
    const out = escapeTelegramMarkdownV2(input);
    assert.ok(out.includes("```bash\n"), "should infer bash from shebang");
  });
});

