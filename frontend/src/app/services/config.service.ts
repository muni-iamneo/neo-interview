import { Injectable } from '@angular/core';

/**
 * Configuration Service
 * Centralizes all configuration values to avoid hardcoding
 */
@Injectable({
  providedIn: 'root'
})
export class ConfigService {
  // API Configuration
  readonly API_BASE_URL = 'http://localhost:8000';
  readonly WS_BASE_URL = 'ws://localhost:8000';

  // Audio Configuration
  readonly AUDIO_SAMPLE_RATE = 48000;
  readonly AUDIO_TARGET_SAMPLE_RATE = 16000;
  // readonly AUDIO_CHUNK_SIZE = 1024; // Reserved for future use
  readonly AUDIO_WORKLET_PATH = '/audio/audio-processor.js';
  readonly AUDIO_WORKLET_FALLBACK_PATH = '/audio-processor.js';

  // Jitsi Configuration
  readonly JITSI_DOMAIN = '8x8.vc';
  readonly JITSI_SCRIPTS_TIMEOUT = 8000; // ms
  readonly JITSI_IFRAME_RETRY_ATTEMPTS = 20;
  readonly JITSI_IFRAME_RETRY_DELAY = 150; // ms

  // WebSocket Configuration
  readonly WS_RECONNECT_INTERVAL = 2000; // ms
  readonly WS_MAX_RECONNECT_ATTEMPTS = 5;
  // readonly WS_PING_INTERVAL = 30000; // Reserved for keepalive pings

  // Session Configuration
  readonly DEFAULT_SESSION_ID = 'testsession'; // TODO: Generate unique IDs
  readonly FORCE_START_TIMEOUT = 5000; // ms

  // Recording Configuration
  readonly RECORDER_TIME_SLICE = 3000; // ms
  readonly RECORDER_MIME_TYPE = 'audio/webm';

  // Polling Configuration
  readonly TRACK_POLLING_INTERVAL = 2500; // ms

  // Timeouts - Reserved for future use
  // readonly AUDIO_CONTEXT_RESUME_TIMEOUT = 1000; // ms
  // readonly CLEANUP_DELAY = 2000; // ms

  constructor() {}

  /**
   * Get WebSocket URL for voice connection
   */
  getVoiceWebSocketUrl(sessionId: string): string {
    return `${this.WS_BASE_URL}/agent/${sessionId}/voice`;
  }

  /**
   * Get API endpoint URL
   */
  getApiUrl(endpoint: string): string {
    return `${this.API_BASE_URL}${endpoint}`;
  }
}

