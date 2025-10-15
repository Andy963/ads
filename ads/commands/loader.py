"""Command loader - loads slash commands from .ads/commands/*.md."""

import re
from pathlib import Path
from typing import Any, Dict, List, Optional
from dataclasses import dataclass

import yaml


@dataclass
class Command:
    """Represents a slash command"""
    name: str  # Command name (e.g., "quick-bug")
    title: str  # Human-readable title
    description: str  # Description of what the command does
    content: str  # The command template content
    variables: List[str]  # List of variables (e.g., ["description", "file"])
    file_path: Path  # Path to the command file


class CommandLoader:
    """Loads and manages slash commands"""

    def __init__(self, workspace: Path | str):
        self.workspace = Path(workspace)

    def load_all_commands(self) -> List[Command]:
        """Load all commands for the configured workspace."""

        commands = self.load_from_workspace(self.workspace)
        return list(commands.values())

    def load_command(self, command_name: str) -> Optional[Command]:
        """Load a single command by name for the configured workspace."""

        commands = self.load_from_workspace(self.workspace)
        return commands.get(command_name)

    @staticmethod
    def load_from_workspace(workspace: Path) -> Dict[str, Command]:
        """
        Load all commands from workspace .ads/commands/ directory.

        Args:
            workspace: Workspace root path

        Returns:
            Dictionary mapping command names to Command objects
        """
        candidate_dirs = []
        commands_root = workspace / ".ads" / "commands"

        if commands_root.exists():
            candidate_dirs.append(commands_root)

        if workspace.exists() and workspace.is_dir():
            candidate_dirs.append(workspace)

        commands: Dict[str, Command] = {}

        for commands_dir in candidate_dirs:
            for cmd_file in commands_dir.glob("*.md"):
                try:
                    command = CommandLoader._parse_command_file(cmd_file)
                    commands[command.name] = command
                except Exception as e:
                    print(f"Warning: Failed to load command {cmd_file}: {e}")
                    continue

        return commands

    @staticmethod
    def _parse_command_file(file_path: Path) -> Command:
        """
        Parse a command markdown file.

        Format:
        ```markdown
        # Command Title

        Description of the command.

        Optional frontmatter variables:
        - {{variable_name}}: description

        ---

        Command content with {{variables}}.
        ```

        Args:
            file_path: Path to command file

        Returns:
            Parsed Command object
        """
        raw_content = file_path.read_text(encoding='utf-8')

        frontmatter: Dict[str, Any] = {}
        content = raw_content
        if raw_content.lstrip().startswith("---"):
            parts = raw_content.split("---", 2)
            if len(parts) >= 3:
                _, fm_text, body = parts
                try:
                    frontmatter = yaml.safe_load(fm_text) or {}
                except Exception:
                    frontmatter = {}
                content = body.lstrip()

        # Extract title (first H1)
        title_match = re.search(r'^#\s+(.+)$', content, re.MULTILINE)
        title = (
            frontmatter.get("title")
            or frontmatter.get("name")
            or (title_match.group(1) if title_match else file_path.stem)
        )

        # Extract description (text between title and first ---)
        lines = content.split('\n')
        description_lines = []
        found_title = False

        for line in lines:
            if line.startswith('# '):
                found_title = True
                continue
            if found_title:
                if line.strip() == '---':
                    break
                if line.strip() and not line.startswith('**') and not line.startswith('-'):
                    description_lines.append(line.strip())

        description = (
            frontmatter.get("description")
            or (' '.join(description_lines) if description_lines else title)
        )

        # Extract variables from {{variable}} patterns
        variables = frontmatter.get("variables")
        if not variables:
            variables = re.findall(r'\{\{(\w+)\}\}', content)
        variables = list(dict.fromkeys(variables))  # Remove duplicates, preserve order

        # Command name is the filename without extension
        name = frontmatter.get("name") or file_path.stem

        return Command(
            name=name,
            title=title,
            description=description,
            content=content,
            variables=variables,
            file_path=file_path
        )

    @staticmethod
    def get_command(workspace: Path, command_name: str) -> Optional[Command]:
        """
        Get a specific command by name.

        Args:
            workspace: Workspace root path
            command_name: Command name (without extension)

        Returns:
            Command object or None if not found
        """
        commands = CommandLoader.load_from_workspace(workspace)
        return commands.get(command_name)

    @staticmethod
    def list_commands(workspace: Path) -> List[Dict[str, str]]:
        """
        List all available commands with metadata.

        Args:
            workspace: Workspace root path

        Returns:
            List of command metadata dictionaries
        """
        commands = CommandLoader.load_from_workspace(workspace)

        return [
            {
                "name": cmd.name,
                "title": cmd.title,
                "description": cmd.description,
                "variables": cmd.variables
            }
            for cmd in commands.values()
        ]
