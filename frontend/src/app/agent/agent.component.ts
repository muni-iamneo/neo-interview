import { Component, OnInit, signal, OnDestroy } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { AudioPlaybackService } from '../services/audio-playback.service';
import { ConfigService } from '../services/config.service';
import { JitsiService, JitsiTrackInfo } from '../services/jitsi.service';
import { MediaRecordingService } from '../services/media-recording.service';
import { SessionManagementService } from '../services/session-management.service';

@Component({
  selector: 'app-agent',
  standalone: true,
  imports: [],
  templateUrl: './agent.component.html'
})
export class AgentComponent implements OnInit, OnDestroy {
  constructor(
    private http: HttpClient,
    private audioPlayback: AudioPlaybackService,
    private config: ConfigService,
    private jitsiService: JitsiService,
    private mediaRecording: MediaRecordingService,
    public sessionManagement: SessionManagementService
  ) {}

  private voiceWs: WebSocket | null = null;
  private wsStarted = false;
  private meetingChunkCount = 0;
  private pendingAudioChunks: Blob[] = [];

  // Store JaaS connection details
  private jaasDomain: string = '';
  private jaasRoom: string = '';
  private jaasJwt: string = '';

  // Mic streaming state
  isMicStreaming = signal(false);
  private micStream: MediaStream | null = null;
  private micWorkletNode: AudioWorkletNode | null = null;
  private micChunkCount = 0;
  private audioContext: AudioContext | null = null;

  // UI state
  agentResponses = signal<string>('');

  // Expose session management signals for template
  get sessionId() { return this.sessionManagement.sessionId; }
  get hasValidSession() { return this.sessionManagement.hasValidSession; }
  get sessionInfo() { return this.sessionManagement.sessionInfo; }
  get canRejoin() { return this.sessionManagement.canRejoin; }
  get interviewStatus() { return this.sessionManagement.interviewStatus; }
  get showEndConfirm() { return this.sessionManagement.showEndConfirm; }

  getStatusBorderColor(): string {
    return this.sessionManagement.getStatusBorderColor();
  }

  async ngOnInit(): Promise<void> {
    await this.jitsiService.waitForJitsiScripts();

    try {
      // Initialize session from storage
      const sessionData = this.sessionManagement.initializeFromStorage();

      if (!sessionData) {
        console.error('❌ No JaaS session found. Please start from moderator page first.');
        return;
      }

      // Check session status
      const sessionInfo = await this.sessionManagement.checkSessionStatus();
      if (sessionInfo) {
        // Handle dropped/paused session
        await this.sessionManagement.handleDroppedSession(sessionInfo, (msg) => {
          this.agentResponses.update(t => t + msg);
        });
      }

      this.sessionManagement.setHasValidSession(true);
      await this.joinJaas(sessionData.jaasSession.domain, sessionData.jaasSession.room, sessionData.jaasSession.jwt);

      // Start periodic session info refresh
      this.sessionManagement.startSessionInfoRefresh();
    } catch (error) {
      console.error('Failed to initialize agent component:', error);
    }
  }

  ngOnDestroy(): void {
    console.log('Destroying agent component, cleaning up resources...');
    this.cleanup();
  }

  private async joinJaas(domain: string, room: string, jwt: string): Promise<void> {
    this.jaasDomain = domain;
    this.jaasRoom = room;
    this.jaasJwt = jwt;

    // Setup iframe (may run before template renders, so retry)
    this.jitsiService.setupIframeWithRetry(
      room,
      jwt,
      this.config.JITSI_IFRAME_RETRY_ATTEMPTS,
      this.config.JITSI_IFRAME_RETRY_DELAY,
      () => {
        if (!this.wsStarted) {
          this.wsStarted = true;
          this.setupWebSockets(this.sessionManagement.getSessionId());
        }
      }
    );

    // Setup event listeners for Jitsi service
    this.setupJitsiEventListeners();

    // Join headless conference
    try {
      await this.jitsiService.joinConference({ domain, room, jwt });
    } catch (error) {
      console.error('Failed to join conference:', error);
    }
  }

