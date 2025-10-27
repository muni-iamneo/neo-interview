import { Injectable } from '@angular/core';
import { ConfigService } from './config.service';

/**
 * Audio Processing Service
 * Handles audio context, worklet processing, and audio stream management
 */
@Injectable({
  providedIn: 'root'
})
export class AudioProcessingService {
  private audioContext: AudioContext | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private isWorkletLoaded = false;

  constructor(private config: ConfigService) {}

  /**
   * Initialize audio context
   */
  async initializeAudioContext(sampleRate: number = this.config.AUDIO_SAMPLE_RATE): Promise<AudioContext> {
    if (!this.audioContext || this.audioContext.state === 'closed') {
      this.audioContext = new AudioContext({ sampleRate });
    }
    
    // Resume if suspended
    if (this.audioContext.state === 'suspended') {
      await this.audioContext.resume();
    }
    
    return this.audioContext;
  }

  /**
   * Load audio worklet module
   */
  async loadWorklet(audioContext: AudioContext): Promise<boolean> {
    if (this.isWorkletLoaded) {
      return true;
    }

    if (!audioContext.audioWorklet) {
      console.error('[Audio] AudioWorklet not supported');
      return false;
    }

    try {
      // Try primary path
      await audioContext.audioWorklet.addModule(this.config.AUDIO_WORKLET_PATH);
      this.isWorkletLoaded = true;
      console.log('[Audio] Worklet loaded from primary path');
      return true;
    } catch (primaryErr) {
      console.warn('[Audio] Primary worklet path failed, trying fallback', primaryErr);
      
      try {
        // Try fallback path
        await audioContext.audioWorklet.addModule(this.config.AUDIO_WORKLET_FALLBACK_PATH);
        this.isWorkletLoaded = true;
        console.log('[Audio] Worklet loaded from fallback path');
        return true;
      } catch (fallbackErr) {
        console.error('[Audio] All worklet paths failed', fallbackErr);
        return false;
      }
    }
  }

  /**
   * Setup audio processing pipeline
   */
  async setupPipeline(
    stream: MediaStream,
    onAudioChunk: (data: Uint8Array) => void
  ): Promise<boolean> {
    try {
      // Close existing context if any
      if (this.audioContext) {
        await this.audioContext.close();
        this.audioContext = null;
        this.isWorkletLoaded = false;
      }

      // Initialize new context
      const context = await this.initializeAudioContext();

      // Check for audio tracks
      if (stream.getAudioTracks().length === 0) {
        console.error('[Audio] No audio tracks in stream');
        return false;
      }

      // Load worklet
      const loaded = await this.loadWorklet(context);
      if (!loaded) {
        return false;
      }

      // Create source node
      this.sourceNode = context.createMediaStreamSource(stream);

      // Create worklet node
      this.workletNode = new AudioWorkletNode(context, 'audio-processor', {
        processorOptions: { sourceSampleRate: context.sampleRate }
      });

      // Setup message handler
      this.workletNode.port.onmessage = (event) => {
        onAudioChunk(event.data);
      };

      // Connect pipeline
      this.sourceNode.connect(this.workletNode).connect(context.destination);

      console.log('[Audio] Pipeline setup complete');
      return true;

    } catch (error) {
      console.error('[Audio] Pipeline setup failed:', error);
      return false;
    }
  }

  /**
   * Create audio buffer from PCM16 data
   */
  createBufferFromPCM16(pcm16: ArrayBuffer, sampleRate: number = 16000): AudioBuffer | null {
    if (!this.audioContext) {
      console.error('[Audio] No audio context available');
      return null;
    }

    try {
      // Validate data
      if (pcm16.byteLength === 0) {
        return null;
      }

      // Handle odd-length data
      let validLength = pcm16.byteLength;
      if (validLength % 2 !== 0) {
        console.warn('[Audio] Odd-length PCM data, trimming');
        validLength -= 1;
      }

      // Convert to Int16Array
      const pcmData = new Int16Array(pcm16.slice(0, validLength));

      // Upsample if needed (16k -> 48k)
      let upsampled: Float32Array<ArrayBuffer>;
      if (sampleRate === 16000 && this.audioContext.sampleRate === 48000) {
        upsampled = this.upsample16to48(pcmData);
      } else {
        // Convert to float
        const buffer = new ArrayBuffer(pcmData.length * 4);
        upsampled = new Float32Array(buffer);
        for (let i = 0; i < pcmData.length; i++) {
          upsampled[i] = pcmData[i] / 32768.0;
        }
      }

      // Create audio buffer
      const buffer = this.audioContext.createBuffer(
        1,
        upsampled.length,
        this.audioContext.sampleRate
      );
      buffer.copyToChannel(upsampled, 0);

      return buffer;

    } catch (error) {
      console.error('[Audio] Failed to create buffer:', error);
      return null;
    }
  }

  /**
   * Simple upsampling from 16k to 48k (3x duplication)
   */
  private upsample16to48(pcm16: Int16Array): Float32Array<ArrayBuffer> {
    const buffer = new ArrayBuffer(pcm16.length * 3 * 4); // 4 bytes per float
    const upsampled = new Float32Array(buffer);
    for (let i = 0; i < pcm16.length; i++) {
      const v = pcm16[i] / 32768.0;
      const o = i * 3;
      upsampled[o] = v;
      upsampled[o + 1] = v;
      upsampled[o + 2] = v;
    }
    return upsampled;
  }

  /**
   * Resume audio context (needed for user interaction)
   */
  async resumeAudioContext(): Promise<boolean> {
    if (!this.audioContext) {
      console.warn('[Audio] No audio context to resume');
      return false;
    }

    if (this.audioContext.state === 'suspended') {
      try {
        await this.audioContext.resume();
        console.log('[Audio] Audio context resumed');
        return true;
      } catch (error) {
        console.error('[Audio] Failed to resume audio context:', error);
        return false;
      }
    }

    return true;
  }

  /**
   * Cleanup audio resources
   */
  async cleanup(): Promise<void> {
    console.log('[Audio] Cleaning up audio resources');

    if (this.workletNode) {
      this.workletNode.disconnect();
      this.workletNode = null;
    }

    if (this.sourceNode) {
      this.sourceNode.disconnect();
      this.sourceNode = null;
    }

    if (this.audioContext && this.audioContext.state !== 'closed') {
      await this.audioContext.close();
      this.audioContext = null;
    }

    this.isWorkletLoaded = false;
  }
}

