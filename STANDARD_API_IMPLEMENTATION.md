# AssemblyAI Standard API Implementation Guide

## ⚠️ Warning: This Will Increase Latency by 1-2 Seconds

This guide shows how to switch from Streaming API to Standard API, but **this is NOT recommended** for real-time voice conversations due to significantly higher latency.

---

## 📝 Implementation Steps

### Step 1: Install Additional Dependencies

```bash
pip install webrtcvad  # For voice activity detection
pip install pydub      # For audio file handling
```

### Step 2: Create Standard API Service

Create: `backend/app/services/stt/assemblyai_standard.py`

```python
import asyncio
import logging
import requests
import io
import wave
from typing import Callable, Optional
import webrtcvad
from pydub import AudioSegment

from app.core.config import settings

logger = logging.getLogger(__name__)


class AssemblyAIStandardSTT:
    """
    AssemblyAI Standard (non-streaming) STT implementation.

    WARNING: Higher latency than streaming API (~1.5-3 seconds vs 0.7-0.8 seconds)
    """

    def __init__(self, on_transcript: Callable[[str], None]):
        self.on_transcript = on_transcript
        self.sample_rate = settings.AUDIO_SAMPLE_RATE
        self.api_key = settings.ASSEMBLYAI_API_KEY

        # Voice Activity Detection
        self.vad = webrtcvad.Vad()
        self.vad.set_mode(3)  # Most aggressive (0-3, higher = more aggressive)

        # Audio buffer
        self.audio_buffer = bytearray()
        self.silence_chunks = 0
        self.silence_threshold = 30  # ~1 second at 30ms chunks
        self.min_audio_length = 16000 * 2 * 0.5  # 0.5 seconds minimum

        # State
        self.is_recording = False
        self.is_initialized = False

        logger.info("[AssemblyAI Standard] Initialized")

    async def initialize(self) -> bool:
        """Initialize the service."""
        try:
            # Verify API key works
            response = requests.get(
                "https://api.assemblyai.com/v2/transcript",
                headers={"authorization": self.api_key},
                timeout=5
            )
            if response.status_code == 401:
                logger.error("[AssemblyAI Standard] Invalid API key")
                return False

            self.is_initialized = True
            logger.info("[AssemblyAI Standard] Initialized successfully")
            return True

        except Exception as e:
            logger.error(f"[AssemblyAI Standard] Initialization failed: {e}")
            return False

    async def send_audio(self, audio_chunk: bytes) -> None:
        """
        Buffer audio chunks and detect silence.
        When silence detected, send complete audio for transcription.
        """
        if not self.is_initialized:
            return

        # Add to buffer
        self.audio_buffer.extend(audio_chunk)

        # Check if this chunk is speech or silence using VAD
        # VAD requires 10, 20, or 30ms frames
        frame_duration = 30  # ms
        frame_size = int(self.sample_rate * 2 * frame_duration / 1000)

        is_speech = False
        try:
            # Check last frame for speech
            if len(audio_chunk) >= frame_size:
                frame = audio_chunk[-frame_size:]
                is_speech = self.vad.is_speech(frame, self.sample_rate)
        except Exception as e:
            logger.debug(f"[AssemblyAI Standard] VAD error: {e}")
            # Assume speech if VAD fails
            is_speech = True

        if is_speech:
            self.silence_chunks = 0
            if not self.is_recording:
                self.is_recording = True
                logger.info("[AssemblyAI Standard] Speech detected, recording...")
        else:
            if self.is_recording:
                self.silence_chunks += 1

                # Check if enough silence to end recording
                if self.silence_chunks >= self.silence_threshold:
                    if len(self.audio_buffer) >= self.min_audio_length:
                        logger.info(
                            "[AssemblyAI Standard] Silence detected, transcribing %.1fs of audio...",
                            len(self.audio_buffer) / (self.sample_rate * 2)
                        )
                        # Send audio for transcription (non-blocking)
                        asyncio.create_task(self._transcribe_audio(bytes(self.audio_buffer)))

                    # Reset
                    self.audio_buffer.clear()
                    self.is_recording = False
                    self.silence_chunks = 0

    async def _transcribe_audio(self, audio_data: bytes) -> None:
        """
        Upload audio to AssemblyAI and get transcription.
        This is the slow part - requires upload + processing.
        """
        try:
            import time
            start_time = time.time()

            # Step 1: Create WAV file in memory
            wav_io = io.BytesIO()
            with wave.open(wav_io, 'wb') as wav_file:
                wav_file.setnchannels(1)  # Mono
                wav_file.setsampwidth(2)  # 16-bit
                wav_file.setframerate(self.sample_rate)
                wav_file.writeframes(audio_data)
            wav_data = wav_io.getvalue()

            upload_time = time.time()
            logger.info("[AssemblyAI Standard] Audio file created (%.0fms)", (upload_time - start_time) * 1000)

            # Step 2: Upload audio file
            upload_response = await asyncio.to_thread(
                requests.post,
                "https://api.assemblyai.com/v2/upload",
                headers={"authorization": self.api_key},
                data=wav_data,
                timeout=30
            )

            if upload_response.status_code != 200:
                logger.error(f"[AssemblyAI Standard] Upload failed: {upload_response.text}")
                return

            upload_url = upload_response.json()["upload_url"]
            process_time = time.time()
            logger.info("[AssemblyAI Standard] Audio uploaded (%.0fms)", (process_time - upload_time) * 1000)

            # Step 3: Create transcription job
            transcript_response = await asyncio.to_thread(
                requests.post,
                "https://api.assemblyai.com/v2/transcript",
                headers={"authorization": self.api_key},
                json={
                    "audio_url": upload_url,
                    "language_code": settings.ASSEMBLYAI_LANGUAGE_CODE
                },
                timeout=30
            )

            if transcript_response.status_code != 200:
                logger.error(f"[AssemblyAI Standard] Transcription request failed: {transcript_response.text}")
                return

            transcript_id = transcript_response.json()["id"]
            poll_time = time.time()
            logger.info("[AssemblyAI Standard] Transcription job created (%.0fms)", (poll_time - process_time) * 1000)

            # Step 4: Poll for result (this is the slow part)
            while True:
                status_response = await asyncio.to_thread(
                    requests.get,
                    f"https://api.assemblyai.com/v2/transcript/{transcript_id}",
                    headers={"authorization": self.api_key},
                    timeout=30
                )

                result = status_response.json()
                status = result["status"]

                if status == "completed":
                    transcript_text = result.get("text", "").strip()
                    end_time = time.time()
                    total_latency = (end_time - start_time) * 1000

                    logger.info(
                        "[AssemblyAI Standard] Transcription completed (%.0fms total): '%s'",
                        total_latency,
                        transcript_text[:100]
                    )

                    if transcript_text:
                        await self._safe_callback(transcript_text)
                    break

                elif status == "error":
                    logger.error(f"[AssemblyAI Standard] Transcription error: {result.get('error')}")
                    break

                # Wait before polling again
                await asyncio.sleep(0.1)  # Poll every 100ms

        except Exception as e:
            logger.error(f"[AssemblyAI Standard] Transcription failed: {e}", exc_info=True)

    async def _safe_callback(self, text: str) -> None:
        """Safely call the transcript callback."""
        try:
            if asyncio.iscoroutinefunction(self.on_transcript):
                await self.on_transcript(text)
            else:
                self.on_transcript(text)
        except Exception as e:
            logger.error(f"[AssemblyAI Standard] Callback error: {e}", exc_info=True)

    async def close(self) -> None:
        """Clean up resources."""
        # Process any remaining audio
        if len(self.audio_buffer) >= self.min_audio_length:
            logger.info("[AssemblyAI Standard] Processing remaining audio...")
            await self._transcribe_audio(bytes(self.audio_buffer))

        self.audio_buffer.clear()
        self.is_initialized = False
        logger.info("[AssemblyAI Standard] Closed")
```

