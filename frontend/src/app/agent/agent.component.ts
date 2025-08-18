import { Component, OnInit, signal, OnDestroy } from '@angular/core';
import { HttpClient } from '@angular/common/http';

@Component({
  selector: 'app-agent',
  standalone: true,
  imports: [],
  templateUrl: './agent.component.html',
  styleUrl: './agent.component.css'
})
export class AgentComponent implements OnInit, OnDestroy {
  constructor(private http: HttpClient) {}

  private voiceWs: WebSocket | null = null;
  sessionId = 'testsession';

  agentResponses = signal<string>('');
  hasValidSession = signal<boolean>(false);
  private audioContext: AudioContext | null = null;
  private wsStarted = false;
  private activeRemoteTrackId: string | null = null;
  private activeConference: any = null;
  private meetingChunkCount = 0;
  private trackPollingInterval: any = null;
  private pendingAudioChunks: Blob[] = []; // buffer when WS not yet open

  private mediaRecorder: MediaRecorder | null = null;
  private recordedChunks: Blob[] = [];

  // Store JaaS connection details
  private jaasDomain: string = '';
  private jaasRoom: string = '';
  private jaasJwt: string = '';

  // Mic streaming state
  isMicStreaming = signal(false);
  private micStream: MediaStream | null = null;
  private micWorkletNode: AudioWorkletNode | null = null;
  private micChunkCount = 0;
  // Playback scheduling for raw PCM agent audio
  private nextPlaybackTime = 0;

  ngOnInit(): void {
    this.waitForJitsiScripts().then(() => {
      try {
        const raw = sessionStorage.getItem('jaasSession');
        if (raw) {
          const res = JSON.parse(raw);
          console.log('✅ Using existing JaaS session from moderator:', res);
          this.hasValidSession.set(true);
          this.joinJaas(res.domain, res.room, res.jwt);
          return;
        }
      } catch (error) {
        console.error('Failed to parse JaaS session from sessionStorage:', error);
      }

      // If no session exists, show error instead of creating new JWT
      console.error('❌ No JaaS session found. Please start from the moderator page first.');
      console.log('🔧 Expected workflow: Moderator creates session → Opens agent in new tab');
    });
  }

  ngOnDestroy(): void {
    console.log('Destroying agent component, cleaning up resources...');
    this.stopRecording();
    if (this.trackPollingInterval) {
      clearInterval(this.trackPollingInterval);
    }
    this.activeConference?.removeAllTracks();
    this.activeConference?.leave();
    this.voiceWs?.close();
  }

  private waitForJitsiScripts(timeoutMs = 8000): Promise<void> {
    const start = performance.now();
    return new Promise((resolve, reject) => {
      const check = () => {
        if ((window as any).JitsiMeetJS && (window as any).JitsiMeetExternalAPI) {
          console.log('✅ Jitsi scripts loaded');
          resolve();
        } else if (performance.now() - start > timeoutMs) {
          console.error('❌ Timed out waiting for Jitsi scripts');
          reject(new Error('Jitsi scripts not loaded'));
        } else {
          setTimeout(check, 100);
        }
      };
      check();
    });
  }

  declareJaas(): any { return (window as any).JitsiMeetExternalAPI; }
  declareJitsi(): any { return (window as any).JitsiMeetJS; }

