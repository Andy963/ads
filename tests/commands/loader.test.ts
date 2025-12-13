import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { CommandLoader } from "../../src/commands/loader.js";

describe("commands/loader", () => {
  let tmpDir: string;
  let commandsDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-cmd-test-"));
    commandsDir = path.join(tmpDir, ".ads", "commands");
    fs.mkdirSync(commandsDir, { recursive: true });
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it("should load command from markdown file", () => {
    const cmdContent = `---
title: Test Command
description: A test command
variables:
  - name
  - value
---

# Test Command

This is a test command with {{name}} and {{value}}.
`;
    fs.writeFileSync(path.join(commandsDir, "test-cmd.md"), cmdContent);

    const loader = new CommandLoader(tmpDir);
    const command = loader.loadCommand("test-cmd");

    assert.ok(command, "Command should be loaded");
    assert.strictEqual(command.name, "test-cmd");
    assert.strictEqual(command.title, "Test Command");
    assert.strictEqual(command.description, "A test command");
    assert.deepStrictEqual(command.variables, ["name", "value"]);
  });

  it("should extract title from markdown heading", () => {
    const cmdContent = `# My Command Title

This is the description.

Some content here.
`;
    fs.writeFileSync(path.join(commandsDir, "heading-cmd.md"), cmdContent);

    const loader = new CommandLoader(tmpDir);
    const command = loader.loadCommand("heading-cmd");

    assert.ok(command);
    assert.strictEqual(command.title, "My Command Title");
  });

  it("should extract variables from content", () => {
    const cmdContent = `# Variable Test

Use {{var1}} and {{var2}} here.
Also {{var1}} again.
`;
    fs.writeFileSync(path.join(commandsDir, "var-cmd.md"), cmdContent);

    const loader = new CommandLoader(tmpDir);
    const command = loader.loadCommand("var-cmd");

    assert.ok(command);
    assert.deepStrictEqual(command.variables, ["var1", "var2"]);
  });

  it("should list all commands", () => {
    fs.writeFileSync(path.join(commandsDir, "cmd1.md"), "# Command 1\nContent 1");
    fs.writeFileSync(path.join(commandsDir, "cmd2.md"), "# Command 2\nContent 2");

    const loader = new CommandLoader(tmpDir);
    const commands = loader.listCommands();

    assert.strictEqual(commands.length, 2);
    const names = commands.map(c => c.name);
    assert.ok(names.includes("cmd1"));
    assert.ok(names.includes("cmd2"));
  });

  it("should return null for non-existent command", () => {
    const loader = new CommandLoader(tmpDir);
    const command = loader.loadCommand("non-existent");
    assert.strictEqual(command, null);
  });

  it("should handle empty workspace", () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-empty-"));
    try {
      const loader = new CommandLoader(emptyDir);
      const commands = loader.listCommands();
      assert.strictEqual(commands.length, 0);
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it("should use static methods correctly", () => {
    fs.writeFileSync(path.join(commandsDir, "static-cmd.md"), "# Static Command\nContent");

    const commands = CommandLoader.listCommands(tmpDir);
    assert.ok(commands.length > 0);

    const command = CommandLoader.getCommand(tmpDir, "static-cmd");
    assert.ok(command);
    assert.strictEqual(command.name, "static-cmd");
  });

  it("should parse frontmatter with name override", () => {
    const cmdContent = `---
name: custom-name
title: Custom Title
---

# Different Title

Content here.
`;
    fs.writeFileSync(path.join(commandsDir, "file-name.md"), cmdContent);

    const loader = new CommandLoader(tmpDir);
    const command = loader.loadCommand("custom-name");

    assert.ok(command);
    assert.strictEqual(command.name, "custom-name");
    assert.strictEqual(command.title, "Custom Title");
  });

  it("should ignore non-markdown files", () => {
    fs.writeFileSync(path.join(commandsDir, "valid.md"), "# Valid\nContent");
    fs.writeFileSync(path.join(commandsDir, "invalid.txt"), "Not a command");
    fs.writeFileSync(path.join(commandsDir, "also-invalid.json"), "{}");

    const loader = new CommandLoader(tmpDir);
    const commands = loader.listCommands();

    assert.strictEqual(commands.length, 1);
    assert.strictEqual(commands[0].name, "valid");
  });
});
