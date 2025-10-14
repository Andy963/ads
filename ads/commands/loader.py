"""
Command loader - loads slash commands from .ads/commands/*.md
"""

import re
from pathlib import Path
from typing import Dict, List, Optional
from dataclasses import dataclass


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

    @staticmethod
    def load_from_workspace(workspace: Path) -> Dict[str, Command]:
        """
        Load all commands from workspace .ads/commands/ directory.

        Args:
            workspace: Workspace root path

        Returns:
            Dictionary mapping command names to Command objects
        """
        commands_dir = workspace / ".ads" / "commands"

        if not commands_dir.exists():
            return {}

        commands = {}

        for cmd_file in commands_dir.glob("*.md"):
            try:
                command = CommandLoader._parse_command_file(cmd_file)
                commands[command.name] = command
            except Exception as e:
                # Skip invalid command files
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
        content = file_path.read_text(encoding='utf-8')

        # Extract title (first H1)
        title_match = re.search(r'^#\s+(.+)$', content, re.MULTILINE)
        title = title_match.group(1) if title_match else file_path.stem

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

        description = ' '.join(description_lines) if description_lines else title

        # Extract variables from {{variable}} patterns
        variables = re.findall(r'\{\{(\w+)\}\}', content)
        variables = list(dict.fromkeys(variables))  # Remove duplicates, preserve order

        # Command name is the filename without extension
        name = file_path.stem

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
