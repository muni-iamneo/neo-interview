"""
Centralized Configuration Management
"""

import os
from pathlib import Path
from typing import Optional, List
from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

# Get the backend directory path (where .env should be)
BACKEND_DIR = Path(__file__).parent.parent.parent
ENV_FILE = BACKEND_DIR / ".env"


class Settings(BaseSettings):
    """Application settings with environment variable validation"""
    
    model_config = SettingsConfigDict(
        env_file=str(ENV_FILE),
        env_file_encoding="utf-8",
        case_sensitive=True,
        extra="ignore"
    )
    
    # Server Configuration
    HOST: str = Field(default="0.0.0.0")
    PORT: int = Field(default=8000)
    DEBUG: bool = Field(default=False)
    
    # CORS Configuration
    CORS_ORIGINS: List[str] = Field(
        default=["http://localhost:4200", "http://localhost:4300"]
    )
    
    @field_validator("CORS_ORIGINS", mode="before")
    @classmethod
    def parse_cors_origins(cls, v):
        if isinstance(v, str):
            return [origin.strip() for origin in v.split(",")]
        return v
    
    # JaaS Configuration
    JAA_APP_ID: str = Field(default="")
    JAA_TENANT: Optional[str] = Field(default=None)
    JAA_PUBLIC_KEY_ID: str = Field(default="")
    JAA_PRIVATE_KEY: Optional[str] = Field(default=None)
    JAA_PRIVATE_KEY_FILE: Optional[str] = Field(default=None)
    JAA_EMBED_DOMAIN: str = Field(default="8x8.vc")
    
    # ElevenLabs Configuration
    ELEVENLABS_API_KEY: str = Field(default="")
    ELEVENLABS_AGENT_ID: str = Field(default="")
    ELEVENLABS_WEBSOCKET_URL: str = Field(
        default="wss://api.elevenlabs.io/v1/convai/conversation"
    )
    ELEVENLABS_CONVERSATIONS_API_URL: str = Field(
        default="https://api.elevenlabs.io/v1/convai/conversations"
    )
    ELEVENLABS_MIN_CONVERSATION_DURATION_SECS: int = Field(
        default=90,
        description="Minimum conversation duration in seconds to include in results"
    )

    # Azure OpenAI Configuration (for interview analysis and real-time LLM)
    AZURE_ENDPOINT: str = Field(default="")
    AZURE_OPENAI_API_KEY: str = Field(default="")
    AZURE_OPENAI_MODEL: str = Field(default="gpt-4.1-mini")
    AZURE_OPENAI_DEPLOYMENT: str = Field(default="gpt-4.1-mini-hire")
    OPENAI_API_VERSION: str = Field(default="2025-01-01-preview")

    # Real-time LLM Configuration (for custom voice pipeline)
    AZURE_OPENAI_MAX_TOKENS: int = Field(default=150)
    AZURE_OPENAI_TEMPERATURE: float = Field(default=0.7)
    LLM_CONVERSATIONAL_INSTRUCTIONS: str = Field(
        default="""Rules: 1 question/turn (≤30 words), wait for full response, acknowledge briefly, adapt naturally. Professional yet warm.""",
        description="Conversational instructions appended to all agent system prompts (OPTIMIZED: Shortened for lower latency)"
    )
    
    # Audio Configuration
    AUDIO_SAMPLE_RATE: int = Field(default=16000)
    AUDIO_CHUNK_SIZE: int = Field(default=1024)
    AUDIO_FLUSH_BYTES: int = Field(default=3200)
    AUDIO_FLUSH_INTERVAL: float = Field(default=0.5)
    
    # VAD Configuration
    VAD_THRESHOLD: float = Field(
        default=0.002,
        description="Voice activity threshold (higher = less sensitive, fewer false positives)"
    )
    VAD_PRE_START_CHUNKS: int = Field(
        default=30,
        description="Buffer chunks before speech starts"
    )
    VAD_AUTO_START_CHUNKS: int = Field(
        default=80,
        description="Auto-trigger after N chunks (higher = require longer speech)"
    )
    VAD_MIN_RMS: float = Field(
        default=0.008,
        description="Minimum RMS energy to filter background noise"
    )

    # Voice Provider Configuration
    VOICE_PROVIDER: str = Field(
        default="elevenlabs",
        description="Voice provider: 'elevenlabs' or 'custom'"
    )
    ENABLE_CUSTOM_PIPELINE: bool = Field(
        default=False,
        description="Enable custom STT→LLM→TTS pipeline"
    )

    # AssemblyAI STT Configuration (Cloud API - Ultra-low latency)
    ASSEMBLYAI_API_KEY: str = Field(
        default="",
        description="AssemblyAI API key for streaming STT (~300ms latency)"
    )
    ASSEMBLYAI_WORD_BOOST: list = Field(
        default_factory=lambda: [],
        description="List of keywords to boost recognition accuracy"
    )
    ASSEMBLYAI_ENABLE_PARTIAL: bool = Field(
        default=False,
        description="Enable partial transcripts (for UI updates)"
    )
    ASSEMBLYAI_USE_STANDARD_API: bool = Field(
        default=False,
        description="Use Standard API instead of Streaming (WARNING: +1-2s latency, for testing only)"
    )
    ASSEMBLYAI_LANGUAGE_CODE: str = Field(
        default="en",
        description="Language code for transcription (e.g., 'en', 'es', 'fr')"
    )

    # Kokoro TTS Configuration (CPU-optimized)
    KOKORO_DEVICE: str = Field(
        default="cpu",
        description="Device: cpu or cuda (CPU recommended - 4-8x real-time)"
    )
    KOKORO_REPO_ID: str = Field(
        default="hexgrad/Kokoro-82M",
        description="HuggingFace repository ID for Kokoro model"
    )
    KOKORO_LANG_CODE: str = Field(
        default="a",
        description="Language code: 'a'=American English, 'b'=British English, 'e'=Spanish, 'f'=French, 'h'=Hindi, 'i'=Italian, 'p'=Portuguese, 'j'=Japanese, 'z'=Chinese"
    )
    KOKORO_VOICE: str = Field(
        default="af_heart",
        description="Voice ID: af_heart, af_bella, af_sarah, am_adam, am_michael, etc."
    )
    
    # Session Management
    SESSION_TIMEOUT_SECONDS: int = Field(default=3600)
    SESSION_CLEANUP_INTERVAL: int = Field(default=300)

    # JWT Configuration
    JWT_DEFAULT_TTL_SECONDS: int = Field(default=3600)
    JWT_MAX_TTL_SECONDS: int = Field(default=86400)

    # Links Configuration
    MOD_TOKEN_SECRET: str = Field(default="change-me-in-production")
    LINK_TTL_MINUTES: int = Field(default=1440)  # 24 hours default
    AGENT_MAX_LINKS: int = Field(default=5)
    
    # Redis Configuration
    CACHE_BACKEND_URL: Optional[str] = Field(default=None, description="Redis URL for cache/storage")
    CELERY_BROKER_URL: Optional[str] = Field(default=None, description="Redis URL for Celery broker")
    
    # Logging Configuration
    LOG_LEVEL: str = Field(default="INFO")

    @field_validator("LOG_LEVEL")
    @classmethod
    def validate_log_level(cls, v):
        valid_levels = ["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"]
        if v.upper() not in valid_levels:
            raise ValueError(f"Invalid log level. Must be one of: {valid_levels}")
        return v.upper()
    
    def get_effective_tenant(self) -> str:
        """Get effective tenant (fallback to APP_ID if not specified)"""
        return self.JAA_TENANT or self.JAA_APP_ID


# Global settings instance
_settings: Optional[Settings] = None


def get_settings() -> Settings:
    """Get or create settings singleton"""
    global _settings
    if _settings is None:
        _settings = Settings()
    return _settings


# Create the singleton instance for direct import
settings = get_settings()
