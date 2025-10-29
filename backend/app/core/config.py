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
    
    # Audio Configuration
    AUDIO_SAMPLE_RATE: int = Field(default=16000)
    AUDIO_CHUNK_SIZE: int = Field(default=1024)
    AUDIO_FLUSH_BYTES: int = Field(default=3200)
    AUDIO_FLUSH_INTERVAL: float = Field(default=0.5)
    
    # VAD Configuration
    VAD_THRESHOLD: float = Field(default=0.0005)
    VAD_PRE_START_CHUNKS: int = Field(default=25)
    VAD_AUTO_START_CHUNKS: int = Field(default=60)
    VAD_MIN_RMS: float = Field(default=0.003)
    
    # Session Management
    MAX_ACTIVE_SESSIONS: int = Field(default=100)
    SESSION_TIMEOUT_SECONDS: int = Field(default=3600)
    SESSION_CLEANUP_INTERVAL: int = Field(default=300)
    
    # WebSocket Configuration
    WS_HEARTBEAT_INTERVAL: int = Field(default=30)
    WS_MESSAGE_MAX_SIZE: int = Field(default=10 * 1024 * 1024)
    
    # JWT Configuration
    JWT_DEFAULT_TTL_SECONDS: int = Field(default=3600)
    JWT_MAX_TTL_SECONDS: int = Field(default=86400)
    
    # Redis Configuration
    CACHE_BACKEND_URL: Optional[str] = Field(default=None, description="Redis URL for cache/storage")
    CELERY_BROKER_URL: Optional[str] = Field(default=None, description="Redis URL for Celery broker")
    
    # Logging Configuration
    LOG_LEVEL: str = Field(default="INFO")
    LOG_FORMAT: str = Field(
        default="%(asctime)s - %(name)s - %(levelname)s - %(message)s"
    )
    
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

