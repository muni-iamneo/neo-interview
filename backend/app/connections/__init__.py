"""
Connection modules for external services.
"""
from .autogen_client import AzureOpenAIConnection, get_azure_client

__all__ = ["AzureOpenAIConnection", "get_azure_client"]
