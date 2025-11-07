"""
Voice provider interfaces and implementations.

This package contains abstraction layers for different voice AI providers,
allowing seamless switching between ElevenLabs and custom pipelines.
"""

from app.services.voice_providers.base import (
    BaseVoiceProvider,
    BaseSTTProvider,
    BaseTTSProvider,
    BaseLLMProvider,
    VoiceProviderCallback,
)
from app.services.voice_providers.elevenlabs_provider import (
    ElevenLabsProvider,
    JitsiElevenLabsBridge,
)
from app.services.voice_providers.custom_provider import CustomVoiceProvider

__all__ = [
    "BaseVoiceProvider",
    "BaseSTTProvider",
    "BaseTTSProvider",
    "BaseLLMProvider",
    "VoiceProviderCallback",
    "ElevenLabsProvider",
    "JitsiElevenLabsBridge",
    "CustomVoiceProvider",
]
