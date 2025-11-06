"""
Model Preloader Service

Preloads heavy models (Faster-Whisper STT and Kokoro TTS) during application startup
to avoid delays when users connect to voice sessions.
"""

import asyncio
from typing import Optional, Set

from app.core.config import get_settings
from app.core.logging_config import get_logger

settings = get_settings()
logger = get_logger(__name__)


class ModelPreloaderService:
    """
    Preloads heavy ML models during application startup.

    This ensures models are downloaded and cached before the first user
    connection, eliminating delays during voice session initialization.

    Preloads:
    - Faster-Whisper STT model (distil-medium.en)
    - Kokoro TTS pipeline
    """

    def __init__(self):
        self.kokoro_pipeline = None
        self.whisper_model = None
        self.loaded_providers: Set[str] = set()

    async def preload_models(self) -> None:
        """
        Preload models for all voice providers that might be used.

        Since users can configure different voice providers per agent,
        we need to preload models for all enabled providers.
        """
        logger.info("[Model Preloader] Starting model preloading...")

        # Determine which providers to preload based on configuration
        providers_to_load = self._determine_providers_to_preload()

        if not providers_to_load:
            logger.info("[Model Preloader] No voice providers enabled for preloading")
            return

        logger.info("[Model Preloader] Will preload models for providers: %s",
                   ", ".join(providers_to_load))

        # Preload models for each provider
        preload_tasks = []

        if "neo" in providers_to_load:
            preload_tasks.append(self._preload_neo_models())

        # Note: ElevenLabs doesn't require local model preloading (cloud-based)
        if "elevenlabs" in providers_to_load:
            logger.info("[Model Preloader] ElevenLabs provider is cloud-based, no local models to preload")
            self.loaded_providers.add("elevenlabs")

        # Run preloading tasks concurrently
        if preload_tasks:
            await asyncio.gather(*preload_tasks, return_exceptions=True)

        logger.info("[Model Preloader] Model preloading complete. Loaded providers: %s",
                   ", ".join(self.loaded_providers))

    def _determine_providers_to_preload(self) -> Set[str]:
        """
        Determine which voice providers should have models preloaded.

        Returns:
            Set of provider names to preload ("neo", "elevenlabs", etc.)
        """
        providers = set()

        # Check global settings
        if settings.VOICE_PROVIDER.lower() == "neo" or settings.ENABLE_CUSTOM_PIPELINE:
            providers.add("neo")

        if settings.VOICE_PROVIDER.lower() == "elevenlabs":
            providers.add("elevenlabs")

        # TODO: Optionally check all configured agents to see which providers they use
        # This would require loading agent configs, which we can add if needed
        # For now, we'll preload based on: if EITHER provider could be used, preload it

        # If we have ElevenLabs config, assume it might be used
        if settings.ELEVENLABS_API_KEY:
            providers.add("elevenlabs")

        # If we have custom pipeline enabled or Azure config, assume NEO might be used
        if settings.ENABLE_CUSTOM_PIPELINE or settings.AZURE_OPENAI_API_KEY:
            providers.add("neo")

        return providers

    async def _preload_neo_models(self) -> None:
        """Preload models for NEO (custom) provider: Faster-Whisper STT and Kokoro TTS."""
        try:
            logger.info("[Model Preloader] Preloading NEO provider models (STT + TTS)...")

            # Preload both STT and TTS in parallel
            await asyncio.gather(
                self._preload_whisper(),
                self._preload_kokoro(),
                return_exceptions=True
            )

            self.loaded_providers.add("neo")
            logger.info("[Model Preloader] NEO provider models loaded successfully")

        except Exception as e:
            logger.error("[Model Preloader] Failed to preload NEO models: %s", e, exc_info=True)

    async def _preload_whisper(self) -> None:
        """Preload Faster-Whisper STT model."""
        try:
            logger.info("[Model Preloader] Preloading Faster-Whisper STT model...")
            start_time = asyncio.get_event_loop().time()

            # Import here to avoid loading if not needed
            from faster_whisper import WhisperModel

            # Load model in thread pool to avoid blocking
            loop = asyncio.get_event_loop()
            self.whisper_model = await loop.run_in_executor(
                None,
                lambda: WhisperModel("distil-medium.en", device="cpu", compute_type="int8")
            )

            elapsed = asyncio.get_event_loop().time() - start_time
            logger.info(
                "[Model Preloader] Faster-Whisper STT loaded successfully in %.2f seconds",
                elapsed
            )

        except Exception as e:
            logger.error("[Model Preloader] Failed to preload Faster-Whisper STT: %s", e, exc_info=True)
            logger.warning("[Model Preloader] Faster-Whisper will be loaded on-demand when user connects")
            self.whisper_model = None

    async def _preload_kokoro(self) -> None:
        """Preload Kokoro TTS pipeline."""
        try:
            logger.info("[Model Preloader] Preloading Kokoro TTS pipeline...")
            start_time = asyncio.get_event_loop().time()

            # Import here to avoid loading if not needed
            from kokoro import KPipeline
            import torch

            # Determine device
            device = settings.KOKORO_DEVICE
            if device == "auto":
                try:
                    device = "cuda" if torch.cuda.is_available() else "cpu"
                except Exception:
                    device = "cpu"

            lang_code = settings.KOKORO_LANG_CODE
            repo_id = settings.KOKORO_REPO_ID

            logger.info("[Model Preloader] Loading Kokoro pipeline: lang=%s, device=%s, repo=%s",
                       lang_code, device, repo_id)

            # Load pipeline in thread pool to avoid blocking
            loop = asyncio.get_event_loop()
            self.kokoro_pipeline = await loop.run_in_executor(
                None,
                lambda: KPipeline(lang_code=lang_code, repo_id=repo_id, device=device)
            )

            elapsed = asyncio.get_event_loop().time() - start_time
            logger.info(
                "[Model Preloader] Kokoro TTS loaded successfully in %.2f seconds (sample_rate=24000 Hz)",
                elapsed
            )

        except Exception as e:
            logger.error("[Model Preloader] Failed to preload Kokoro: %s", e, exc_info=True)
            logger.warning("[Model Preloader] Kokoro will be loaded on first use instead")
            self.kokoro_pipeline = None

    def get_whisper_model(self) -> Optional[any]:
        """
        Get the preloaded Faster-Whisper model instance.

        Returns:
            The preloaded model or None if not loaded.
        """
        return self.whisper_model

    def get_kokoro_pipeline(self) -> Optional[any]:
        """
        Get the preloaded Kokoro pipeline instance.

        Returns:
            The preloaded pipeline or None if not loaded.
        """
        return self.kokoro_pipeline

    def is_provider_loaded(self, provider: str) -> bool:
        """
        Check if a specific provider's models are loaded.

        Args:
            provider: Provider name ("neo", "elevenlabs", etc.)

        Returns:
            True if provider is loaded and ready.
        """
        return provider.lower() in self.loaded_providers


# Global singleton instance
_preloader_service: Optional[ModelPreloaderService] = None


def get_preloader_service() -> ModelPreloaderService:
    """Get the global model preloader service instance."""
    global _preloader_service
    if _preloader_service is None:
        _preloader_service = ModelPreloaderService()
    return _preloader_service
