"""
Text processing utilities for voice pipeline.

Provides functions for sentence splitting and text normalization.
"""

import re
from typing import List

from app.core.logging_config import get_logger

logger = get_logger(__name__)


def split_into_sentences(text: str, max_length: int = 200) -> List[str]:
    """
    Split text into sentences for streaming TTS.

    Uses regex to identify sentence boundaries and splits long sentences
    if they exceed max_length.

    Args:
        text: Input text to split.
        max_length: Maximum characters per sentence.

    Returns:
        List[str]: List of sentences.
    """
    if not text or not text.strip():
        return []

    # Normalize whitespace
    text = " ".join(text.split())

    # Sentence boundary patterns
    # Match: period, question mark, exclamation, followed by space and capital letter
    # Also handle abbreviations (Mr., Dr., etc.)
    sentence_pattern = r'(?<!\w\.\w.)(?<![A-Z][a-z]\.)(?<=\.|\?|\!)\s+(?=[A-Z])'

    # Split by sentence boundaries
    sentences = re.split(sentence_pattern, text)

    # Further split long sentences by commas, semicolons, or conjunctions
    result = []
    for sentence in sentences:
        sentence = sentence.strip()
        if not sentence:
            continue

        if len(sentence) <= max_length:
            result.append(sentence)
        else:
            # Split by commas, semicolons, or conjunctions
            chunks = re.split(r'[,;]|\s+(?:and|but|or|so)\s+', sentence)
            current_chunk = ""

            for chunk in chunks:
                chunk = chunk.strip()
                if not chunk:
                    continue

                if len(current_chunk) + len(chunk) + 1 <= max_length:
                    if current_chunk:
                        current_chunk += " " + chunk
                    else:
                        current_chunk = chunk
                else:
                    if current_chunk:
                        result.append(current_chunk)
                    current_chunk = chunk

            if current_chunk:
                result.append(current_chunk)

    return result


def normalize_text(text: str) -> str:
    """
    Normalize text for TTS.

    - Remove extra whitespace
    - Normalize punctuation
    - Handle common abbreviations

    Args:
        text: Input text.

    Returns:
        str: Normalized text.
    """
    if not text:
        return ""

    # Remove extra whitespace
    text = " ".join(text.split())

    # Normalize multiple punctuation marks
    text = re.sub(r'([.!?]){2,}', r'\1', text)

    # Ensure space after punctuation
    text = re.sub(r'([.!?,;:])([A-Za-z])', r'\1 \2', text)

    return text.strip()


def estimate_speech_duration(text: str, words_per_minute: int = 150) -> float:
    """
    Estimate speech duration in seconds.

    Args:
        text: Input text.
        words_per_minute: Average speaking rate.

    Returns:
        float: Estimated duration in seconds.
    """
    if not text:
        return 0.0

    # Count words
    words = len(text.split())

    # Calculate duration
    duration = (words / words_per_minute) * 60.0

    return duration


def truncate_text(text: str, max_chars: int = 500, suffix: str = "...") -> str:
    """
    Truncate text to maximum length.

    Tries to break at sentence boundary if possible.

    Args:
        text: Input text.
        max_chars: Maximum characters.
        suffix: Suffix to append if truncated.

    Returns:
        str: Truncated text.
    """
    if len(text) <= max_chars:
        return text

    # Try to truncate at sentence boundary
    truncated = text[:max_chars]

    # Find last sentence boundary
    last_period = truncated.rfind('.')
    last_question = truncated.rfind('?')
    last_exclamation = truncated.rfind('!')

    last_boundary = max(last_period, last_question, last_exclamation)

    if last_boundary > max_chars * 0.8:  # Only use boundary if it's not too early
        truncated = truncated[:last_boundary + 1]
    else:
        truncated = truncated.rstrip() + suffix

    return truncated


def remove_markdown(text: str) -> str:
    """
    Remove markdown formatting from text for TTS.

    Args:
        text: Input text with markdown.

    Returns:
        str: Plain text without markdown.
    """
    # Remove code blocks
    text = re.sub(r'```[\s\S]*?```', '', text)
    text = re.sub(r'`[^`]+`', '', text)

    # Remove bold/italic
    text = re.sub(r'\*\*([^*]+)\*\*', r'\1', text)
    text = re.sub(r'\*([^*]+)\*', r'\1', text)
    text = re.sub(r'__([^_]+)__', r'\1', text)
    text = re.sub(r'_([^_]+)_', r'\1', text)

    # Remove links [text](url)
    text = re.sub(r'\[([^\]]+)\]\([^)]+\)', r'\1', text)

    # Remove headers
    text = re.sub(r'^#{1,6}\s+', '', text, flags=re.MULTILINE)

    return text.strip()
