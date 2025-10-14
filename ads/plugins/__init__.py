"""
ADS 插件系统

提供插件接口定义、加载和注册机制。
"""

from .interface import Plugin, PluginMetadata
from .loader import PluginLoader
from .registry import PluginRegistry

__all__ = [
    'Plugin',
    'PluginMetadata',
    'PluginLoader',
    'PluginRegistry',
]
