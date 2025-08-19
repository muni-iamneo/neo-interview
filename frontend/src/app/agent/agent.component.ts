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
  // Agent synthesized audio injection
  private agentPlaybackContext: AudioContext | null = null;
  private agentOutDest: MediaStreamAudioDestinationNode | null = null;
  private agentAudioTrack: MediaStreamTrack | null = null; // Track for ElevenLabs audio
  private agentAudioSender: RTCRtpSender | null = null; // Sender for agent audio track
  private audioContextsResumed = false; // Track if audio contexts have been resumed
  private placeholderJitsiAudioTrack: any | null = null; // Pre-allocates audio transceiver
  private agentTrackInjected = false; // Ensure we only add/replace once

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
    
    // Clean up agent audio track
    if (this.agentAudioTrack && this.activeConference) {
      try {
        this.activeConference.removeTrack(this.agentAudioTrack);
        console.log('🎤 Removed agent audio track from conference');
      } catch (e) {
        console.warn('⚠️ Error removing agent audio track:', e);
      }
    }
    // Clean up placeholder audio track
    if (this.placeholderJitsiAudioTrack && this.activeConference) {
      try {
        this.activeConference.removeTrack(this.placeholderJitsiAudioTrack);
        console.log('🧹 Removed placeholder audio track from conference');
      } catch (e) {
        console.warn('⚠️ Error removing placeholder audio track:', e);
      }
      this.placeholderJitsiAudioTrack = null;
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
        // Pre-allocate an audio transceiver with a silent placeholder local track
        this.ensurePlaceholderAudioTrack().catch(err => {
          console.warn('⚠️ Failed to create placeholder audio track (will try direct injection):', err);
        });
        console.log('🎤 Placeholder audio track will pre-allocate the sender/transceiver');
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
    // Convert raw PCM16 (16k) to playable buffer and inject into conference mix.
    try {
      if (!this.agentPlaybackContext || this.agentPlaybackContext.state === 'closed') {
        this.agentPlaybackContext = new AudioContext({ sampleRate: 48000 });
        this.agentOutDest = this.agentPlaybackContext.createMediaStreamDestination();
        console.log('🎧 Created agent playback context (48k) and destination node');
      }
      
      // Resume audio context if not already resumed
      await this.resumeAudioContexts();

      const arrayBuffer = await audioBlob.arrayBuffer();
      if (arrayBuffer.byteLength === 0) return;
      if (arrayBuffer.byteLength % 2 !== 0) console.warn('⚠️ Odd-length PCM chunk');
      const pcm16 = new Int16Array(arrayBuffer.slice(0, arrayBuffer.byteLength - (arrayBuffer.byteLength % 2)));

      // Upsample 16k -> 48k (simple 3x duplication). For higher quality implement linear or polyphase later.
      const upsampled = new Float32Array(pcm16.length * 3);
      for (let i = 0; i < pcm16.length; i++) {
        const v = pcm16[i] / 32768;
        const o = i * 3;
        upsampled[o] = v; upsampled[o + 1] = v; upsampled[o + 2] = v;
      }
      const buffer = this.agentPlaybackContext.createBuffer(1, upsampled.length, 48000);
      buffer.copyToChannel(upsampled, 0);

      if (this.nextPlaybackTime < this.agentPlaybackContext.currentTime) {
        this.nextPlaybackTime = this.agentPlaybackContext.currentTime;
      }
      const src = this.agentPlaybackContext.createBufferSource();
      src.buffer = buffer;
      // Only connect to destination for conference injection (no local playback)
      if (this.agentOutDest) src.connect(this.agentOutDest);
      src.start(this.nextPlaybackTime);
      const duration = buffer.duration;
      this.nextPlaybackTime += duration;
      
      // NEW: Properly inject audio into conference for other participants
      if (!this.agentTrackInjected) {
        this.injectAgentAudioIntoConference();
      }
      
      if (Math.random() < 0.1) console.log(`🔊 Agent chunk queued (${(duration*1000).toFixed(1)} ms) next=${this.nextPlaybackTime.toFixed(3)}`);
    } catch (e) {
      console.error('❌ Agent audio injection/playback failed:', e);
    }
  }

  private injectAgentAudioIntoConference() {
    if (!this.activeConference || !this.agentOutDest) {
      console.warn('⚠️ Cannot inject audio: conference or destination not ready');
      return;
    }

    try {
      // Get the audio track from the destination stream
      const destTrack = this.agentOutDest.stream.getAudioTracks()[0];
      if (!destTrack) {
        console.warn('⚠️ No audio track in destination stream');
        return;
      }

      // If we already have an agent audio track, replace it
      if (this.agentAudioTrack && this.agentAudioSender) {
        console.log('🔄 Replacing existing agent audio track');
        this.agentAudioSender.replaceTrack(destTrack).catch(err => {
          console.error('❌ Failed to replace agent audio track:', err);
        });
        return;
      }

      // Create a new audio track and add/replace into the conference
      console.log('🎤 Adding new agent audio track to conference');
      this.agentAudioTrack = destTrack;
      
      // Ensure the track is enabled
      this.agentAudioTrack.enabled = true;
      
  // Create a comprehensive track wrapper that mimics Jitsi's track interface (only once)
      const myId = (this.activeConference && typeof this.activeConference.myUserId === 'function')
        ? this.activeConference.myUserId()
        : 'agent';
      let storedSourceName = `${myId}-a0`;
      const customTrack = {
        // Basic track methods
        getType: () => 'audio',
        getTrack: () => destTrack,
        isLocal: () => true,
        isMuted: () => false,
        setMute: (muted: boolean) => {
          destTrack.enabled = !muted;
        },
        
  // Video-related methods (required by Jitsi even for audio tracks) - must match placeholder (null)
  getVideoType: () => null,
        getSourceName: () => storedSourceName,
        getSourceType: () => 'audio',
        setSourceName: (name: string) => {
          storedSourceName = name;
          console.log('🔧 Setting source name to:', name);
        },
        
        // Additional Jitsi track methods
        getId: () => destTrack.id,
        getKind: () => destTrack.kind,
        getLabel: () => destTrack.label,
        getSettings: () => destTrack.getSettings ? destTrack.getSettings() : {},
        getCapabilities: () => destTrack.getCapabilities ? destTrack.getCapabilities() : {},
        
        // Track state methods
        getReadyState: () => destTrack.readyState,
        getEnabled: () => destTrack.enabled,
        
        // Track type checking methods (required by Jitsi)
        isAudioTrack: () => true,
        isVideoTrack: () => false,
        
        // Additional Jitsi methods that might be called
        getSSRC: () => undefined,
        getMSID: () => undefined,
        getStreamId: () => destTrack.id,
        getTrackId: () => destTrack.id,
        
        // Event handling (empty implementations)
        on: () => {},
        off: () => {},
        emit: () => {},
        
        // Additional Jitsi methods that might be called
        getDeviceId: () => undefined,
        getFacingMode: () => undefined,
        getStream: () => new MediaStream([destTrack]),
        
        // Track disposal
        dispose: () => {
          destTrack.stop();
        }
      };

      // If we have a placeholder local track, replace it to reuse the same transceiver/sender
  if (this.placeholderJitsiAudioTrack) {
        console.log('🔁 Replacing placeholder local track with agent audio');
        try {
          this.activeConference.replaceTrack(this.placeholderJitsiAudioTrack, customTrack)
            .then(() => {
              console.log('✅ Placeholder replaced with agent track');
              this.placeholderJitsiAudioTrack = null;
              this.findAndStoreAgentAudioSender();
      this.agentTrackInjected = true;
            })
            .catch((err: any) => {
              console.error('❌ Failed to replace placeholder track:', err);
            });
        } catch (reErr) {
          console.error('❌ Replace placeholder threw:', reErr);
        }
      } else {
        // Otherwise add the track normally
    this.activeConference.addTrack(customTrack);
        // Store the sender for future track replacements
        this.findAndStoreAgentAudioSender();
    this.agentTrackInjected = true;
      }
      
      console.log('✅ Agent audio track successfully added to conference');
      if (this.agentAudioTrack) {
        console.log('🔊 Track details:', {
          id: this.agentAudioTrack.id,
          kind: this.agentAudioTrack.kind,
          enabled: this.agentAudioTrack.enabled,
          readyState: this.agentAudioTrack.readyState
        });
      }
      
    } catch (e) {
      console.error('❌ Failed to inject agent audio into conference:', e);
    }
  }

  // Create and add a muted placeholder Jitsi local audio track to allocate the audio transceiver
  private async ensurePlaceholderAudioTrack(): Promise<void> {
    if (!this.activeConference || this.placeholderJitsiAudioTrack) return;
    try {
      const JitsiMeetJS = this.declareJitsi();
      if (!JitsiMeetJS) return;
      const tracks: any[] = await JitsiMeetJS.createLocalTracks({ devices: ['audio'] });
      const audioTrack = tracks.find(t => t.getType && t.getType() === 'audio');
      if (!audioTrack) return;
      // Mute it to avoid capturing user mic audio
      if (typeof audioTrack.setMute === 'function') {
        await audioTrack.setMute(true);
      } else if (typeof audioTrack.mute === 'function') {
        await audioTrack.mute();
      }
      await this.activeConference.addTrack(audioTrack);
      this.placeholderJitsiAudioTrack = audioTrack;
      console.log('✅ Placeholder audio track added to allocate sender/transceiver');
    } catch (e) {
      console.warn('⚠️ ensurePlaceholderAudioTrack failed:', e);
    }
  }

  private findAndStoreAgentAudioSender() {
    if (!this.activeConference || !this.agentAudioTrack) return;
    
    try {
      // Look for the RTCRtpSender that was created when we added the track
      const rtc = this.activeConference.rtc || (this.activeConference.getRTC && this.activeConference.getRTC());
      if (!rtc) return;
      
      const containers = rtc.peerConnections || rtc._peerConnections || rtc._peerConnectionsMap || {};
      const pcHolders = Object.values(containers);
      
      for (const holder of pcHolders) {
        const h: any = holder as any;
        const pc: RTCPeerConnection | undefined = h && (h.peerconnection || h.pc || h._pc);
        if (!pc) continue;
        
        const senders = pc.getSenders();
        for (const sender of senders) {
          if (sender.track && sender.track.id === this.agentAudioTrack.id) {
            this.agentAudioSender = sender;
            console.log('🔗 Found agent audio RTCRtpSender:', sender.track.id);
            return;
          }
        }
      }
    } catch (err) {
      console.warn('⚠️ Error finding agent audio sender:', err);
    }
  }

  private async resumeAudioContexts(): Promise<void> {
    if (this.audioContextsResumed) {
      return;
    }

    try {
      // Resume agent playback context
      if (this.agentPlaybackContext && this.agentPlaybackContext.state === 'suspended') {
        await this.agentPlaybackContext.resume();
        console.log('🎧 Agent playback context resumed');
      }

      // Resume main audio context
      if (this.audioContext && this.audioContext.state === 'suspended') {
        await this.audioContext.resume();
        console.log('🎧 Main audio context resumed');
      }

      this.audioContextsResumed = true;
      console.log('✅ All audio contexts resumed successfully');
    } catch (error) {
      console.error('❌ Failed to resume audio contexts:', error);
    }
  }

  // Public method to enable audio (called from template button)
  async enableAudio(): Promise<void> {
    console.log('🎧 User clicked Enable Audio button');
    await this.resumeAudioContexts();
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
    
    // Resume audio context if not already resumed
    await this.resumeAudioContexts();

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