  private async joinJaas(domain: string, room: string, jwt: string) {
    this.jaasDomain = domain;
    this.jaasRoom = room;
    this.jaasJwt = jwt;
  // Setup iframe (may run before *conditional* template block renders, so retry)
  this.setupIframeWithRetry(room, jwt, 20, 150);

    // Setup headless Jitsi
    const JitsiMeetJS = this.declareJitsi();
    if (!JitsiMeetJS) return console.error('lib-jitsi-meet not available');

    JitsiMeetJS.init({
      disableAudioLevels: false,
      enableNoAudioDetection: true,
      disableAP: true,
      disableAEC: true,
      disableNS: true,
      disableAGC: true,
    });
    JitsiMeetJS.setLogLevel(JitsiMeetJS.logLevels.INFO);

    const roomParts = room.split('/');
    const isJaas = roomParts.length > 1;
    const conferenceRoomName = isJaas ? roomParts[1] : room;
    const jaasTenant = isJaas ? roomParts[0] : null;

    if (!isJaas || !jaasTenant) {
      console.error('❌ Invalid JaaS room format. Expected tenant/roomname.');
      return;
    }

    const options = {
      hosts: { domain: '8x8.vc', muc: `conference.${jaasTenant}.8x8.vc` },
      p2p: { enabled: false },
      // Include the room as a query param (required in some JaaS deployments for lobby/auth routing)
      serviceUrl: `wss://8x8.vc/${jaasTenant}/xmpp-websocket?room=${encodeURIComponent(conferenceRoomName)}`,
      clientNode: 'http://jitsi.org/jitsimeet'
    };

    console.log('🔧 Jitsi connection options:', options);
    // IMPORTANT: For JaaS the JWT must be supplied when creating the JitsiConnection.
    // Passing it only in initJitsiConference causes a notAllowed presence error.
    const connection = new JitsiMeetJS.JitsiConnection(null, jwt, options);

    connection.addEventListener(JitsiMeetJS.events.connection.CONNECTION_ESTABLISHED, () => {
      console.log('✅ Jitsi headless connection established');
      
  // JWT already provided at connection level; do NOT re-pass here (can trigger auth issues)
  const confOptions = { }; // keep empty unless specific config needed
  console.log('🔧 Creating conference with options:', { roomName: conferenceRoomName, options: confOptions });
  const conference = connection.initJitsiConference(conferenceRoomName, confOptions);
      this.activeConference = conference;
      
      console.log('🚀 Conference object created, setting up event listeners...');

      conference.on(JitsiMeetJS.events.conference.CONFERENCE_JOINED, () => {
        console.log('✅ Jitsi headless conference joined');
        // Ensure voice websocket is up as early as possible (was previously only after iframe join)
        if (!this.wsStarted) {
          this.wsStarted = true;
          this.setupWebSockets(this.sessionId);
        }
        JitsiMeetJS.createLocalTracks({ devices: ['audio'] })
          .then((tracks: any[]) => {
            const audioTrack = tracks.find(t => t.getType() === 'audio');
            if (audioTrack) {
              audioTrack.mute();
              conference.addTrack(audioTrack);
              console.log('🎤 Added silent local audio track to headless client.');
            }
          })
          .catch((err: any) => console.error('Failed to add local track:', err));
        this.startPollingForTrack(conference);
      });

      conference.on(JitsiMeetJS.events.conference.TRACK_ADDED, (track: any) => {
        if (!track.isLocal() && track.getType() === 'audio') {
          console.log('🎵 TRACK_ADDED event fired. Handling track.');
          this.handleRemoteTrack(track);
        }
      });

      conference.on(JitsiMeetJS.events.conference.TRACK_REMOVED, (track: any) => {
        if (this.activeRemoteTrackId && this.activeRemoteTrackId === track.getTrack()?.id) {
          console.log('🛑 Active track removed. Restarting polling.');
          this.activeRemoteTrackId = null;
          this.stopRecording();
          this.startPollingForTrack(conference);
        }
      });

      conference.on(JitsiMeetJS.events.conference.USER_LEFT, (id: any, user: any) => {
        console.log(`[USER_LEFT] ${id} (${user.getDisplayName()})`);
        const remoteTracks = user.getTracks();
        if (this.activeRemoteTrackId && remoteTracks.some((t: any) => t.getTrack()?.id === this.activeRemoteTrackId)) {
          console.log('🎤 Tracked user left. Restarting polling.');
          this.activeRemoteTrackId = null;
          this.startPollingForTrack(conference);
        }
      });

      conference.on(JitsiMeetJS.events.conference.CONFERENCE_FAILED, (err: any) => {
        console.error('❌ CONFERENCE_FAILED', err);
        console.error('Conference failed details:', JSON.stringify(err, null, 2));
      });
      
      conference.on(JitsiMeetJS.events.conference.CONFERENCE_ERROR, (err: any) => {
        console.error('❌ CONFERENCE_ERROR', err);
        console.error('Conference error details:', JSON.stringify(err, null, 2));
      });

      // Add additional event listeners for debugging
      conference.on(JitsiMeetJS.events.conference.CONNECTION_ESTABLISHED, () => {
        console.log('🔗 Conference connection established');
      });

      conference.on(JitsiMeetJS.events.conference.CONNECTION_INTERRUPTED, () => {
        console.log('⚠️ Conference connection interrupted');
      });

      conference.on(JitsiMeetJS.events.conference.CONNECTION_RESTORED, () => {
        console.log('🔄 Conference connection restored');
      });

      console.log('🎯 Attempting to join conference...');
      conference.join();
    });

    connection.addEventListener(JitsiMeetJS.events.connection.CONNECTION_FAILED, (e: any) => console.error('Jitsi connection failed', e));
    connection.connect();
  }

