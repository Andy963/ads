"""
Template renderer - renders templates with variable substitution
"""

import re
from typing import Dict, Any


class TemplateRenderer:
    """Renders templates with variable substitution"""

    @staticmethod
    def render(template: str, variables: Dict[str, Any]) -> str:
        """
        Render template with variable substitution.

        Supports:
        - {{variable}} - simple substitution
        - {{variable|default_value}} - with default value
        - {{#if variable}}...{{/if}} - conditional blocks (future)

        Args:
            template: Template string
            variables: Variable values

        Returns:
            Rendered string
        """
        result = template

        # Handle {{variable|default}} pattern
        def replace_with_default(match):
            var_name = match.group(1)
            default = match.group(2) if match.lastindex >= 2 else ""
            return str(variables.get(var_name, default))

        result = re.sub(
            r'\{\{(\w+)\|([^}]*)\}\}',
            replace_with_default,
            result
        )

        # Handle simple {{variable}} pattern
        def replace_simple(match):
            var_name = match.group(1)
            return str(variables.get(var_name, f"{{{{var_name}}}}"))

        result = re.sub(
            r'\{\{(\w+)\}\}',
            replace_simple,
            result
        )

        return result

    @staticmethod
    def validate(template: str, variables: Dict[str, Any]) -> Dict[str, Any]:
        """
        Validate template rendering.

        Args:
            template: Template string
            variables: Variable values

        Returns:
            Validation result with 'valid', 'missing_variables', 'errors'
        """
        # Extract required variables (those without defaults)
        required = re.findall(r'\{\{(\w+)\}\}', template)

        # Extract variables with defaults
        with_defaults = re.findall(r'\{\{(\w+)\|[^}]*\}\}', template)

        # Remove variables that have defaults
        required = [v for v in required if v not in with_defaults]

        # Find missing variables
        missing = [v for v in required if v not in variables]

        return {
            "valid": len(missing) == 0,
            "missing_variables": missing,
            "required_variables": list(set(required)),
            "optional_variables": list(set(with_defaults)),
            "errors": [] if len(missing) == 0 else [
                f"Missing required variables: {', '.join(missing)}"
            ]
        }

    @staticmethod
    def extract_variables(template: str) -> Dict[str, Any]:
        """
        Extract all variables from template.

        Args:
            template: Template string

        Returns:
            Dictionary with 'required' and 'optional' variable lists
        """
        # Extract all variables
        all_vars = re.findall(r'\{\{(\w+)(?:\|[^}]*)?\}\}', template)

        # Extract variables with defaults (optional)
        optional = re.findall(r'\{\{(\w+)\|[^}]*\}\}', template)

        # Required are those without defaults
        required = [v for v in all_vars if v not in optional]

        return {
            "required": list(dict.fromkeys(required)),
            "optional": list(dict.fromkeys(optional)),
            "all": list(dict.fromkeys(all_vars))
        }
