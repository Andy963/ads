"""Command executor - executes slash commands with variable substitution."""

import re
from pathlib import Path
from typing import Any, Dict, Optional, Union

from .loader import CommandLoader


class CommandExecutor:
    """Executes slash commands with variable substitution."""

    def __init__(self, loader: Union[CommandLoader, Path, str]):
        if isinstance(loader, CommandLoader):
            self.loader = loader
        else:
            self.loader = CommandLoader(loader)

    def execute(
        self,
        command_name: str,
        variables: Optional[Dict[str, str]] = None,
    ) -> Optional[str]:
        """Execute a command using the configured loader."""

        command = self.loader.load_command(command_name)
        if not command:
            return None

        variables = variables or {}
        missing_vars = [v for v in command.variables if v not in variables]
        if missing_vars:
            # 兼容旧实现：缺少变量时保留原模板
            return CommandExecutor._substitute_variables(command.content, variables)

        return CommandExecutor._substitute_variables(command.content, variables)

    def validate(
        self,
        command_name: str,
        variables: Optional[Dict[str, str]] = None,
    ) -> Dict[str, Any]:
        """Validate variables against a command definition."""

        command = self.loader.load_command(command_name)
        if not command:
            return {
                "valid": False,
                "errors": [f"Command not found: {command_name}"],
                "missing_variables": [],
            }

        variables = variables or {}
        missing_vars = [v for v in command.variables if v not in variables]

        return {
            "valid": len(missing_vars) == 0,
            "errors": [] if not missing_vars else [
                f"Missing variables: {', '.join(missing_vars)}"
            ],
            "missing_variables": missing_vars,
            "required_variables": command.variables,
        }

    @staticmethod
    def execute_for_workspace(
        workspace: Path,
        command_name: str,
        variables: Optional[Dict[str, str]] = None,
    ) -> Optional[str]:
        """Static helper retained for backwards compatibility (raises on error)."""

        loader = CommandLoader(workspace)
        command = loader.load_command(command_name)
        if not command:
            raise ValueError(f"Command not found: {command_name}")

        variables = variables or {}
        missing_vars = [v for v in command.variables if v not in variables]
        if missing_vars:
            raise ValueError(
                f"Missing required variables for command '{command_name}': "
                f"{', '.join(missing_vars)}"
            )

        return CommandExecutor._substitute_variables(command.content, variables)

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
        variables: Optional[Dict[str, str]] = None,
    ) -> Dict[str, Any]:
        """Static helper retained for backwards compatibility."""

        return CommandExecutor(workspace).validate(command_name, variables)