### Step 3: Update Service Factory

Modify: `backend/app/services/stt/__init__.py`

```python
from app.core.config import settings
from app.services.stt.assemblyai_stt import AssemblyAISTT
from app.services.stt.assemblyai_standard import AssemblyAIStandardSTT

def get_stt_service(on_transcript):
    """Factory function to get STT service."""

    # Check which implementation to use
    use_standard = getattr(settings, 'ASSEMBLYAI_USE_STANDARD_API', False)

    if use_standard:
        return AssemblyAIStandardSTT(on_transcript=on_transcript)
    else:
        return AssemblyAISTT(on_transcript=on_transcript)
```

### Step 4: Add Configuration

Add to `backend/app/core/config.py`:

```python
class Settings(BaseSettings):
    # ... existing settings ...

    # AssemblyAI API type
    ASSEMBLYAI_USE_STANDARD_API: bool = False  # Set to True to use standard API
```

### Step 5: Update requirements.txt

```txt
webrtcvad==2.0.10
pydub==0.25.1
```

---

## 🧪 Testing the Implementation

### Switch to Standard API:

1. Set environment variable:
```bash
export ASSEMBLYAI_USE_STANDARD_API=true
```

2. Or modify `.env`:
```
ASSEMBLYAI_USE_STANDARD_API=true
```