  private setupJitsiEventListeners(): void {
    // Conference joined
    this.jitsiService.conferenceJoined$.subscribe(async () => {
      try {
        await this.jitsiService.ensurePlaceholderAudioTrack();
      } catch (err) {
        console.warn('⚠️ Failed to create placeholder audio track:', err);
      }

      if (!this.wsStarted) {
        this.wsStarted = true;
        this.setupWebSockets(this.sessionManagement.getSessionId());
      }

      this.jitsiService.startPollingForTrack();
    });

    // Remote track added
    this.jitsiService.remoteTrackAdded$.subscribe((trackInfo: JitsiTrackInfo) => {
      this.handleRemoteTrack(trackInfo);
    });

    // Remote track removed
    this.jitsiService.remoteTrackRemoved$.subscribe(() => {
      this.mediaRecording.stopRecording();
      this.jitsiService.startPollingForTrack();
    });

    // P2P status changed
    this.jitsiService.p2pStatusChanged$.subscribe(async () => {
      setTimeout(async () => {
        console.log('🔄 P2P transition - checking audio injection...');

        if (this.audioPlayback.hasDestination()) {
          const destTrack = this.audioPlayback.getDestinationTrack();
          if (destTrack) {
            await this.jitsiService.reInjectAgentAudio(destTrack);
          }
        }
      }, 500);
    });

    // Connection restored
    this.jitsiService.connectionRestored$.subscribe(async () => {
      setTimeout(async () => {
        console.log('🔄 Connection restored - checking audio injection...');

        if (this.audioPlayback.hasDestination()) {
          const destTrack = this.audioPlayback.getDestinationTrack();
          if (destTrack) {
            await this.jitsiService.reInjectAgentAudio(destTrack);
          }
        }
      }, 500);
    });

    // Conference errors
    this.jitsiService.conferenceError$.subscribe((error) => {
      this.agentResponses.update(t => t + `[ERROR] Conference error: ${JSON.stringify(error)}\n`);
    });
  }

  private handleRemoteTrack(trackInfo: JitsiTrackInfo): void {
    const mediaTrack = trackInfo.track.getTrack();
    if (!mediaTrack || !mediaTrack.enabled || mediaTrack.readyState !== 'live') {
      return console.error('❌ No enabled MediaStreamTrack found in Jitsi track.');
    }

    if (this.jitsiService.getActiveRemoteTrackId() === mediaTrack.id) {
      return console.log(`ℹ️ Track ${mediaTrack.id} already active.`);
    }

    console.log(`[handleRemoteTrack] Processing new track ${mediaTrack.id} - Candidate has joined!`);
    this.jitsiService.setActiveRemoteTrackId(mediaTrack.id);

    const stream = new MediaStream([mediaTrack]);
    this.pipeStreamToAssembly(stream, 'meeting');
    this.mediaRecording.startRecording(stream, (chunk) => this.sendAudioChunk(chunk));

    // Fallback: force start if no audio after delay
    setTimeout(() => {
      if (this.voiceWs && this.voiceWs.readyState === WebSocket.OPEN &&
          this.jitsiService.getActiveRemoteTrackId() === mediaTrack.id &&
          this.meetingChunkCount === 0) {
        this.voiceWs.send(JSON.stringify({ type: 'force_start' }));
        console.log('⚡ Candidate joined but no audio detected - force starting conversation.');
      }
    }, 5000);

    // Force stream to flow
    const hidden = document.createElement('audio');
    hidden.style.display = 'none';
    hidden.muted = true;
    hidden.autoplay = true;
    document.body.appendChild(hidden);
    trackInfo.track.attach(hidden);
    setTimeout(() => {
      if (document.body.contains(hidden)) {
        document.body.removeChild(hidden);
      }
    }, 2000);
  }

  private sendAudioChunk(chunk: Blob): void {
    if (this.voiceWs && this.voiceWs.readyState === WebSocket.OPEN) {
      this.meetingChunkCount++;
      console.log(`📦 Sending meeting chunk #${this.meetingChunkCount} to backend`);
      this.voiceWs.send(chunk);
    } else {
      console.warn('⏳ WebSocket not open. Buffering meeting audio chunk.');
      this.pendingAudioChunks.push(chunk);
    }
  }

