"""
Command executor - executes slash commands with variable substitution
"""

import re
from pathlib import Path
from typing import Dict, Optional

from .loader import Command, CommandLoader


class CommandExecutor:
    """Executes slash commands with variable substitution"""

    @staticmethod
    def execute(
        workspace: Path,
        command_name: str,
        variables: Optional[Dict[str, str]] = None
    ) -> str:
        """
        Execute a command with variable substitution.

        Args:
            workspace: Workspace root path
            command_name: Command name
            variables: Dictionary of variable values

        Returns:
            Expanded command content

        Raises:
            ValueError: If command not found or variables missing
        """
        # Load command
        command = CommandLoader.get_command(workspace, command_name)

        if not command:
            raise ValueError(f"Command not found: {command_name}")

        # Check for missing variables
        variables = variables or {}
        missing_vars = [v for v in command.variables if v not in variables]

        if missing_vars:
            raise ValueError(
                f"Missing required variables for command '{command_name}': "
                f"{', '.join(missing_vars)}"
            )

        # Substitute variables
        expanded = CommandExecutor._substitute_variables(
            command.content,
            variables
        )

        return expanded

    @staticmethod
    def _substitute_variables(content: str, variables: Dict[str, str]) -> str:
        """
        Substitute {{variable}} patterns with values.

        Args:
            content: Template content
            variables: Variable values

        Returns:
            Content with variables substituted
        """
        result = content

        for var_name, var_value in variables.items():
            pattern = r'\{\{' + var_name + r'\}\}'
            result = re.sub(pattern, var_value, result)

        return result

    @staticmethod
    def validate_command(
        workspace: Path,
        command_name: str,
        variables: Optional[Dict[str, str]] = None
    ) -> Dict[str, any]:
        """
        Validate a command and its variables.

        Args:
            workspace: Workspace root path
            command_name: Command name
            variables: Variable values

        Returns:
            Validation result with 'valid', 'errors', 'missing_variables'
        """
        command = CommandLoader.get_command(workspace, command_name)

        if not command:
            return {
                "valid": False,
                "errors": [f"Command not found: {command_name}"],
                "missing_variables": []
            }

        variables = variables or {}
        missing_vars = [v for v in command.variables if v not in variables]

        return {
            "valid": len(missing_vars) == 0,
            "errors": [] if len(missing_vars) == 0 else [
                f"Missing variables: {', '.join(missing_vars)}"
            ],
            "missing_variables": missing_vars,
            "required_variables": command.variables
        }