3. Restart backend

### Compare Performance:

**Test with Streaming API (current):**
```bash
# Make sure ASSEMBLYAI_USE_STANDARD_API=false
# Say: "Hello, how are you?"
# Measure time from speech end to agent response
# Expected: 2.5-3.5 seconds
```

**Test with Standard API:**
```bash
# Set ASSEMBLYAI_USE_STANDARD_API=true
# Say: "Hello, how are you?"
# Measure time from speech end to agent response
# Expected: 3.5-5.5 seconds (noticeably slower)
```

---

## 📊 Expected Results

### Latency Measurements:

| Component | Streaming API | Standard API | Difference |
|-----------|---------------|--------------|------------|
| Silence detection | 500ms (server) | 1,000-1,500ms (local) | +500-1,000ms |
| Upload time | N/A | 200-500ms | +200-500ms |
| Processing | 200-300ms | 500-1,000ms | +300-700ms |
| **Total STT** | **700-800ms** | **1,700-3,000ms** | **+1,000-2,200ms** |
| **Total E2E** | **2,800-3,500ms** | **3,900-5,500ms** | **+1,100-2,000ms** |

### User Experience:

**Streaming API:**
- User: "Hello" → Agent responds in 2.5s ✅
- Feels natural and conversational

**Standard API:**
- User: "Hello" → Agent responds in 4.0s ❌
- Noticeable lag, feels slow

---

## ⚠️ Limitations and Issues

### 1. Voice Activity Detection Accuracy
- Local VAD not as good as server-side
- May cut off speech prematurely
- May wait too long in silence

### 2. File Size and Upload
- Longer speech = larger files = longer upload
- Network latency varies
- Can't optimize further

### 3. Processing Time
- Server processes entire file (not streaming)
- Can't parallelize like streaming
- Wait for complete result

### 4. No Incremental Feedback
- User doesn't know if system heard them
- No visual feedback until transcription complete
- Poor UX

---

## 🎯 Recommendation

**DO NOT switch to Standard API for real-time voice interviews.**

The Streaming API is significantly better for your use case:
- ✅ 40-60% lower latency
- ✅ Better user experience
- ✅ Server-side optimized silence detection
- ✅ Real-time feedback
- ✅ Designed for conversations

**When to use Standard API:**
- ✅ Batch transcription of recorded files
- ✅ Non-real-time applications
- ✅ When accuracy > latency
- ✅ Post-call analysis

**For your voice interview system: KEEP STREAMING API** ✅

---

## 📝 Alternative: Hybrid Approach

If you want simpler code but still need low latency, consider:

1. **Keep Streaming API** for real-time transcription
2. **Simplify your current implementation** by removing timeout complexity
3. **Only send on end_of_turn** (already fixed in your code!)

This gives you the best of both worlds:
- ✅ Low latency (700-800ms STT)
- ✅ Simple logic (no partial transcript handling)
- ✅ One transcript per utterance
- ✅ Natural conversation flow

---

## 📞 Support

**If you implement this and need help:**
1. Check VAD sensitivity (vad.set_mode parameter)
2. Adjust silence_threshold for your use case
3. Monitor upload times (may need CDN/closer server)
4. Compare latency measurements with streaming

**But seriously: Stick with Streaming API!** 🚀
