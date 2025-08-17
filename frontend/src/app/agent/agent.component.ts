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
  private audioContext: AudioContext | null = null;
  private wsStarted = false;
  private activeRemoteTrackId: string | null = null;
  private activeConference: any = null;
  private meetingChunkCount = 0;
  private trackPollingInterval: any = null;

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

  ngOnInit(): void {
    this.waitForJitsiScripts().then(() => {
      try {
        const raw = sessionStorage.getItem('jaasSession');
        if (raw) {
          const res = JSON.parse(raw);
          this.joinJaas(res.domain, res.room, res.jwt);
          return;
        }
      } catch {}

      this.http
        .post<any>('http://localhost:8000/jaas/jwt', {
          room: 'testroom',
          user: { name: 'Agent' },
        })
        .subscribe({
          next: (res) => this.joinJaas(res.domain, res.room, res.jwt),
          error: (err) => console.error('Agent JWT fetch failed', err),
        });
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

    // Setup iframe
    const JitsiMeetExternalAPI = this.declareJaas();
    const parent = document.getElementById('jaas-iframe');
    if (JitsiMeetExternalAPI && parent) {
      const api = new JitsiMeetExternalAPI('8x8.vc', {
        roomName: room,
        parentNode: parent,
        jwt,
        configOverwrite: { prejoinPageEnabled: true, p2p: { enabled: false } },
      });
      api.addEventListener('videoConferenceJoined', () => {
        console.log('iframe: joined');
        if (!this.wsStarted) {
          this.wsStarted = true;
          this.setupWebSockets(this.sessionId);
        }
      });
    }

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
      serviceUrl: `wss://8x8.vc/${jaasTenant}/xmpp-websocket`,
      clientNode: 'http://jitsi.org/jitsimeet'
    };

    const connection = new JitsiMeetJS.JitsiConnection(null, null, options);

    connection.addEventListener(JitsiMeetJS.events.connection.CONNECTION_ESTABLISHED, () => {
      console.log('✅ Jitsi headless connection established');
      const confOptions = { jwt: this.jaasJwt };
      const conference = connection.initJitsiConference(conferenceRoomName, confOptions);
      this.activeConference = conference;

      conference.on(JitsiMeetJS.events.conference.CONFERENCE_JOINED, () => {
        console.log('✅ Jitsi headless conference joined');
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

      conference.on(JitsiMeetJS.events.conference.CONFERENCE_FAILED, (err: any) => console.error('❌ CONFERENCE_FAILED', err));
      conference.on(JitsiMeetJS.events.conference.CONFERENCE_ERROR, (err: any) => console.error('❌ CONFERENCE_ERROR', err));

      conference.join();
    });

    connection.addEventListener(JitsiMeetJS.events.connection.CONNECTION_FAILED, (e: any) => console.error('Jitsi connection failed', e));
    connection.connect();
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
      console.error('❌ WebSocket not open. Cannot send audio chunk.');
    }
  }

  // ================= WebSocket ===================
  private setupWebSockets(sessionId: string) {
    this.voiceWs = new WebSocket(`ws://localhost:8000/agent/${sessionId}/voice`);
    this.voiceWs.onopen = () => {
      console.log('✅ Voice WebSocket connected');
      this.agentResponses.update((t) => t + '[WS] Connected\n');
      this.voiceWs?.send(JSON.stringify({ type: 'status' }));
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
    if (!this.audioContext || this.audioContext.state === 'closed') {
      this.audioContext = new AudioContext();
    }
    await this.audioContext.resume();
    try {
      const arrayBuffer = await audioBlob.arrayBuffer();
      const audioBuffer = await this.audioContext.decodeAudioData(arrayBuffer);
      const source = this.audioContext.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(this.audioContext.destination);
      source.start();
    } catch (error) {
      console.error('❌ Web Audio API decoding failed:', error);
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
      await this.audioContext.audioWorklet.addModule('/audio/audio-processor.js');
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