  // ================= WebSocket ===================
  private setupWebSockets(sessionId: string): void {
    this.voiceWs = new WebSocket(this.config.getVoiceWebSocketUrl(sessionId));

    this.voiceWs.onopen = () => {
      console.log('✅ Voice WebSocket connected');
      this.agentResponses.update((t) => t + '[WS] Connected\n');
      this.voiceWs?.send(JSON.stringify({ type: 'status' }));

      // Flush any buffered chunks
      while (this.pendingAudioChunks.length && this.voiceWs?.readyState === WebSocket.OPEN) {
        const c = this.pendingAudioChunks.shift()!;
        this.meetingChunkCount++;
        console.log(`🚚 Flushing buffered chunk (#${this.meetingChunkCount})`);
        this.voiceWs.send(c);
      }

      // Force start if candidate joined but no audio yet
      setTimeout(() => {
        if (this.jitsiService.getActiveRemoteTrackId() && this.meetingChunkCount === 0) {
          this.voiceWs?.send(JSON.stringify({ type: 'force_start' }));
          console.log('⚡ Force started conversation (candidate joined but no audio detected yet).');
        } else if (!this.jitsiService.getActiveRemoteTrackId()) {
          console.log('⏳ Waiting for candidate to join before starting conversation...');
        }
      }, 10000);
    };

    this.voiceWs.onerror = (e) => {
      console.error('❌ Voice WebSocket error:', e);
      this.agentResponses.update((t) => t + '[ERR] WebSocket error\n');
    };

    this.voiceWs.onmessage = async (event) => {
      if (event.data instanceof Blob) {
        await this.injectAudioIntoJitsi(event.data);
      } else {
        try {
          const data = JSON.parse(event.data);
          if (data.type === 'text_response') {
            this.agentResponses.update((t) => t + data.text + '\n');
          } else if (data.type === 'error') {
            console.error('❌ Agent Error:', data.message);
            this.agentResponses.update((t) => t + `[ERR] ${data.message}\n`);
          } else if (data.type === 'interview_ended') {
            console.log('🏁 Interview ended:', data.reason);
            this.agentResponses.update((t) => t + `[END] Interview ended: ${data.reason}\n`);
            const canRejoin = data.canRejoin === true;
            if (canRejoin) {
              this.agentResponses.update((t) => t + `[INFO] You can rejoin this session. Connection dropped due to network issue.\n`);
            }
            await this.endInterview(false);
          } else if (data.type === 'warning' && data.remaining_seconds) {
            console.warn('⏰ Interview ending soon:', data.remaining_seconds, 'seconds');
            this.agentResponses.update((t) => t + `[WARN] Interview ending in ${data.remaining_seconds} seconds\n`);
          }
        } catch (e) {
          console.error('Failed to parse message:', e);
        }
      }
    };

    this.voiceWs.onclose = (event) => {
      console.log('🚪 Voice WebSocket closed:', event.reason);
      this.agentResponses.update((t) => t + `[WS] Disconnected: ${event.reason}\n`);
      this.wsStarted = false;

      // Check session status when WebSocket closes
      setTimeout(async () => {
        await this.sessionManagement.checkSessionStatus();
      }, 1000);
    };
  }

  private async injectAudioIntoJitsi(audioBlob: Blob): Promise<void> {
    try {
      const destTrack = await this.audioPlayback.injectAudioBlob(audioBlob);

      if (destTrack && !this.jitsiService.isAgentTrackInjected()) {
        await this.jitsiService.injectAgentAudioTrack(destTrack);
      }
    } catch (e) {
      console.error('❌ Failed to inject audio into Jitsi:', e);
    }
  }

  async enableAudio(): Promise<void> {
    console.log('🎧 User clicked Enable Audio button');
    await this.audioPlayback.resumeAudioContexts();
  }

  // ================= Interview Management ===================
  requestEndInterview(): void {
    this.sessionManagement.requestEndInterview();
  }

  async confirmEndInterview(): Promise<void> {
    this.sessionManagement.cancelEndInterview();
    await this.endInterview(true);
  }

