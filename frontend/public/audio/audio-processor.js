// audio-processor.js
// Enhanced version for reliable audio capture

class AudioProcessor extends AudioWorkletProcessor {
    constructor(options) {
      super();
      
      // Configuration
      this.sourceSampleRate = (options?.processorOptions?.sourceSampleRate) || 48000;
      this.targetSampleRate = 16000; // ElevenLabs expects 16kHz
      this.resampleRatio = this.sourceSampleRate / this.targetSampleRate;
      this.frameCounter = 0;
      this.lastLogTime = currentTime;
      this.lastInputTime = currentTime;
      
      // Buffer for accumulating samples (helps with small frames)
      this.sampleBuffer = new Float32Array(0);
      this.targetFrameSize = 1024; // Target ~64ms chunks at 16kHz
      
      // For audio activity detection
      this.silenceCounter = 0;
      this.energyThreshold = 0.0005; // Very sensitive
      
      console.log(`[AudioWorklet] Initialized: source=${this.sourceSampleRate}Hz, target=${this.targetSampleRate}Hz, ratio=${this.resampleRatio}`);
      
      this.port.onmessage = (event) => {
        // Handle messages from main thread if needed
        if (event.data.type === 'setThreshold') {
          this.energyThreshold = event.data.value;
        }
      };
    }
  
    // Process audio data: downsample, convert to PCM16, send to main thread
    process(inputs, outputs, parameters) {
      const input = inputs[0];

      // If no input, send silence to keep the connection alive
      if (!input || input.length === 0 || !input[0] || input[0].length === 0) {
        if (currentTime - this.lastInputTime > 0.1) { // Send silence every 100ms
          const silenceBuffer = new Float32Array(320); // 20ms @ 16kHz
          const pcm16 = this.floatTo16BitPCM(silenceBuffer);
          this.port.postMessage(pcm16, [pcm16.buffer]);
          this.lastInputTime = currentTime;
        }
        return true; // Keep processor alive
      }
      
      this.lastInputTime = currentTime;
      const inputData = input[0]; // First channel
      this.frameCounter++;
      
      // Log periodically to confirm processor is running
      if (currentTime - this.lastLogTime > 5) {
        console.log(`[AudioWorklet] Still active: processed ${this.frameCounter} frames, current frame size: ${inputData.length}`);
        this.lastLogTime = currentTime;
      }
      
      // Check if there's actual audio (not just silence)
      const energy = this.calculateEnergy(inputData);
      const hasAudio = energy > this.energyThreshold;
      
      if (hasAudio) {
        this.silenceCounter = 0;
        
        // Add to buffer
        const newBuffer = new Float32Array(this.sampleBuffer.length + inputData.length);
        newBuffer.set(this.sampleBuffer);
        newBuffer.set(inputData, this.sampleBuffer.length);
        this.sampleBuffer = newBuffer;
        
        // Process buffer when it's large enough
        while (this.sampleBuffer.length >= this.targetFrameSize * this.resampleRatio) {
          // Extract chunk for processing
          const chunkSize = Math.floor(this.targetFrameSize * this.resampleRatio);
          const chunk = this.sampleBuffer.slice(0, chunkSize);
          this.sampleBuffer = this.sampleBuffer.slice(chunkSize);
          
          // 1. Downsample to 16kHz
          const downsampled = this.downsample(chunk);
          
          // 2. Convert to 16-bit PCM
          const pcm16 = this.floatTo16BitPCM(downsampled);
          
          // 3. Send to main thread
          this.port.postMessage(pcm16, [pcm16.buffer]);
        }
      } else {
        // Count consecutive silent frames
        this.silenceCounter++;
        
        // Every ~500ms of silence, send a small silence packet
        if (this.silenceCounter % 10 === 0) {
          // Create a short silence buffer (16kHz, 20ms)
          const silenceBuffer = new Float32Array(320); // 20ms @ 16kHz
          const pcm16 = this.floatTo16BitPCM(silenceBuffer);
          this.port.postMessage(pcm16, [pcm16.buffer]);
        }
        
        // Reset buffer on extended silence to avoid stale audio
        if (this.silenceCounter > 50) { // ~2.5s of silence
          this.sampleBuffer = new Float32Array(0);
        }
      }
      
      return true; // Keep processor alive
    }
    
    // Calculate audio energy for voice activity detection
    calculateEnergy(samples) {
      let sum = 0;
      for (let i = 0; i < samples.length; i++) {
        sum += samples[i] * samples[i];
      }
      return sum / samples.length;
    }
  
    downsample(input) {
      if (!input) return new Float32Array(0);
      const newLen = Math.floor(input.length / this.resampleRatio);
      const result = new Float32Array(newLen);
      let idx = 0;
      let pos = 0;
      while (idx < newLen) {
        const nextPos = Math.round((idx + 1) * this.resampleRatio);
        let sum = 0;
        let count = 0;
        for (let i = pos; i < nextPos && i < input.length; i++) {
          sum += input[i];
          count++;
        }
        result[idx] = count ? sum / count : 0;
        idx++;
        pos = nextPos;
      }
      return result;
    }
  
    floatTo16BitPCM(input) {
      const buffer = new ArrayBuffer(input.length * 2);
      const view = new DataView(buffer);
      for (let i = 0; i < input.length; i++) {
        const s = Math.max(-1, Math.min(1, input[i]));
        view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      }
      return new Uint8Array(buffer);
    }
  }
  
  registerProcessor('audio-processor', AudioProcessor);
