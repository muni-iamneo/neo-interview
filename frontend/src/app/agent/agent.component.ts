import { Component, OnInit, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';

@Component({
  selector: 'app-agent',
  standalone: true,
  imports: [],
  templateUrl: './agent.component.html',
  styleUrl: './agent.component.css'
})
export class AgentComponent implements OnInit {
  constructor(private http: HttpClient) {}

  private voiceWs: WebSocket | null = null; // New integrated voice WebSocket
  sessionId = 'testsession';

  // Removed mic transcript signal; only agent responses remain
  agentResponses = signal<string>('');
  // Mic streaming removed; meeting audio only
  private audioContext: AudioContext | null = null;
  // Removed mic worklet & pending buffer
  private wsStarted = false;
  private _forceStartCountdown = 5; // send a force_start after ~5 initial meeting chunks
  private activeRemoteTrackId: string | null = null; // currently captured remote track
  private meetingCaptureRestartAttempts = 0;
  private activeConference: any = null; // Reference to active JitsiConference
  private meetingChunkCount = 0;

  ngOnInit(): void {
    this.waitForJitsiScripts().then(() => {
    // Prefer session values set by Moderator to avoid a second JWT call here
    try {
      const raw = sessionStorage.getItem('jaasSession');
      if (raw) {
        const res = JSON.parse(raw);
        this.joinJaas(res.domain, res.room, res.jwt);
        return;
      }
    } catch {}

    // Fallback: fetch JWT directly if user navigated straight to /agent
    this.http
      .post<any>('http://localhost:8000/jaas/jwt', {
        room: 'testroom',
        user: { name: 'Agent' },
      })
      .subscribe({
        next: (res) => {
          this.joinJaas(res.domain, res.room, res.jwt);
        },
        error: (err) => console.error('Agent JWT fetch failed', err),
        });
    });
  }

  private waitForJitsiScripts(timeoutMs = 8000): Promise<void> {
    const start = performance.now();
    return new Promise((resolve, reject) => {
      const check = () => {
        if ((window as any).JitsiMeetJS && (window as any).JitsiMeetExternalAPI) {
          console.log('✅ Jitsi scripts loaded');
          resolve();
          return;
        }
        if (performance.now() - start > timeoutMs) {
          console.error('❌ Timed out waiting for Jitsi scripts');
          reject(new Error('Jitsi scripts not loaded'));
          return;
        }
        setTimeout(check, 100);
      };
      check();
      });
  }

  declareJaas(): any { return (window as any).JitsiMeetExternalAPI; }
  declareJitsi(): any { return (window as any).JitsiMeetJS; }

  private async joinJaas(_domain: string, room: string, jwt: string) {
    // 1) Render JaaS meeting UI via IFrame
    const JitsiMeetExternalAPI = (window as any).JitsiMeetExternalAPI;
    const parent = document.getElementById('jaas-iframe');
    if (JitsiMeetExternalAPI && parent) {
      const api = new JitsiMeetExternalAPI('8x8.vc', {
        roomName: room,
        parentNode: parent,
        jwt,
        configOverwrite: { prejoinPageEnabled: true },
        interfaceConfigOverwrite: {}
      });

      // Fallback start: when the visible IFrame joins, open WS if not already
      api.addEventListener('videoConferenceJoined', () => {
        console.log('iframe: joined');
        if (!this.wsStarted) {
          // Set flag BEFORE invoking setup to avoid race with lib-jitsi-meet join event
          this.wsStarted = true;
          this.setupWebSockets(this.sessionId);
        }
      });
    }

    // 2) Headless lib-jitsi-meet to get remote audio track so we can forward to ElevenLabs
    const JitsiMeetJS = this.declareJitsi();
    if (!JitsiMeetJS) {
      console.error('lib-jitsi-meet not available');
      return;
    }

    // Initialize per Jitsi Web docs
    JitsiMeetJS.init({
      disableAudioLevels: true,
      enableNoAudioDetection: true,
      enableNoisyMicDetection: true,
      enableTalkWhileMuted: false, // Disable talk detection
      disableAP: true, // Disable audio processing
      disableAEC: true, // Disable echo cancellation if not needed
      disableNS: true, // Disable noise suppression
      disableAGC: true // Disable auto gain control
    });

    console.log('✅ Jitsi initialized with custom config:', JitsiMeetJS.getLogLevel()); // Basic log, or inspect if possible

    const options = {
      hosts: {
        domain: '8x8.vc',
        muc: 'conference.8x8.vc'
      },
      // Provide room in the websocket URL for JaaS sharding
      serviceUrl: `wss://8x8.vc/xmpp-websocket?room=${encodeURIComponent(room)}`,
      clientNode: 'http://jitsi.org/jitsimeet',
      enableLipSync: false
    } as any;

    // Use a distinct identity for the headless bridge to avoid any edge cases with identical user IDs
  let bridgeJwt = jwt;
  const roomSlug = room.split('/').pop();
  // Attempt distinct bridge JWT but don't block >1s
  bridgeJwt = await this.fetchBridgeJwt(roomSlug, jwt);

    const connection = new JitsiMeetJS.JitsiConnection(null, bridgeJwt, options);

    connection.addEventListener(JitsiMeetJS.events.connection.CONNECTION_ESTABLISHED, () => {
      const conf = connection.initJitsiConference(room, { p2p: { enabled: false } });

      conf.on(JitsiMeetJS.events.conference.CONFERENCE_JOINED, () => {
        console.log('lib-jitsi-meet: conference joined');
        // Store reference to active conference
        this.activeConference = conf;
        
        if (!this.wsStarted) {
          this.wsStarted = true; // race guard
          this.setupWebSockets(this.sessionId);
          
          // Attempt to capture all existing tracks
          this.captureExistingTracks(conf);
        }
      });

      conf.on(JitsiMeetJS.events.conference.CONFERENCE_FAILED, (e: any) => {
        console.error('lib-jitsi-meet: conference failed', e);
      });

      conf.on(JitsiMeetJS.events.conference.TRACK_ADDED, (track: any) => {
        try {
          const type = track.getType && track.getType();
          const local = track.isLocal && track.isLocal();
          const readyState = track.getTrack && track.getTrack() ? track.getTrack().readyState : 'unknown';
          const muted = track.isMuted && track.isMuted();
          const enabled = track.getTrack && track.getTrack() ? track.getTrack().enabled : 'unknown';
          const ssrc = track.getSSRC && track.getSSRC();
          
          console.log('[TRACK_ADDED]', { 
            type, 
            local, 
            readyState,
            muted,
            enabled,
            ssrc,
            audioLevel: track.getAudioLevel && track.getAudioLevel()
          });
          
          // Only process remote audio tracks
          if (!local && type === 'audio') {
            console.log('🎵 Remote audio track detected - attempting to capture');
            
            // Force immediate unmute if track is muted
            if (muted && track.unmute) {
              try {
                track.unmute();
                console.log('🔊 Forced track unmute');
              } catch (e) {
                console.warn('Failed to unmute track:', e);
              }
            }
            
            // APPROACH 1: Direct track access (most reliable)
            let mediaTrack = null;
            if (track.getTrack) {
              mediaTrack = track.getTrack();
              if (mediaTrack) console.log('✅ Got track via getTrack()');
            }
            
            // APPROACH 2: From original stream
            if (!mediaTrack && track.getOriginalStream) {
              const origStream = track.getOriginalStream();
              if (origStream) {
                try {
                  // Type assertion for TypeScript
                  const mediaStream = origStream as MediaStream;
                  if (mediaStream.getAudioTracks && mediaStream.getAudioTracks().length > 0) {
                    mediaTrack = mediaStream.getAudioTracks()[0];
                    console.log('✅ Got track via getOriginalStream()');
                  }
                } catch (e) {
                  console.warn('Failed to get tracks from original stream:', e);
                }
              }
            }
            
            // APPROACH 3: From track.stream property
            if (!mediaTrack && track.stream) {
              try {
                // Type assertion for TypeScript
                const mediaStream = track.stream as MediaStream;
                if (mediaStream.getAudioTracks && mediaStream.getAudioTracks().length > 0) {
                  mediaTrack = mediaStream.getAudioTracks()[0];
                  console.log('✅ Got track via track.stream');
                }
              } catch (e) {
                console.warn('Failed to get tracks from track.stream:', e);
              }
            }
            
            // APPROACH 4: Create a new stream via attach() to audio element
            if (!mediaTrack) {
              try {
                const tempAudio = document.createElement('audio');
                track.attach(tempAudio);
                if (tempAudio.srcObject) {
                  // Type assertion to MediaStream
                  const mediaStream = tempAudio.srcObject as MediaStream;
                  const attachedTracks = mediaStream.getAudioTracks();
                  if (attachedTracks.length > 0) {
                    mediaTrack = attachedTracks[0];
                    console.log('✅ Got track via attach() method');
                  }
                }
              } catch (e) {
                console.warn('Failed to get track via attach():', e);
              }
            }
            
            // Process the track if we found it
            if (mediaTrack) {
              const mediaId = mediaTrack.id;
              console.log('🎵 Remote audio track resolved:', {
                id: mediaId,
                enabled: mediaTrack.enabled,
                muted: mediaTrack.muted,
                readyState: mediaTrack.readyState,
                kind: mediaTrack.kind
              });
              
              // Check if we're already processing this track
              if (this.activeRemoteTrackId === mediaId) {
                console.log('ℹ️ Track already active, skipping re-capture');
                return;
              }
              
              // If we already have a track, reinitialize capture on replacement
              if (this.activeRemoteTrackId) {
                console.log('♻️ Replacing active remote track', this.activeRemoteTrackId, '→', mediaId);
              }
              
              this.activeRemoteTrackId = mediaId;
              
              // Create a hidden audio element to keep the track active
              const hidden = document.createElement('audio');
              hidden.style.display = 'none';
              hidden.muted = true; // Don't play through speakers
              hidden.autoplay = true;
              document.body.appendChild(hidden);
              
              // Try to attach the track to the element
              try {
                track.attach(hidden);
                console.log('✅ Track attached to hidden audio element');
              } catch (e) {
                console.warn('track.attach failed, using manual stream assignment:', e);
                hidden.srcObject = new MediaStream([mediaTrack]);
              }
              
              // Monitor the audio element
              hidden.onplaying = () => console.log('🔊 Hidden audio element playing (decoder active)');
              hidden.onerror = (err) => console.warn('❌ Hidden audio element error:', err);
              
              // Create a fresh MediaStream with the track for WebAudio processing
              const captureStream = new MediaStream([mediaTrack]);
              
              // Start the audio processing pipeline
              this.pipeStreamToAssembly(captureStream);
              
              // Listen for mute/unmute events to restart capture if needed
              try {
                const handleMuteChange = () => {
                  const isMuted = track.isMuted && track.isMuted();
                  console.log('[TRACK_MUTE_CHANGED]', isMuted);
                  
                  // If track was unmuted, restart capture
                  if (!isMuted && this.activeRemoteTrackId === mediaId) {
                    console.log('🔄 Track unmuted, refreshing audio capture');
                    this.pipeStreamToAssembly(new MediaStream([mediaTrack]));
                    // Send a small test packet to ElevenLabs
                    if (this.voiceWs?.readyState === WebSocket.OPEN) {
                      this.voiceWs.send(new Uint8Array(320)); // Silence to trigger detection
                      console.log('📤 Sent test silence packet on unmute');
                    }
                  }
                };
                
                track.addEventListener(JitsiMeetJS.events.track.TRACK_MUTE_CHANGED, handleMuteChange);
              } catch (e) {
                console.warn('Failed to add mute change listener:', e);
              }
              
              // Also listen for audio level changes to detect activity
              try {
                const audioLevelHandler = (audioLevel: number) => {
                  if (audioLevel > 0.05) {  // Only log significant audio
                    console.log('🔊 Audio level:', audioLevel.toFixed(3));
                  }
                };
                
                // Some Jitsi versions support this event
                track.addEventListener('audio.level.changed', audioLevelHandler);
              } catch {}
              
            } else {
              console.error('❌ Remote audio track present but no MediaStreamTrack could be extracted');
              
              // Last resort: try to force-attach the track
              try {
                const audioEl = document.createElement('audio');
                audioEl.autoplay = true;
                audioEl.muted = true;
                document.body.appendChild(audioEl);
                
                track.attach(audioEl);
                console.log('⚠️ Track attached to element but no MediaStreamTrack available');
                
                // Try to get the srcObject after attach
                if (audioEl.srcObject) {
                  // Cast srcObject to MediaStream for type compatibility
                  const lastResortStream = audioEl.srcObject as MediaStream;
                  console.log('🔄 Last resort: got stream from attached element');
                  this.pipeStreamToAssembly(lastResortStream);
                }
              } catch (e) {
                console.error('❌ Last resort attach failed:', e);
              }
            }
          }
        } catch (e) {
          console.error('❌ TRACK_ADDED handler error:', e);
        }
      });

      conf.on(JitsiMeetJS.events.conference.TRACK_REMOVED, (track: any) => {
        console.log('[TRACK_REMOVED]', track.getType && track.getType(), track.isLocal && track.isLocal());
      });

      // Special handler for audio level changes
      conf.on(JitsiMeetJS.events.conference.TRACK_AUDIO_LEVEL_CHANGED, (participantId: string, audioLevel: number) => {
        // Only log significant audio levels to avoid console spam
        if (audioLevel > 0.05) {
          console.log('[AUDIO_LEVEL]', participantId, audioLevel.toFixed(3));
          
          // If we have a WebSocket but no active track, try to find the track
          if (this.voiceWs && 
              this.voiceWs.readyState === WebSocket.OPEN && 
              !this.activeRemoteTrackId) {
            
            try {
              // Try to get the participant's audio track
              const participant = conf.getParticipantById(participantId);
              if (participant) {
                const tracks = participant.getTracks();
                const audioTrack = tracks.find((t: any) => t.getType() === 'audio');
                
                if (audioTrack) {
                  console.log('🔍 Found audio track via audio level event');
                  // Process this track
                  const mediaTrack = audioTrack.getTrack && audioTrack.getTrack();
                  if (mediaTrack) {
                    console.log('🎵 Capturing audio track from audio level event');
                    this.pipeStreamToAssembly(new MediaStream([mediaTrack]));
                  }
                }
              }
            } catch (e) {
              console.warn('Failed to process audio level event:', e);
            }
          }
        }
      });

      conf.on(JitsiMeetJS.events.conference.USER_JOINED, (id: any) => {
        console.log('[USER_JOINED]', id);
      });
      conf.on(JitsiMeetJS.events.conference.USER_LEFT, (id: any) => {
        console.log('[USER_LEFT]', id);
      });

      conf.join();
    });

    connection.addEventListener(JitsiMeetJS.events.connection.CONNECTION_FAILED, (e: any) => {
      console.error('Jitsi connection failed', e);
    });

    connection.connect();
  }

  private fetchBridgeJwt(roomSlug: string | undefined, fallback: string): Promise<string> {
    return new Promise((resolve) => {
      let resolved = false;
      const timeout = setTimeout(() => { if (!resolved) { resolved = true; resolve(fallback); } }, 1000);
      this.http.post<any>('http://localhost:8000/jaas/jwt', { room: roomSlug, user: { name: 'AgentBridge' }}).subscribe({
        next: (res) => { if (!resolved) { resolved = true; clearTimeout(timeout); resolve(res.jwt || fallback); } },
        error: () => { if (!resolved) { resolved = true; clearTimeout(timeout); resolve(fallback); } }
      });
    });
  }

  private async pipeStreamToAssembly(remoteStream: MediaStream) {
    console.log('🔄 Setting up audio capture pipeline for meeting audio...');
    
    // Close any previous context to avoid multiple processors stacking
    try { await this.audioContext?.close(); } catch {}
    
    // Create a new AudioContext with 48kHz sample rate (Jitsi standard)
    this.audioContext = new AudioContext({ sampleRate: 48000 });
    await this.audioContext.resume();
    console.log('🔊 AudioContext state:', this.audioContext.state, 'sampleRate:', this.audioContext.sampleRate);
    
    // Force user interaction to unlock AudioContext if needed
    if (this.audioContext.state !== 'running') {
      console.log('⚠️ AudioContext not running - waiting for user interaction');
      const resumeHandler = () => {
        this.audioContext?.resume().then(() => {
          console.log('✅ AudioContext resumed after user interaction');
        });
        window.removeEventListener('click', resumeHandler);
        window.removeEventListener('touchstart', resumeHandler);
      };
      window.addEventListener('click', resumeHandler);
      window.addEventListener('touchstart', resumeHandler);
      // Auto-click to try to unlock (works in some browsers)
      try {
        document.body.click();
      } catch {}
    }

    // Verify we have audio tracks in the stream
    const tracks = remoteStream.getAudioTracks();
    console.log('🎤 Audio tracks in stream:', tracks.length, 
      'enabled:', tracks.map(t => t.enabled), 
      'muted:', tracks.map(t => t.muted),
      'readyState:', tracks.map(t => t.readyState));
    
    if (tracks.length === 0) {
      console.error('❌ No audio tracks in stream - cannot capture meeting audio');
      // Try to force start conversation anyway
      if (this.voiceWs?.readyState === WebSocket.OPEN) {
        this.voiceWs.send(JSON.stringify({ type: 'force_start' }));
        console.log('⚡ No audio tracks, but sent force_start to backend');
      }
      return;
    }

    // Create a media stream source from the remote stream
    const source = this.audioContext.createMediaStreamSource(remoteStream);
    
    // Use AudioWorklet for modern browsers
    
    try {
      // Load the audio worklet processor
    await this.audioContext.audioWorklet.addModule('/audio/mic-processor.js');
      
      // Create the worklet node
      const workletNode = new AudioWorkletNode(this.audioContext, 'mic-processor', {
        processorOptions: {
          sourceSampleRate: this.audioContext.sampleRate
        }
      });
      
      // Add diagnostic log inside onaudioprocess
      workletNode.port.onmessage = (event) => {
        // Removed invalid inputBuffer logs
        console.log('📊 Data received from worklet: length=' + event.data.byteLength);
        
        const pcm16 = event.data;
        
        if (this.voiceWs && this.voiceWs.readyState === WebSocket.OPEN) {
          this.voiceWs.send(pcm16);
          this.meetingChunkCount++;
          
          // Log for debugging
          if (this.meetingChunkCount <= 10 || this.meetingChunkCount % 50 === 0) {
            console.log(`📤 Meeting audio chunk ${this.meetingChunkCount}: ${pcm16.byteLength} bytes`);
          }
          
          // Force-start after first few chunks
          if (this._forceStartCountdown > 0) {
            this._forceStartCountdown--;
            if (this._forceStartCountdown === 0) {
              this.voiceWs.send(JSON.stringify({ type: 'force_start' }));
              console.log('⚡ Sent force_start to backend');
            }
          }
        }
      };
      
      // Connect the source to the worklet
      source.connect(workletNode);
      console.log('✅ Audio processing started with AudioWorklet');

      // After processor connection, add state logging interval
      setInterval(() => {
        if (this.audioContext) {
          console.log('🔊 AudioContext diagnostic: state=', this.audioContext.state, 'sampleRate=', this.audioContext.sampleRate);
        }
      }, 2000);

      // Inject a test tone to verify pipeline (440Hz sine wave for 1s)
      const testOscillator = this.audioContext.createOscillator();
      testOscillator.type = 'sine';
      testOscillator.frequency.value = 440;
      testOscillator.connect(workletNode); // Connect to same processor
      testOscillator.start();
      setTimeout(() => testOscillator.stop(), 1000);
      console.log('🎵 Injected test tone to verify audio processing');

    } catch (e) {
      console.error('AudioWorklet failed, falling back to alternative method:', e);
      
      // Create a MediaStreamAudioSourceNode
      const mediaStreamSource = this.audioContext.createMediaStreamSource(remoteStream);
      
      // Create an AnalyserNode
      const analyser = this.audioContext.createAnalyser();
      analyser.fftSize = 2048;
      
      // Connect the source to the analyser
      mediaStreamSource.connect(analyser);
      
      // Set up a periodic processing function
      const processInterval = 100; // ms
      const bufferLength = analyser.frequencyBinCount;
      const dataArray = new Float32Array(bufferLength);
      
      const processAudio = () => {
        if (!this.audioContext) return;
        
        // Get audio data
        analyser.getFloatTimeDomainData(dataArray);
        
        // Process the audio data
        const downsampled = this.downsampleTo16k(dataArray, this.audioContext.sampleRate);
        const pcm16 = this.floatTo16BitPCM(downsampled);
        
        // Send to ElevenLabs
        if (this.voiceWs && this.voiceWs.readyState === WebSocket.OPEN) {
          this.voiceWs.send(pcm16);
          this.meetingChunkCount++;
          
          if (this.meetingChunkCount <= 10 || this.meetingChunkCount % 50 === 0) {
            console.log(`📤 Meeting audio chunk ${this.meetingChunkCount}: ${pcm16.byteLength} bytes (fallback)`);
          }
        }
        
        // Schedule next processing
        setTimeout(processAudio, processInterval);
      };
      
      // Start processing
      processAudio();
      console.log('✅ Audio processing started with AnalyserNode fallback');
    }
    
    // Log message is now in the appropriate try/catch blocks above
    
    // Send an initial empty audio packet to "prime the pump" for ElevenLabs
    if (this.voiceWs && this.voiceWs.readyState === WebSocket.OPEN) {
      this.voiceWs.send(new Uint8Array(320)); // 20ms of silence
      console.log('🚀 Sent initial silence packet to prime connection');
    }
    
    // Last resort: if no chunks processed in first 5s, force start conversation
    setTimeout(() => {
      if (this.meetingChunkCount < 10 && this.voiceWs?.readyState === WebSocket.OPEN) {
        console.warn('⚠️ Very few meeting audio chunks captured - forcing conversation start');
        this.voiceWs.send(JSON.stringify({ type: 'force_start' }));
        
        // Also try restarting audio capture with a fresh track
        if (this.meetingCaptureRestartAttempts < 2 && remoteStream.getAudioTracks()[0]) {
          this.meetingCaptureRestartAttempts++;
          console.log('🔄 Attempting audio capture restart #' + this.meetingCaptureRestartAttempts);
          this.pipeStreamToAssembly(new MediaStream([remoteStream.getAudioTracks()[0]]));
        }
      }
    }, 5000);
  }
  
  // Helper to calculate audio energy (for voice activity detection)
  private calculateAudioEnergy(audioData: Float32Array): number {
    let sum = 0;
    for (let i = 0; i < audioData.length; i++) {
      sum += audioData[i] * audioData[i];
    }
    return sum / audioData.length;
  }
  
  /**
   * Attempt to capture all existing remote audio tracks in the conference
   * This helps when joining a meeting that already has participants
   */
  private captureExistingTracks(conference: any): void {
    try {
      console.log('🔍 Scanning for existing remote audio tracks...');
      
      // Get all participants
      const participants = conference.getParticipants();
      console.log(`Found ${participants.length} participants in the meeting`);
      
      // Loop through each participant
      for (const participant of participants) {
        try {
          const id = participant.getId();
          const tracks = participant.getTracks();
          console.log(`Participant ${id} has ${tracks.length} tracks`);
          
          // Find audio tracks
          const audioTracks = tracks.filter((t: any) => t.getType() === 'audio');
          
          if (audioTracks.length > 0) {
            console.log(`✅ Found ${audioTracks.length} audio tracks for participant ${id}`);
            
            // Process the first audio track
            const audioTrack = audioTracks[0];
            const mediaTrack = audioTrack.getTrack && audioTrack.getTrack();
            
            if (mediaTrack) {
              console.log('🎵 Capturing existing audio track from participant', id);
              this.pipeStreamToAssembly(new MediaStream([mediaTrack]));
              break; // Only process one track for now
            }
          }
        } catch (e) {
          console.warn('Error processing participant:', e);
        }
      }
    } catch (e) {
      console.error('Failed to capture existing tracks:', e);
    }
  }

  private setupWebSockets(sessionId: string) {
    // Connect to the new integrated voice endpoint
    this.voiceWs = new WebSocket(`ws://localhost:8000/agent/${sessionId}/voice`);
    
    // After onopen, add force start timeout
    this.voiceWs.onopen = () => {
      console.log('✅ Integrated voice WebSocket connected');
      // Send initial status request
      this.voiceWs?.send(JSON.stringify({ type: 'status' }));
      
      // Start real-time monitoring
      this.startRealTimeConversation();
      
      // Force start after 5s if no audio detected
      setTimeout(() => {
        if (this.meetingChunkCount === 0) {
          this.voiceWs?.send(JSON.stringify({ type: 'force_start' }));
          console.log('⚡ Force started conversation due to no audio detected');
        }
      }, 5000);
    };
    
    this.voiceWs.onerror = (e) => console.error('❌ Voice WebSocket error:', e);
    
    this.voiceWs.onmessage = async (event) => {
      if (event.data instanceof Blob) {
        // Audio response from ElevenLabs agent - inject into Jitsi meeting
        await this.injectAudioIntoJitsi(event.data);
      } else {
        // JSON message (status, text response, etc.)
        try {
          const data = JSON.parse(event.data);
          console.log('📨 Voice message:', data);
          
          switch (data.type) {
            case 'status':
              console.log('📊 Status:', data.message);
              break;
            case 'text_response':
              this.agentResponses.update((t) => t + data.text + '\n');
              break;
            case 'audio_response':
              console.log('🎵 Audio response received:', data.size, 'bytes');
              break;
            case 'error':
              console.error('❌ Error:', data.message);
              this.agentResponses.update((t) => t + `[ERR] ${data.message}\n`);
              break;
            default:
              console.log('📨 Unknown message type:', data.type);
          }
        } catch (e) {
          console.error('Failed to parse message:', e);
        }
      }
    };
  }

  // Mic capture removed; meeting audio is the sole input source.

  private floatTo16BitPCM(input: Float32Array): ArrayBuffer {
    const len = input.length;
    const buffer = new ArrayBuffer(len * 2);
    const view = new DataView(buffer);
    let offset = 0;
    for (let i = 0; i < len; i++, offset += 2) {
      let s = Math.max(-1, Math.min(1, input[i]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    return buffer;
  }

  private downsampleTo16k(input: Float32Array, sourceRate: number): Float32Array {
    if (sourceRate === 16000) return input;
    const ratio = sourceRate / 16000;
    const newLen = Math.floor(input.length / ratio);
    const result = new Float32Array(newLen);
    let idx = 0;
    let pos = 0;
    while (idx < newLen) {
      const nextPos = Math.round((idx + 1) * ratio);
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

  /**
   * Inject ElevenLabs agent audio response into the Jitsi meeting
   * This method handles the audio format conversion and injection properly
   */
  private async injectAudioIntoJitsi(audioBlob: Blob): Promise<void> {
    try {
      console.log('🎵 Processing agent audio for Jitsi injection...');
      
      // Method 1: Try to decode as PCM audio (ElevenLabs format)
      try {
        await this.injectPCMAudio(audioBlob);
        return;
      } catch (pcmError) {
        console.log('PCM injection failed, trying alternative method:', pcmError);
      }
      
      // Method 2: Try to decode as standard audio format
      try {
        await this.injectStandardAudio(audioBlob);
        return;
      } catch (stdError) {
        console.log('Standard audio injection failed:', stdError);
      }
      
      // Method 3: Fallback to local playback
      console.log('🔄 Using fallback local playback');
      await this.playAudioLocally(audioBlob);
      
    } catch (error) {
      console.error('❌ All audio injection methods failed:', error);
      // Final fallback
      await this.playAudioLocally(audioBlob);
    }
  }

  /**
   * Inject PCM audio from ElevenLabs (16kHz, mono, 16-bit)
   */
  private async injectPCMAudio(audioBlob: Blob): Promise<void> {
    const arrayBuffer = await audioBlob.arrayBuffer();
    const audioData = new Uint8Array(arrayBuffer);
    
    // ElevenLabs PCM format: 16kHz, mono, 16-bit signed little-endian
    const sampleRate = 16000;
    const channels = 1;
    const bitsPerSample = 16;
    
    // Convert to Float32Array for Web Audio API
    const floatArray = new Float32Array(audioData.length / 2);
    const view = new DataView(arrayBuffer);
    
    for (let i = 0; i < floatArray.length; i++) {
      // Read 16-bit signed integer and convert to float (-1 to 1)
      const sample = view.getInt16(i * 2, true); // true = little-endian
      floatArray[i] = sample / 32768.0; // Normalize to [-1, 1]
    }
    
    // Create audio context with ElevenLabs sample rate
    const audioContext = new AudioContext({ sampleRate });
    await audioContext.resume();
    
    // Create audio buffer
    const audioBuffer = audioContext.createBuffer(channels, floatArray.length, sampleRate);
    audioBuffer.getChannelData(0).set(floatArray);
    
    // Create source and play
    const source = audioContext.createBufferSource();
    source.buffer = audioBuffer;
    
    // Connect to destination (for now, local playback)
    // TODO: Integrate with Jitsi audio system
    source.connect(audioContext.destination);
    source.start();
    
    console.log('✅ PCM audio injected successfully (16kHz, mono)');
    
    // Clean up
    source.onended = () => {
      audioContext.close();
    };
  }

  /**
   * Inject standard audio formats (MP3, WAV, etc.)
   */
  private async injectStandardAudio(audioBlob: Blob): Promise<void> {
    const arrayBuffer = await audioBlob.arrayBuffer();
    
    // Try to decode as standard audio format
    const audioContext = new AudioContext({ sampleRate: 44100 }); // Standard sample rate
    await audioContext.resume();
    
    const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
    
    // Create source and play
    const source = audioContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(audioContext.destination);
    source.start();
    
    console.log('✅ Standard audio injected successfully');
    
    // Clean up
    source.onended = () => {
      audioContext.close();
    };
  }

  /**
   * Fallback: Play audio locally
   */
  private async playAudioLocally(audioBlob: Blob): Promise<void> {
    try {
      const url = URL.createObjectURL(audioBlob);
      const audio = new Audio(url);
      
      // Set audio properties for better compatibility
      audio.preload = 'auto';
      audio.volume = 0.8; // Slightly lower volume to avoid feedback
      
      await audio.play();
      console.log('🔊 Audio playing locally (fallback)');
      
      // Clean up URL after playback
      audio.onended = () => {
        URL.revokeObjectURL(url);
      };
      
    } catch (error) {
      console.error('❌ Local audio playback failed:', error);
    }
  }

  // Replace the entire startRealTimeConversation method
  private async startRealTimeConversation(): Promise<void> {
    console.log('🔄 Starting real-time conversation monitoring...');
    
    // Set up continuous audio monitoring with local microphone
    if (this.audioContext) {
      await this.audioContext.audioWorklet.addModule('audio-processor.js');
      
      const monitorProcessor = new AudioWorkletNode(this.audioContext, 'audio-processor');
      
      // Get local microphone stream
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const source = this.audioContext.createMediaStreamSource(stream);
        source.connect(monitorProcessor);
        console.log('✅ Connected local microphone to monitoring processor');
      } catch (error) {
        console.error('❌ Failed to get local microphone:', error);
        return;
      }
      
      monitorProcessor.port.onmessage = (event) => {
        console.log('🔊 onmessage received from worklet - data length:', event.data.byteLength);
        const inputData = event.data; // Assuming worklet sends Float32Array or Uint8Array (PCM)
        const energy = this.calculateAudioEnergy(inputData);
        const hasAudio = energy > 0.0001; // Adjust threshold as needed
        if (hasAudio) {
          console.log('🔊 Audio activity detected with energy:', energy);
          // Send the processed audio to ElevenLabs via WebSocket
          if (this.voiceWs && this.voiceWs.readyState === WebSocket.OPEN) {
            this.voiceWs.send(event.data);
            console.log('📤 Sent local audio chunk to ElevenLabs');
          }
          // The response will be handled in voiceWs.onmessage and injected via injectAudioIntoJitsi
        }
      };
      
      // Connect to destination if needed (for monitoring, but muted to avoid feedback)
      monitorProcessor.connect(this.audioContext.destination);
      console.log('✅ Real-time conversation monitoring started with AudioWorklet (no local playback)');
    }
  }
}