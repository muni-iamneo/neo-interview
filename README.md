# Real-Time Jitsi ↔ ElevenLabs Voice Agent

End‑to‑end system enabling a moderator to spin up a JaaS (Jitsi as a Service) meeting, launch a headless AI agent that joins the same room, streams meeting audio to a FastAPI backend, forwards it to ElevenLabs ConvAI, and plays back synthesized agent speech into the browser.

---
## High‑Level Architecture

```
+------------------+            +-------------------+            +---------------------------+            +------------------+
| Moderator (Web)  |            | Agent (Web)       |            | FastAPI Backend          |            | ElevenLabs ConvAI|
| moderator.comp.  |            | agent.component   |            | /jaas/jwt                |            |  WebSocket API   |
| POST /jaas/jwt   |            | Headless lib-jitsi| WebSocket  | /agent/{id}/voice WS     |  wss       |  (16k PCM)       |
| sessionStorage   |            | + Iframe External |===========>|  VAD + Bridge            |===========>|                   |
+---------+--------+            +----------+--------+            +------------+--------------+            +---------+--------+
          |                                ^                                    |                                   ^
          | Opens agent tab                | Raw PCM16 16kHz (AudioWorklet)     | Raw PCM16 16kHz (base64 JSON)     |
          v                                |                                    v                                   |
    sessionStorage --------------------> Reads JWT                         ElevenLabs Bridge                Audio / Text events
```

---
## Core Components & Roles
| Component | File(s) | Purpose |
|-----------|---------|---------|
| Moderator UI | `frontend/src/app/moderator/*` | Mints JaaS JWT (via backend) and persists session info to `sessionStorage`.
| Agent UI (headless + iframe) | `frontend/src/app/agent/agent.component.ts` | Joins meeting (lib-jitsi-meet + iframe), captures remote audio, streams PCM to backend, plays agent audio.
| Audio Worklet | `frontend/public/audio/audio-processor.js` | Downsamples 48k → 16k PCM16, frames & posts raw bytes.
| Backend API | `backend/main.py` | FastAPI app: JWT minting & voice WebSocket endpoint.
| Voice Session Orchestrator | `backend/integrated_voice_endpoint.py` | Manages VAD, session lifecycle, and ElevenLabs bridge.
| ElevenLabs Bridge | `backend/elevenlabs_voice_handler.py` | Maintains ConvAI WebSocket, sends user PCM, receives agent PCM/text.

---
## Environment Variables (.env)
| Var | Description |
|-----|-------------|
| `JAA_APP_ID` | JaaS App ID (also used as tenant if `JAA_TENANT` omitted).
| `JAA_TENANT` | (Optional) Explicit tenant slug; falls back to `JAA_APP_ID`.
| `JAA_PUBLIC_KEY_ID` | Key ID (kid) for JWT header.
| `JAA_PRIVATE_KEY` | PEM private key (\n escaped) OR use `JAA_PRIVATE_KEY_FILE`.
| `JAA_PRIVATE_KEY_FILE` | Path to PEM file (alternative to inline variable).
| `JAA_EMBED_DOMAIN` | Jitsi domain (default `8x8.vc`).
| `ELEVENLABS_API_KEY` | ElevenLabs API key.
| `ELEVENLABS_AGENT_ID` | Target ElevenLabs ConvAI agent ID.

---
## Data & Audio Formats
| Direction | Format | Transport |
|-----------|--------|-----------|
| Agent Browser → Backend | Raw PCM16 mono 16k (binary frames) from AudioWorklet. | WebSocket (binary)
| Agent Browser → Backend (fallback) | `audio/webm` 3s MediaRecorder slices (buffered) | WebSocket (binary Blob)
| Backend → ElevenLabs | Base64 PCM16 in JSON variants (auto‑selected) | WebSocket JSON
| ElevenLabs → Backend | JSON events with base64 PCM16 | WebSocket JSON
| Backend → Agent Browser | Raw PCM16 bytes (forwarded) + JSON status/text | WebSocket (binary + text)
| Agent Browser Playback | Manual wrap into `AudioBuffer` @16k, scheduled sequentially | Web Audio API

---
## End‑to‑End Sequence (Moderator Starts -> Agent Responds)
1. Moderator loads moderator UI and requests JWT:
   - Sends POST `/jaas/jwt` with `{ room, user }`.
   - Backend signs RS256 JaaS JWT using supplied private key & returns `{ domain, room: "tenant/room", jwt }`.
2. Moderator stores the JSON response in `sessionStorage` key `jaasSession`.
3. Moderator opens the Agent page (new tab/window) – no duplicate JWT minting.
4. Agent `ngOnInit()` retrieves `jaasSession`; if absent, shows error.
5. Agent simultaneously:
   - Initializes headless lib-jitsi-meet connection (passing JWT at `JitsiConnection` creation – crucial for avoiding `notAllowed`).
   - Sets up retry loop to embed the Jitsi iframe UI once container element is rendered.