  private setupIframeWithRetry(room: string, jwt: string, attempts: number, delayMs: number) {
    const JitsiMeetExternalAPI = this.declareJaas();
    const parent = document.getElementById('jaas-iframe');
    if (!JitsiMeetExternalAPI) {
      console.warn('🕒 JitsiMeetExternalAPI not yet present, retrying...');
      if (attempts > 0) setTimeout(() => this.setupIframeWithRetry(room, jwt, attempts - 1, delayMs), delayMs);
      return;
    }
    if (!parent) {
      // This is the most likely reason the UI was not loading before.
      console.warn('🕒 Iframe container #jaas-iframe not yet in DOM (Angular conditional not rendered). Retrying...');
      if (attempts > 0) setTimeout(() => this.setupIframeWithRetry(room, jwt, attempts - 1, delayMs), delayMs);
      else console.error('❌ Failed to find #jaas-iframe container after retries; Jitsi UI will not render.');
      return;
    }
    if (parent.childElementCount > 0) {
      console.log('ℹ️ Jitsi iframe already initialized. Skipping duplicate init.');
      return;
    }
    console.log('🎬 Initializing Jitsi iframe UI');
    try {
      const api = new JitsiMeetExternalAPI('8x8.vc', {
        roomName: room,
        parentNode: parent,
        jwt,
        configOverwrite: { prejoinPageEnabled: true, p2p: { enabled: false } },
      });
      api.addEventListener('videoConferenceJoined', () => {
        console.log('✅ iframe: videoConferenceJoined');
        if (!this.wsStarted) {
          this.wsStarted = true;
            this.setupWebSockets(this.sessionId);
        }
      });
      api.addEventListener('videoConferenceLeft', () => console.log('iframe: left'));
      api.addEventListener('errorOccurred', (e: any) => console.error('iframe error', e));
    } catch (e) {
      console.error('❌ Failed to initialize Jitsi iframe:', e);
    }
  }

  private startPollingForTrack(conference: any) {
    if (this.trackPollingInterval) clearInterval(this.trackPollingInterval);
    console.log('🔍 Starting polling for remote audio track...');
    this.trackPollingInterval = setInterval(() => {
      if (this.activeRemoteTrackId) {
        clearInterval(this.trackPollingInterval);
        this.trackPollingInterval = null;
        return;
      }
      const participants = conference.getParticipants();
      for (const p of participants) {
        const audioTrack = p.getTracks().find((t: any) => t.getType() === 'audio' && !t.isMuted());
        if (audioTrack) {
          console.log(`✅ Polling found active audio track: ${audioTrack.getId()} from participant ${p.getId()}`);
          this.handleRemoteTrack(audioTrack);
          return;
        }
      }
    }, 2500);
  }

  private handleRemoteTrack(track: any) {
    if (this.trackPollingInterval) {
      clearInterval(this.trackPollingInterval);
      this.trackPollingInterval = null;
    }

    const mediaTrack = track.getTrack();
    if (!mediaTrack || !mediaTrack.enabled || mediaTrack.readyState !== 'live') {
      return console.error('❌ No enabled MediaStreamTrack found in Jitsi track.');
    }
    if (this.activeRemoteTrackId === mediaTrack.id) return console.log(`ℹ️ Track ${mediaTrack.id} already active.`);

    console.log(`[handleRemoteTrack] Processing new track ${mediaTrack.id}`);
    this.activeRemoteTrackId = mediaTrack.id;

    const stream = new MediaStream([mediaTrack]);
    this.pipeStreamToAssembly(stream, 'meeting');
    this.startRecording(stream);

    // force stream to flow
    const hidden = document.createElement('audio');
    hidden.style.display = 'none';
    hidden.muted = true;
    hidden.autoplay = true;
    document.body.appendChild(hidden);
    track.attach(hidden);
    setTimeout(() => {
      if (document.body.contains(hidden)) {
        document.body.removeChild(hidden);
      }
    }, 2000);
  }

