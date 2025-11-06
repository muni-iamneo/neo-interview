"""
Speech-to-Text (STT) service implementations.
"""

from app.services.stt.assemblyai_stt import AssemblyAISTTService
from app.services.stt.assemblyai_standard import AssemblyAIStandardSTTService
from app.core.config import settings

__all__ = ["AssemblyAISTTService", "AssemblyAIStandardSTTService", "get_stt_service"]


def get_stt_service(on_transcript):
    """
    Factory function to get the configured STT service.

    Returns:
        - AssemblyAIStandardSTTService if ASSEMBLYAI_USE_STANDARD_API=true
        - AssemblyAISTTService (streaming) otherwise (default, recommended)
    """
    use_standard = getattr(settings, 'ASSEMBLYAI_USE_STANDARD_API', False)

    if use_standard:
        return AssemblyAIStandardSTTService(on_transcript=on_transcript)
    else:
        return AssemblyAISTTService(on_transcript=on_transcript)
