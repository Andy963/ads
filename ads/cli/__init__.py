"""
CLI commands for ADS.

只保留 init 命令，其他功能通过 MCP 使用。
"""

from .init import init

__all__ = ['init']