  private startRecording(stream: MediaStream) {
    if (this.mediaRecorder) {
      this.mediaRecorder.stop();
    }
    this.recordedChunks = [];
    const options = { mimeType: 'audio/webm' };
    this.mediaRecorder = new MediaRecorder(stream, options);
    this.mediaRecorder.onstart = () => console.log('⏺️ Recorder started');

    this.mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        this.recordedChunks.push(event.data);
      }
    };

    this.mediaRecorder.onstop = () => {
      const blob = new Blob(this.recordedChunks, { type: 'audio/webm' });
      this.sendAudioChunk(blob);
      this.recordedChunks = [];
    };

    this.mediaRecorder.start(3000); // 3s slices
    console.log('⏺️ Started recording meeting audio.');
  }

  private stopRecording() {
    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      this.mediaRecorder.stop();
      console.log('⏹️ Stopped recording meeting audio.');
    }
  }

  private sendAudioChunk(chunk: Blob) {
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
  private setupWebSockets(sessionId: string) {
    this.voiceWs = new WebSocket(`ws://localhost:8000/agent/${sessionId}/voice`);
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
      setTimeout(() => {
        if (this.meetingChunkCount === 0) {
          this.voiceWs?.send(JSON.stringify({ type: 'force_start' }));
          console.log('⚡ Force started conversation due to no audio.');
        }
      }, 5000);
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
    };
  }

  private async injectAudioIntoJitsi(audioBlob: Blob) {
    // ElevenLabs bridge sends raw PCM16 mono @16kHz (not a WAV/encoded container),
    // so decodeAudioData() fails with EncodingError. We manually wrap into an AudioBuffer
    // and schedule playback to avoid gaps.
    try {
      if (!this.audioContext || this.audioContext.state === 'closed') {
        this.audioContext = new AudioContext();
      }
      await this.audioContext.resume();

      const arrayBuffer = await audioBlob.arrayBuffer();
      if (arrayBuffer.byteLength === 0) {
        console.warn('⚠️ Received empty agent audio chunk');
        return;
      }
      if (arrayBuffer.byteLength % 2 !== 0) {
        console.warn('⚠️ Odd-length PCM chunk, padding one byte');
      }
      const pcm16 = new Int16Array(arrayBuffer.slice(0, arrayBuffer.byteLength - (arrayBuffer.byteLength % 2)));
      const sampleRate = 16000; // ElevenLabs ConvAI returns 16 kHz PCM
      const audioBuffer = this.audioContext.createBuffer(1, pcm16.length, sampleRate);
      const channel = audioBuffer.getChannelData(0);
      for (let i = 0; i < pcm16.length; i++) {
        channel[i] = pcm16[i] / 32768; // convert to float32 [-1,1]
      }

      // Schedule sequentially to maintain continuity
      if (this.nextPlaybackTime < this.audioContext.currentTime) {
        this.nextPlaybackTime = this.audioContext.currentTime;
      }
      const src = this.audioContext.createBufferSource();
      src.buffer = audioBuffer;
      src.connect(this.audioContext.destination);
      src.start(this.nextPlaybackTime);
      const duration = audioBuffer.duration;
      this.nextPlaybackTime += duration;
      // Debug log occasionally
      if (Math.random() < 0.1) {
        console.log(`🔊 Queued agent audio chunk len=${pcm16.length} samples (${(duration*1000).toFixed(1)}ms) start=${this.nextPlaybackTime.toFixed(3)}`);
      }
    } catch (error) {
      console.error('❌ Failed to play raw PCM agent audio:', error);
    }
  }

  // ================= MIC ===================
  async toggleMicStreaming() {
    if (this.isMicStreaming()) {
      this.stopMicStreaming();
    } else {
      await this.startMicStreaming();
    }
  }

  private async startMicStreaming() {
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

  private stopMicStreaming() {
    if (!this.isMicStreaming()) return;
    this.micStream?.getTracks().forEach(track => track.stop());
    this.isMicStreaming.set(false);
    this.micWorkletNode?.disconnect();
    console.log('🛑 Mic stream stopped');
  }

  private async pipeStreamToAssembly(stream: MediaStream, source: 'meeting' | 'mic') {
    console.log(`🔄 Setting up audio pipeline for ${source}...`);
    try { await this.audioContext?.close(); } catch {}
    this.audioContext = new AudioContext({ sampleRate: 48000 });
    await this.audioContext.resume();

    if (stream.getAudioTracks().length === 0) return console.error(`❌ No audio tracks in ${source} stream.`);

    const sourceNode = this.audioContext.createMediaStreamSource(stream);
    if (!this.audioContext.audioWorklet) return console.error('❌ AudioWorklet not supported.');

    try {
      try {
        await this.audioContext.audioWorklet.addModule('/audio/audio-processor.js');
      } catch (primaryErr) {
        // Fallback path if asset mapping differs in dev build
        console.warn('⚠️ Primary worklet path failed, retrying root /audio-processor.js', primaryErr);
        await this.audioContext.audioWorklet.addModule('/audio-processor.js');
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