6. On `CONNECTION_ESTABLISHED` → `initJitsiConference` → `conference.join()`.
7. On `CONFERENCE_JOINED`:
   - Creates muted local audio track (satisfies conference audio presence without feedback).
   - Starts the voice WebSocket `/agent/{sessionId}/voice` (early to avoid MediaRecorder race).
8. Remote participant(s) join; polling detects first active remote audio track OR `TRACK_ADDED` fires.
9. Agent extracts remote audio `MediaStreamTrack` → wraps into `MediaStream`.
10. Audio pipeline spin‑up (`pipeStreamToAssembly`):
    - Creates fresh `AudioContext(48k)`.
    - Loads `audio-processor.js` (with fallback path logic).
    - AudioWorklet downsamples to 16k PCM16, posts Uint8Array frames.
    - Frames sent over voice WebSocket (meeting source increments meeting chunk counters).
11. Simultaneously a `MediaRecorder` records 3s `audio/webm` slices (secondary path) – chunks are buffered until WS open.
12. Backend voice endpoint (`integrated_voice_endpoint.py`) receives binary frames:
    - Before conversation start: lightweight VAD (RMS energy) accumulates.
    - Triggers `start_conversation()` with ElevenLabs when speech, RMS threshold, or timeout condition met.
13. ElevenLabs ConvAI WebSocket established (`elevenlabs_voice_handler.py`): waits for `conversation_initiation_metadata` (no proactive user init message) before accepting buffered audio.
14. Once ready + started:
    - Backend queues PCM chunks to ElevenLabs (100ms or 0.5s flush logic) with multiple JSON payload fallbacks.
15. ElevenLabs emits JSON events containing base64 PCM16 audio & textual agent responses.
16. Backend decodes base64 → forwards raw PCM binary frames (as bytes) + separate JSON `text_response` messages to the agent browser.
17. Agent browser `onmessage` handler:
    - Text frames append to transcript signal.
    - Binary frames treated as raw 16k PCM16; converted Int16 → Float32, wrapped into `AudioBuffer`, scheduled using `nextPlaybackTime` for pop‑free continuous playback (no `decodeAudioData`).
18. User optionally enables mic streaming (`toggleMicStreaming`): microphone stream passes through same worklet path (tagged as `mic`), feeding VAD/agent.
19. Track changes / departures:
    - On `TRACK_REMOVED` or participant left: stop recording, re‑enter polling state to latch onto the next active track.
20. Cleanup on component destroy: stop MediaRecorder, remove tracks, close WebSocket, leave conference.

---
## Key Design Decisions & Rationale
| Decision | Rationale |
|----------|-----------|
| Single JWT minted by moderator | Eliminates dual-JWT auth conflicts & simplifies auth model.
| Headless + iframe dual approach | Headless handles precise audio capture; iframe provides user UI & standard controls.
| Early WebSocket init + buffering | Prevents losing first MediaRecorder / worklet frames while WS is CONNECTING.
| AudioWorklet downsampling client-side | Reduces bandwidth & matches ElevenLabs 16k PCM expectation, minimizing server CPU.
| Manual PCM playback (no `decodeAudioData`) | ElevenLabs returns raw PCM (not containerized), avoids `EncodingError`.
| VAD gating of `start_conversation()` | Prevents agent from greeting on silence or join noise.
| Multiple payload variants to ElevenLabs | Improves resilience across API versions / schema shifts.

---
## WebSocket Message Types (Backend ⇄ Agent)
| Direction | Type | Payload | Purpose |
|-----------|------|---------|---------|
| Agent → Backend | (binary) | Raw PCM16 | User / meeting audio.
| Agent → Backend | `status` | `{ type: 'status' }` | Triggers status response from backend.
| Agent → Backend | `force_start` | `{ type: 'force_start' }` | Manual override to start conversation.
| Backend → Agent | `status` | `{ type:'status', started, ...}` | Session / bridge state.
| Backend → Agent | `text_response` | `{ type:'text_response', text }` | Agent textual output.
| Backend → Agent | `audio_response` | `{ type:'audio_response', size }` | Metadata for accompanying audio binary.
| Backend → Agent | `error` | `{ type:'error', message }` | Error reporting.
| Backend → Agent | (binary) | Raw PCM16 | Agent synthesized speech.

---
## Audio Pipeline Internals
1. `MediaStreamTrack` (48kHz mono assumed) → `AudioContext` (48k).
2. `MediaStreamSource` → `AudioWorkletNode('audio-processor')`.
3. Worklet:
   - Buffers incoming 128 frame blocks.
   - Resamples (simple averaging / ratio mapping) to 16k.
   - Emits fixed target frame size (1024 samples) PCM16 Uint8Array messages.
   - (Optional VAD or silence thresholds can be extended here.)
