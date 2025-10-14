"""
Graph module exceptions

Custom exceptions for graph operations, replacing FastAPI dependencies.
"""


class GraphException(Exception):
    """Base exception for graph operations"""
    def __init__(self, message: str, status_code: int = 400):
        self.message = message
        self.status_code = status_code
        super().__init__(self.message)


class NodeNotFoundException(GraphException):
    """Node not found exception"""
    def __init__(self, message: str = "Node not found"):
        super().__init__(message, status_code=404)


class InvalidOperationException(GraphException):
    """Invalid operation exception"""
    def __init__(self, message: str):
        super().__init__(message, status_code=400)
