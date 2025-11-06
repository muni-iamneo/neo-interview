"""
Audio processing utilities for voice pipeline.

Provides functions for resampling, normalization, and format conversion.
"""

import numpy as np
from typing import Optional

from app.core.logging_config import get_logger

logger = get_logger(__name__)


def resample_pcm16(
    pcm16_data: bytes,
    orig_sample_rate: int,
    target_sample_rate: int,
) -> bytes:
    """
    Resample PCM16 audio data.

    Args:
        pcm16_data: Raw PCM16 bytes.
        orig_sample_rate: Original sample rate (Hz).
        target_sample_rate: Target sample rate (Hz).

    Returns:
        bytes: Resampled PCM16 data.
    """
    if orig_sample_rate == target_sample_rate:
        return pcm16_data

    try:
        from scipy import signal

        # Convert to numpy array
        audio_np = np.frombuffer(pcm16_data, dtype=np.int16)

        # Calculate number of samples in resampled audio
        num_samples = int(len(audio_np) * target_sample_rate / orig_sample_rate)

        # Resample
        resampled = signal.resample(audio_np, num_samples).astype(np.int16)

        return resampled.tobytes()

    except Exception as e:
        logger.error("[Audio Utils] Resampling failed: %s", e)
        return pcm16_data


def normalize_audio(pcm16_data: bytes, target_peak: float = 0.95) -> bytes:
    """
    Normalize PCM16 audio to target peak level.

    Args:
        pcm16_data: Raw PCM16 bytes.
        target_peak: Target peak amplitude (0.0-1.0).

    Returns:
        bytes: Normalized PCM16 data.
    """
    try:
        # Convert to numpy array
        audio_np = np.frombuffer(pcm16_data, dtype=np.int16)

        # Convert to float
        audio_float = audio_np.astype(np.float32) / 32768.0

        # Find current peak
        current_peak = np.abs(audio_float).max()

        if current_peak > 0:
            # Calculate gain
            gain = target_peak / current_peak

            # Apply gain (clip to prevent overflow)
            audio_float = np.clip(audio_float * gain, -1.0, 1.0)

        # Convert back to PCM16
        audio_normalized = (audio_float * 32767).astype(np.int16)

        return audio_normalized.tobytes()

    except Exception as e:
        logger.error("[Audio Utils] Normalization failed: %s", e)
        return pcm16_data


def pcm16_to_float32(pcm16_data: bytes) -> np.ndarray:
    """
    Convert PCM16 bytes to float32 numpy array.

    Args:
        pcm16_data: Raw PCM16 bytes.

    Returns:
        np.ndarray: Float32 array normalized to [-1.0, 1.0].
    """
    audio_np = np.frombuffer(pcm16_data, dtype=np.int16)
    return audio_np.astype(np.float32) / 32768.0


def float32_to_pcm16(audio_float: np.ndarray) -> bytes:
    """
    Convert float32 numpy array to PCM16 bytes.

    Args:
        audio_float: Float32 array in range [-1.0, 1.0].

    Returns:
        bytes: PCM16 bytes.
    """
    # Clip to valid range
    audio_clipped = np.clip(audio_float, -1.0, 1.0)

    # Convert to PCM16
    audio_pcm16 = (audio_clipped * 32767).astype(np.int16)

    return audio_pcm16.tobytes()


def calculate_rms(pcm16_data: bytes) -> float:
    """
    Calculate RMS (Root Mean Square) energy of PCM16 audio.

    Useful for voice activity detection.

    Args:
        pcm16_data: Raw PCM16 bytes.

    Returns:
        float: RMS energy value.
    """
    if not pcm16_data:
        return 0.0

    try:
        audio_np = np.frombuffer(pcm16_data, dtype=np.int16)
        audio_float = audio_np.astype(np.float32) / 32768.0
        rms = np.sqrt(np.mean(audio_float ** 2))
        return float(rms)

    except Exception as e:
        logger.error("[Audio Utils] RMS calculation failed: %s", e)
        return 0.0


def detect_silence(
    pcm16_data: bytes,
    threshold: float = 0.01,
    sample_rate: int = 16000,
) -> bool:
    """
    Detect if audio contains mostly silence.

    Args:
        pcm16_data: Raw PCM16 bytes.
        threshold: RMS threshold for silence detection.
        sample_rate: Sample rate (unused, for future use).

    Returns:
        bool: True if audio is silent.
    """
    rms = calculate_rms(pcm16_data)
    return rms < threshold


def concatenate_pcm16(chunks: list[bytes]) -> bytes:
    """
    Concatenate multiple PCM16 chunks.

    Args:
        chunks: List of PCM16 byte chunks.

    Returns:
        bytes: Concatenated PCM16 data.
    """
    return b"".join(chunks)
