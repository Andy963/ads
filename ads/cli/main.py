"""
ADS CLI 主入口
"""

import typer
from rich.console import Console

from .init import init
from .setup import Client as SetupClient
from .setup import setup_client

app = typer.Typer(
    name="ads",
    help="ADS - AI-Driven Specification",
    no_args_is_help=True
)

console = Console()

app.command("init")(init)
app.command("setup")(setup_client)


@app.command()
def version():
    """显示版本信息"""
    console.print("[cyan]ADS[/cyan] v0.1.0")
    console.print("AI-Driven Specification")
    console.print("\n[dim]提示：除了 MCP 集成外，现在可以直接在终端使用 ads.new、ads.status 等命令驱动工作流[/dim]")


def main():
    """Main entry point for the CLI."""
    app()


if __name__ == "__main__":
    main()