4. Browser sends frames over WS (binary). Backend treats bytes directly.
5. Reverse path: raw PCM16 from ElevenLabs → scheduled playback at 16k (no resample needed).

---
## Failure & Recovery Strategies
| Scenario | Handling |
|----------|----------|
| WS not yet open when first chunks ready | Chunks pushed to `pendingAudioChunks`; flushed on `onopen`.
| Worklet script path mismatch | Fallback load attempt `/audio-processor.js` after `/audio/audio-processor.js`.
| Lost remote track | Stop recorder, restart polling until a live remote audio track found.
| ElevenLabs initiation delay | Buffered early user audio retained (limited) until conversation metadata arrives.
| No speech detected | Auto-start after configured chunk/time threshold (prevents dead session).
| Odd-length PCM frame | Padding applied before building `Int16Array` for playback.

---
## Local Development
### Prerequisites
- Python 3.12+
- Node 18+
- Valid JaaS keys & ElevenLabs API credentials in `.env` (at project root or `backend/`).

### Install & Run
```bash
# Backend
cd backend
python -m venv venv
source venv/bin/activate
pip install -r requirements.txt  # (If requirements file maintained)
python -m uvicorn main:app --host 0.0.0.0 --port 8000 --reload

# Frontend (new terminal)
cd ../frontend
npm install
ng serve
```
Navigate to: `http://localhost:4200` (moderator UI) then open agent page (implementation dependent – e.g., link or manual route).

### Testing Flow
1. Start backend & frontend.
2. Moderator: obtain JWT (observe network tab POST `/jaas/jwt`).
3. Open Agent tab → console should show:
   - `✅ Jitsi headless conference joined`
   - `✅ Voice WebSocket connected`
   - `🔄 Setting up audio pipeline for meeting...`
4. Speak in moderator channel; watch backend logs for VAD / start message.
5. Observe `text_response` and hear agent synthesized audio playback.

---
## Extensibility Ideas
| Enhancement | Notes |
|-------------|-------|
| Inject agent audio back into conference | Create `MediaStreamTrackGenerator` from PCM playback & add as Jitsi local track.
| Replace naive resampler | Use dedicated polyphase or WebAssembly for lower distortion.
| Adaptive VAD | Integrate WebRTC VAD or RNNoise for robust speech detection.
| Transcript overlay | Add speech-to-text (optional) using minimal external service.
| Reconnection logic | Automatic exponential backoff for voice WS & ElevenLabs reconnect.

---
## Security Considerations
- Never expose private key in frontend; JWT minted only server-side.
- Limit JWT TTL and scope to specific room.
- Consider origin restrictions / CSRF hardening for `/jaas/jwt`.
- Audio is raw PCM (PII risk); secure transport (wss) recommended in production (update WS URLs to wss + HTTPS backend).

---
## Troubleshooting Cheat Sheet
| Symptom | Likely Cause | Fix |
|---------|--------------|-----|
| `conference.connectionError.notAllowed` | JWT not passed at `JitsiConnection` | Ensure token in constructor, not only in `initJitsiConference`.
| `WebSocket not open. Buffering meeting audio chunk.` | Race at startup | Expected; confirm flush logs after connect.
| `EncodingError: Unable to decode audio data` | Tried `decodeAudioData` on raw PCM | Fixed by manual PCM playback (see `injectAudioIntoJitsi`).
| No agent response | VAD never triggered | Speak louder / adjust RMS threshold / send `force_start`.
| Choppy audio | Overlapping scheduling or dropped frames | Inspect `nextPlaybackTime` drift & buffering, tune frame size.
| Silence after some time | ElevenLabs connection closed | Add reconnect logic (future enhancement).

---
## Quick Reference: Critical Functions
| Location | Function | Responsibility |
|----------|----------|----------------|
| `agent.component.ts` | `joinJaas` | Establish headless + iframe Jitsi clients.
| `agent.component.ts` | `pipeStreamToAssembly` | Build AudioWorklet pipeline & forward PCM.
| `agent.component.ts` | `injectAudioIntoJitsi` | Raw PCM playback scheduling.
| `integrated_voice_endpoint.py` | `process_audio` | VAD gating + forwarding to bridge.
| `elevenlabs_voice_handler.py` | `queue_pcm` | Buffer & flush user PCM to ElevenLabs.
| `elevenlabs_voice_handler.py` | `_handle_event` | Demultiplex ElevenLabs JSON events.

---
## License / Usage
Internal interview / prototype project. Add license text here if distributing.

---
## Summary
This system stitches together JaaS meeting participation, low-latency client‑side resampling, adaptive conversation start via lightweight VAD, and resilient PCM streaming to/from ElevenLabs. The agent now joins reliably, streams intelligible audio, and plays synthesized responses without decoding errors or lost startup frames.
