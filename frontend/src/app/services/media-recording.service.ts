import { Injectable } from '@angular/core';
import { ConfigService } from './config.service';

/**
 * Media Recording Service
 * Handles MediaRecorder for capturing meeting audio in chunks
 */
@Injectable({
  providedIn: 'root'
})
export class MediaRecordingService {
  private mediaRecorder: MediaRecorder | null = null;
  private recordedChunks: Blob[] = [];
  private onChunkCallback: ((chunk: Blob) => void) | null = null;

  constructor(private config: ConfigService) {}

  /**
   * Start recording from a media stream
   */
  startRecording(stream: MediaStream, onChunk: (chunk: Blob) => void): void {
    if (this.mediaRecorder) {
      this.stopRecording();
    }

    this.recordedChunks = [];
    this.onChunkCallback = onChunk;

    const options = { mimeType: this.config.RECORDER_MIME_TYPE };
    this.mediaRecorder = new MediaRecorder(stream, options);

    this.mediaRecorder.onstart = () => {
      console.log('⏺️ Recorder started');
    };

    this.mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        this.recordedChunks.push(event.data);
      }
    };

    this.mediaRecorder.onstop = () => {
      const blob = new Blob(this.recordedChunks, { type: this.config.RECORDER_MIME_TYPE });
      if (this.onChunkCallback) {
        this.onChunkCallback(blob);
      }
      this.recordedChunks = [];
    };

    this.mediaRecorder.start(this.config.RECORDER_TIME_SLICE);
    console.log('⏺️ Started recording meeting audio.');
  }

  /**
   * Stop recording
   */
  stopRecording(): void {
    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      this.mediaRecorder.stop();
      console.log('⏹️ Stopped recording meeting audio.');
    }
    this.onChunkCallback = null;
  }

  /**
   * Check if currently recording
   */
  isRecording(): boolean {
    return this.mediaRecorder !== null && this.mediaRecorder.state === 'recording';
  }

  /**
   * Cleanup resources
   */
  cleanup(): void {
    this.stopRecording();
    this.mediaRecorder = null;
    this.recordedChunks = [];
    this.onChunkCallback = null;
  }
}
