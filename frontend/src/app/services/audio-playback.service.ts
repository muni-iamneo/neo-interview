import { Injectable } from '@angular/core';

/**
 * Audio Playback Service
 * Handles agent audio playback, PCM processing, and conference audio injection
 */
@Injectable({
  providedIn: 'root'
})
export class AudioPlaybackService {
  private agentPlaybackContext: AudioContext | null = null;
  private agentOutDest: MediaStreamAudioDestinationNode | null = null;
  private nextPlaybackTime = 0;
  private audioContextsResumed = false;
  private activeNodes: Set<AudioBufferSourceNode> = new Set();

  constructor() {}

  /**
   * Initialize audio playback context
   */
  async initializePlaybackContext(sampleRate: number = 48000): Promise<void> {
    if (!this.agentPlaybackContext || this.agentPlaybackContext.state === 'closed') {
      this.agentPlaybackContext = new AudioContext({ sampleRate });
      this.agentOutDest = this.agentPlaybackContext.createMediaStreamDestination();
      console.log('🎧 Created agent playback context and destination node');
    }
  }

  /**
   * Resume audio contexts (requires user interaction)
   */
  async resumeAudioContexts(): Promise<void> {
    if (this.audioContextsResumed) {
      return;
    }

    try {
      if (this.agentPlaybackContext && this.agentPlaybackContext.state === 'suspended') {
        await this.agentPlaybackContext.resume();
        console.log('🎧 Agent playback context resumed');
      }

      this.audioContextsResumed = true;
      console.log('✅ All audio contexts resumed successfully');
    } catch (error) {
      console.error('❌ Failed to resume audio contexts:', error);
    }
  }

  /**
   * Process and inject audio blob into Jitsi
   * Converts raw PCM16 (16k) to playable buffer and injects into conference
   */
  async injectAudioBlob(audioBlob: Blob): Promise<MediaStreamTrack | null> {
    try {
      if (!this.agentPlaybackContext || this.agentPlaybackContext.state === 'closed') {
        console.warn('⚠️ Playback context closed, re-initializing...');
        await this.initializePlaybackContext();
      }

      if (this.agentPlaybackContext?.state === 'suspended') {
        console.warn('⚠️ Playback context suspended, attempting resume...');
        await this.resumeAudioContexts();
      }

      const arrayBuffer = await audioBlob.arrayBuffer();
      if (arrayBuffer.byteLength === 0) {
        console.warn('⚠️ Received empty audio blob');
        return null;
      }

      // Log every chunk for debugging
      console.log(`🔊 Processing audio chunk: ${arrayBuffer.byteLength} bytes, ContextState: ${this.agentPlaybackContext?.state}`);

      if (arrayBuffer.byteLength % 2 !== 0) {
        console.warn('⚠️ Odd-length PCM chunk');
      }

      const pcm16 = new Int16Array(
        arrayBuffer.slice(0, arrayBuffer.byteLength - (arrayBuffer.byteLength % 2))
      );

      // Upsample 16k -> 48k (simple 3x duplication)
      const upsampled = new Float32Array(pcm16.length * 3);
      for (let i = 0; i < pcm16.length; i++) {
        const v = pcm16[i] / 32768;
        const o = i * 3;
        upsampled[o] = v;
        upsampled[o + 1] = v;
        upsampled[o + 2] = v;
      }

      const buffer = this.agentPlaybackContext!.createBuffer(1, upsampled.length, 48000);
      buffer.copyToChannel(upsampled, 0);

      if (this.nextPlaybackTime < this.agentPlaybackContext!.currentTime) {
        this.nextPlaybackTime = this.agentPlaybackContext!.currentTime;
      }

      const src = this.agentPlaybackContext!.createBufferSource();
      src.buffer = buffer;

      if (this.agentOutDest) {
        src.connect(this.agentOutDest);
      }

      // Track this node for potential interruption
      this.activeNodes.add(src);
      src.onended = () => {
        this.activeNodes.delete(src);
      };

      src.start(this.nextPlaybackTime);
      const duration = buffer.duration;
      this.nextPlaybackTime += duration;

      console.log(`🔊 Agent chunk queued (${(duration * 1000).toFixed(1)} ms) next=${this.nextPlaybackTime.toFixed(3)}`);

      // Return the audio track for injection into conference
      return this.agentOutDest?.stream.getAudioTracks()[0] || null;
    } catch (e) {
      console.error('❌ Agent audio injection/playback failed:', e);
      return null;
    }
  }

  /**
   * Get the audio destination track for conference injection
   */
  getDestinationTrack(): MediaStreamTrack | null {
    return this.agentOutDest?.stream.getAudioTracks()[0] || null;
  }

  /**
   * Check if destination is ready
   */
  hasDestination(): boolean {
    return this.agentOutDest !== null;
  }

  /**
   * Clear all scheduled audio and reset playback state
   * Called when user interrupts agent speech
   */
  clearBuffer(): void {
    if (!this.agentPlaybackContext) {
      return;
    }
    
    console.log('🛑 Clearing audio buffer due to interruption');
    
    // Stop all active/scheduled audio nodes
    const nodesToStop = Array.from(this.activeNodes);
    console.log(`🛑 Stopping ${nodesToStop.length} active audio nodes`);
    
    for (const node of nodesToStop) {
      try {
        node.stop();
        this.activeNodes.delete(node);
      } catch (e) {
        // Node might have already ended, ignore error
      }
    }
    
    // Reset playback timing to current time
    this.nextPlaybackTime = this.agentPlaybackContext.currentTime;
    
    console.log('✅ Audio buffer cleared, playback reset');
  }

  /**
   * Get current playback context
   */
  getPlaybackContext(): AudioContext | null {
    return this.agentPlaybackContext;
  }

  /**
   * Cleanup audio resources
   */
  async cleanup(): Promise<void> {
    console.log('[AudioPlayback] Cleaning up resources...');

    try {
      if (this.agentPlaybackContext && this.agentPlaybackContext.state !== 'closed') {
        await this.agentPlaybackContext.close();
        console.log('🎧 Closed agent playback context');
      }
    } catch (e) {
      console.warn('⚠️ Error closing agent playback context:', e);
    }

    this.agentPlaybackContext = null;
    this.agentOutDest = null;
    this.nextPlaybackTime = 0;
    this.audioContextsResumed = false;
  }
}
