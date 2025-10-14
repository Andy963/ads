"""
Template system for ADS.

Supports project-level custom templates from .ads/templates/
"""

from .loader import TemplateLoader
from .renderer import TemplateRenderer

__all__ = ["TemplateLoader", "TemplateRenderer"]
