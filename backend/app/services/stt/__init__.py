"""
Speech-to-Text (STT) service implementations.
"""

from app.services.stt.faster_whisper_stt import FasterWhisperSTTService
from app.services.stt.assemblyai_stt import AssemblyAISTTService
from app.services.stt.assemblyai_standard import AssemblyAIStandardSTTService
from app.core.config import settings

__all__ = ["FasterWhisperSTTService", "AssemblyAISTTService", "AssemblyAIStandardSTTService", "get_stt_service"]


def get_stt_service(on_transcript):
    """
    Factory function to get the configured STT service.

    Returns:
        - FasterWhisperSTTService (default, fastest local transcription)
        - AssemblyAIStandardSTTService if ASSEMBLYAI_USE_STANDARD_API=true
        - AssemblyAISTTService (streaming) if USE_ASSEMBLYAI_STREAMING=true
    """
    use_assemblyai_standard = getattr(settings, 'ASSEMBLYAI_USE_STANDARD_API', False)
    use_assemblyai_streaming = getattr(settings, 'USE_ASSEMBLYAI_STREAMING', False)

    if use_assemblyai_standard:
        return AssemblyAIStandardSTTService(on_transcript=on_transcript)
    elif use_assemblyai_streaming:
        return AssemblyAISTTService(on_transcript=on_transcript)
    else:
        # Default: Faster-Whisper (local, fast, no API calls)
        return FasterWhisperSTTService(on_transcript=on_transcript)