  cancelEndInterview(): void {
    this.sessionManagement.cancelEndInterview();
  }

  async attemptRejoin(): Promise<void> {
    await this.sessionManagement.attemptRejoin((msg) => {
      this.agentResponses.update(t => t + msg);
    });
  }

  async endInterview(confirmClose: boolean = true): Promise<void> {
    console.log('🏁 Ending interview...');

    if (confirmClose) {
      if (this.voiceWs && this.voiceWs.readyState === WebSocket.OPEN) {
        this.voiceWs.send(JSON.stringify({ type: 'stop' }));
        console.log('📤 Sent stop message to backend');
      }
    }

    await this.cleanup();

    this.agentResponses.update((t) => t + '[END] Interview session closed.\n');
    this.wsStarted = false;
  }

  private async cleanup(): Promise<void> {
    // Stop recording
    this.mediaRecording.cleanup();

    // Clean up Jitsi
    await this.jitsiService.cleanup();

    // Close WebSocket
    if (this.voiceWs) {
      this.voiceWs.close();
      this.voiceWs = null;
      console.log('🔌 Closed WebSocket');
    }

    // Clean up audio
    await this.audioPlayback.cleanup();
    if (this.audioContext) {
      await this.audioContext.close();
      this.audioContext = null;
    }

    // Clean up session management
    this.sessionManagement.cleanup();

    // Stop mic streaming
    this.stopMicStreaming();
  }

  // ================= MIC ===================
  async toggleMicStreaming(): Promise<void> {
    if (this.isMicStreaming()) {
      this.stopMicStreaming();
    } else {
      await this.startMicStreaming();
    }
  }

  private async startMicStreaming(): Promise<void> {
    if (this.isMicStreaming() || this.voiceWs?.readyState !== WebSocket.OPEN) return;

    try {
      this.micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      this.isMicStreaming.set(true);
      console.log('🎤 Mic stream started');
      this.pipeStreamToAssembly(this.micStream, 'mic');
    } catch (err) {
      console.error('❌ Failed to get mic stream:', err);
    }
  }

  private stopMicStreaming(): void {
    if (!this.isMicStreaming()) return;
    this.micStream?.getTracks().forEach(track => track.stop());
    this.isMicStreaming.set(false);
    this.micWorkletNode?.disconnect();
    console.log('🛑 Mic stream stopped');
  }

  private async pipeStreamToAssembly(stream: MediaStream, source: 'meeting' | 'mic'): Promise<void> {
    console.log(`🔄 Setting up audio pipeline for ${source}...`);

    try {
      await this.audioContext?.close();
    } catch {}

    this.audioContext = new AudioContext({ sampleRate: this.config.AUDIO_SAMPLE_RATE });

    // Resume audio context
    await this.audioPlayback.resumeAudioContexts();

    if (stream.getAudioTracks().length === 0) {
      return console.error(`❌ No audio tracks in ${source} stream.`);
    }

    const sourceNode = this.audioContext.createMediaStreamSource(stream);
    if (!this.audioContext.audioWorklet) {
      return console.error('❌ AudioWorklet not supported.');
    }

    try {
      try {
        await this.audioContext.audioWorklet.addModule(this.config.AUDIO_WORKLET_PATH);
      } catch (primaryErr) {
        console.warn('⚠️ Primary worklet path failed, retrying fallback', primaryErr);
        await this.audioContext.audioWorklet.addModule(this.config.AUDIO_WORKLET_FALLBACK_PATH);
      }

      const workletNode = new AudioWorkletNode(this.audioContext, 'audio-processor', {
        processorOptions: { sourceSampleRate: this.audioContext.sampleRate }
      });

      workletNode.port.onmessage = (event) => {
        if (this.voiceWs?.readyState === WebSocket.OPEN) {
          this.voiceWs.send(event.data);
          if (source === 'meeting') this.meetingChunkCount++;
          else this.micChunkCount++;
        }
      };

      sourceNode.connect(workletNode).connect(this.audioContext.destination);
    } catch (e) {
      console.error('❌ AudioWorklet setup failed:', e);
    }
  }
}
