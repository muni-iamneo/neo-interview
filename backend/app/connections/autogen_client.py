"""
Azure OpenAI connection configuration and setup.
"""
from typing import Optional, Dict, Any
from autogen_ext.models.openai import AzureOpenAIChatCompletionClient

from ..core.config import get_settings
from ..core.logging_config import get_logger

logger = get_logger(__name__)


class AzureOpenAIConnection:
    """Manages Azure OpenAI client connection and configuration."""

    def __init__(self):
        self.client: Optional[AzureOpenAIChatCompletionClient] = None
        self.model_config: Dict[str, Any] = {}
        self._configure_azure_openai()

    def _configure_azure_openai(self):
        """Configure Azure OpenAI client with settings."""
        settings = get_settings()

        # Validate required environment variables
        if not settings.AZURE_OPENAI_API_KEY:
            raise ValueError("AZURE_OPENAI_API_KEY environment variable is not set")

        if not settings.AZURE_ENDPOINT:
            raise ValueError("AZURE_ENDPOINT environment variable is not set")

        if not settings.AZURE_OPENAI_DEPLOYMENT:
            raise ValueError("AZURE_OPENAI_DEPLOYMENT environment variable is not set")

        if not settings.AZURE_OPENAI_MODEL:
            raise ValueError("AZURE_OPENAI_MODEL environment variable is not set")

        # Create model configuration
        self.model_config = {
            "azure_deployment": settings.AZURE_OPENAI_DEPLOYMENT,
            "model": settings.AZURE_OPENAI_MODEL,
            "api_version": settings.OPENAI_API_VERSION,
            "azure_endpoint": settings.AZURE_ENDPOINT,
            "api_key": settings.AZURE_OPENAI_API_KEY,
            "temperature": 0
        }

        # Create Azure OpenAI client
        self.client = AzureOpenAIChatCompletionClient(**self.model_config)
        logger.info("Azure OpenAI client configured successfully")

    def get_client(self) -> AzureOpenAIChatCompletionClient:
        """Get the configured Azure OpenAI client."""
        if not self.client:
            raise ValueError("Azure OpenAI client not initialized")
        return self.client


# Singleton instance
_azure_client: Optional[AzureOpenAIConnection] = None


def get_azure_client() -> AzureOpenAIConnection:
    """Get or create Azure OpenAI connection singleton."""
    global _azure_client
    if _azure_client is None:
        _azure_client = AzureOpenAIConnection()
    return _azure_client
