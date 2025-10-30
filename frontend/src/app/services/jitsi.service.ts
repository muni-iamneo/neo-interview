import { Injectable } from '@angular/core';
import { Subject } from 'rxjs';
import { ConfigService } from './config.service';

export interface JitsiConnectionConfig {
  domain: string;
  room: string;
  jwt: string;
}

export interface JitsiTrackInfo {
  track: any;
  trackId: string;
}

/**
 * Jitsi Service
 * Handles all Jitsi conference management including connection, tracks, and peer connections
 */
@Injectable({
  providedIn: 'root'
})
export class JitsiService {
  private activeConference: any = null;
  private activeRemoteTrackId: string | null = null;
  private trackPollingInterval: any = null;
  private placeholderJitsiAudioTrack: any | null = null;
  private agentAudioTrack: MediaStreamTrack | null = null;
  private agentAudioSender: RTCRtpSender | null = null;
  private agentTrackInjected = false;

  // Observables
  public conferenceJoined$ = new Subject<void>();
  public remoteTrackAdded$ = new Subject<JitsiTrackInfo>();
  public remoteTrackRemoved$ = new Subject<string>();
  public conferenceError$ = new Subject<any>();
  public p2pStatusChanged$ = new Subject<boolean>();
  public connectionRestored$ = new Subject<void>();

  constructor(private config: ConfigService) {}

  /**
   * Wait for Jitsi scripts to load
   */
  waitForJitsiScripts(timeoutMs: number = this.config.JITSI_SCRIPTS_TIMEOUT): Promise<void> {
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

  /**
   * Initialize Jitsi iframe API
   */
  setupIframeWithRetry(
    room: string,
    jwt: string,
    attempts: number = this.config.JITSI_IFRAME_RETRY_ATTEMPTS,
    delayMs: number = this.config.JITSI_IFRAME_RETRY_DELAY,
    onJoined?: () => void
  ): void {
    const JitsiMeetExternalAPI = (window as any).JitsiMeetExternalAPI;
    const parent = document.getElementById('jaas-iframe');

    if (!JitsiMeetExternalAPI) {
      console.warn('🕒 JitsiMeetExternalAPI not yet present, retrying...');
      if (attempts > 0) {
        setTimeout(() => this.setupIframeWithRetry(room, jwt, attempts - 1, delayMs, onJoined), delayMs);
      }
      return;
    }

    if (!parent) {
      console.warn('🕒 Iframe container #jaas-iframe not yet in DOM. Retrying...');
      if (attempts > 0) {
        setTimeout(() => this.setupIframeWithRetry(room, jwt, attempts - 1, delayMs, onJoined), delayMs);
      } else {
        console.error('❌ Failed to find #jaas-iframe container after retries');
      }
      return;
    }

    if (parent.childElementCount > 0) {
      console.log('ℹ️ Jitsi iframe already initialized. Skipping duplicate init.');
      return;
    }

    console.log('🎬 Initializing Jitsi iframe UI');
    try {
      const api = new JitsiMeetExternalAPI(this.config.JITSI_DOMAIN, {
        roomName: room,
        parentNode: parent,
        jwt,
        configOverwrite: { prejoinPageEnabled: true, p2p: { enabled: false } },
      });

      api.addEventListener('videoConferenceJoined', () => {
        console.log('✅ iframe: videoConferenceJoined');
        if (onJoined) onJoined();
      });

      api.addEventListener('videoConferenceLeft', () => console.log('iframe: left'));
      api.addEventListener('errorOccurred', (e: any) => console.error('iframe error', e));
    } catch (e) {
      console.error('❌ Failed to initialize Jitsi iframe:', e);
    }
  }

  /**
   * Join Jitsi conference (headless)
   */
  async joinConference(config: JitsiConnectionConfig): Promise<void> {
    const JitsiMeetJS = (window as any).JitsiMeetJS;
    if (!JitsiMeetJS) {
      throw new Error('lib-jitsi-meet not available');
    }

    JitsiMeetJS.init({
      disableAudioLevels: false,
      enableNoAudioDetection: true,
      disableAP: true,
      disableAEC: true,
      disableNS: true,
      disableAGC: true,
    });
    JitsiMeetJS.setLogLevel(JitsiMeetJS.logLevels.INFO);

    const roomParts = config.room.split('/');
    const isJaas = roomParts.length > 1;
    const conferenceRoomName = isJaas ? roomParts[1] : config.room;
    const jaasTenant = isJaas ? roomParts[0] : null;

    if (!isJaas || !jaasTenant) {
      throw new Error('Invalid JaaS room format. Expected tenant/roomname.');
    }

    const options = {
      hosts: { domain: this.config.JITSI_DOMAIN, muc: `conference.${jaasTenant}.${this.config.JITSI_DOMAIN}` },
      p2p: { enabled: false },
      serviceUrl: `wss://${this.config.JITSI_DOMAIN}/${jaasTenant}/xmpp-websocket?room=${encodeURIComponent(conferenceRoomName)}`,
      clientNode: 'http://jitsi.org/jitsimeet'
    };

    console.log('🔧 Jitsi connection options:', options);
    const connection = new JitsiMeetJS.JitsiConnection(null, config.jwt, options);

    return new Promise((resolve, reject) => {
      connection.addEventListener(JitsiMeetJS.events.connection.CONNECTION_ESTABLISHED, () => {
        console.log('✅ Jitsi headless connection established');

        const confOptions = {};
        console.log('🔧 Creating conference with options:', { roomName: conferenceRoomName, options: confOptions });
        const conference = connection.initJitsiConference(conferenceRoomName, confOptions);
        this.activeConference = conference;

        this.setupConferenceEventListeners(conference, JitsiMeetJS);

        console.log('🎯 Attempting to join conference...');
        conference.join();
        resolve();
      });

      connection.addEventListener(JitsiMeetJS.events.connection.CONNECTION_FAILED, (e: any) => {
        console.error('Jitsi connection failed', e);
        reject(e);
      });

      connection.connect();
    });
  }

  /**
   * Setup conference event listeners
   */
  private setupConferenceEventListeners(conference: any, JitsiMeetJS: any): void {
    conference.on(JitsiMeetJS.events.conference.CONFERENCE_JOINED, () => {
      console.log('✅ Jitsi headless conference joined');
      this.conferenceJoined$.next();
    });

    conference.on(JitsiMeetJS.events.conference.TRACK_ADDED, (track: any) => {
      if (!track.isLocal() && track.getType() === 'audio') {
        console.log('🎵 TRACK_ADDED event fired. Handling track.');
        const mediaTrack = track.getTrack();
        if (mediaTrack) {
          this.remoteTrackAdded$.next({ track, trackId: mediaTrack.id });
        }
      }
    });

    conference.on(JitsiMeetJS.events.conference.TRACK_REMOVED, (track: any) => {
      if (this.activeRemoteTrackId && this.activeRemoteTrackId === track.getTrack()?.id) {
        console.log('🛑 Active track removed. Restarting polling.');
        const trackId = this.activeRemoteTrackId;
        this.activeRemoteTrackId = null;
        this.remoteTrackRemoved$.next(trackId);
      }
    });

    conference.on(JitsiMeetJS.events.conference.P2P_STATUS, async (isP2P: boolean) => {
      console.log(`[P2P_STATUS] isP2P=${isP2P}`);
      this.p2pStatusChanged$.next(isP2P);
    });

    conference.on(JitsiMeetJS.events.conference.USER_LEFT, (id: any, user: any) => {
      console.log(`[USER_LEFT] ${id} (${user.getDisplayName()})`);
      const remoteTracks = user.getTracks();
      if (this.activeRemoteTrackId && remoteTracks.some((t: any) => t.getTrack()?.id === this.activeRemoteTrackId)) {
        console.log('🎤 Tracked user left. Restarting polling.');
        const trackId = this.activeRemoteTrackId;
        this.activeRemoteTrackId = null;
        this.remoteTrackRemoved$.next(trackId);
      }
    });

    conference.on(JitsiMeetJS.events.conference.CONFERENCE_FAILED, (err: any) => {
      console.error('❌ CONFERENCE_FAILED', err);
      console.error('Conference failed details:', JSON.stringify(err, null, 2));
      this.conferenceError$.next(err);
    });

    conference.on(JitsiMeetJS.events.conference.CONFERENCE_ERROR, (err: any) => {
      console.error('❌ CONFERENCE_ERROR', err);
      console.error('Conference error details:', JSON.stringify(err, null, 2));
      this.conferenceError$.next(err);
    });

    conference.on(JitsiMeetJS.events.conference.CONNECTION_ESTABLISHED, () => {
      console.log('🔗 Conference connection established');
    });

    conference.on(JitsiMeetJS.events.conference.CONNECTION_INTERRUPTED, () => {
      console.log('⚠️ Conference connection interrupted');
    });

    conference.on(JitsiMeetJS.events.conference.CONNECTION_RESTORED, () => {
      console.log('🔄 Conference connection restored');
      this.connectionRestored$.next();
    });
  }

  /**
   * Start polling for remote audio track
   */
  startPollingForTrack(): void {
    if (this.trackPollingInterval) {
      clearInterval(this.trackPollingInterval);
    }

    console.log('🔍 Starting polling for remote audio track...');
    this.trackPollingInterval = setInterval(() => {
      if (this.activeRemoteTrackId) {
        clearInterval(this.trackPollingInterval);
        this.trackPollingInterval = null;
        return;
      }

      const participants = this.activeConference?.getParticipants();
      if (!participants) return;

      for (const p of participants) {
        const audioTrack = p.getTracks().find((t: any) => t.getType() === 'audio' && !t.isMuted());
        if (audioTrack) {
          console.log(`✅ Polling found active audio track: ${audioTrack.getId()} from participant ${p.getId()}`);
          const mediaTrack = audioTrack.getTrack();
          if (mediaTrack) {
            this.activeRemoteTrackId = mediaTrack.id;
            this.remoteTrackAdded$.next({ track: audioTrack, trackId: mediaTrack.id });
          }
          return;
        }
      }
    }, this.config.TRACK_POLLING_INTERVAL);
  }

  /**
   * Stop polling for tracks
   */
  stopPollingForTrack(): void {
    if (this.trackPollingInterval) {
      clearInterval(this.trackPollingInterval);
      this.trackPollingInterval = null;
    }
  }

  /**
   * Create and add a synthetic silent audio track (no mic permission needed)
   */
  async ensurePlaceholderAudioTrack(): Promise<void> {
    if (!this.activeConference) {
      console.warn('⚠️ Cannot create placeholder: no active conference');
      return;
    }

    if (this.placeholderJitsiAudioTrack) {
      console.log('✅ Placeholder track already exists');
      return;
    }

    try {
      console.log('🎤 Creating synthetic silent audio placeholder (no mic permission needed)...');

      const audioCtx = new AudioContext();
      const oscillator = audioCtx.createOscillator();
      oscillator.frequency.value = 0;
      const gain = audioCtx.createGain();
      gain.gain.value = 0;
      const dst = audioCtx.createMediaStreamDestination();
      oscillator.connect(gain);
      gain.connect(dst);
      oscillator.start();

      const silentTrack = dst.stream.getAudioTracks()[0];
      if (!silentTrack) {
        console.warn('⚠️ Failed to create synthetic audio track');
        audioCtx.close();
        return;
      }

      console.log('🔇 Created silent track:', silentTrack.id, 'enabled:', silentTrack.enabled);

      const userId = this.activeConference.myUserId() || 'agent';
      let sourceName = `${userId}-a0`;
      const wrappedTrack: any = {
        track: silentTrack,
        stream: dst.stream,
        getType: () => 'audio',
        getTrack: () => silentTrack,
        isLocal: () => true,
        isMuted: () => !silentTrack.enabled,
        getVideoType: () => null,
        getParticipantId: () => userId,
        isAudioTrack: () => true,
        isVideoTrack: () => false,
        getId: () => silentTrack.id,
        getSourceName: () => sourceName,
        setSourceName: (name: string) => { sourceName = name; },
        setSsrc: (_: any) => {},
        setMsid: (_: any) => {},
        setConference: (_: any) => {},
        containers: [],
        mute: async () => { silentTrack.enabled = false; },
        unmute: async () => { silentTrack.enabled = true; },
        setMute: async (muted: boolean) => { silentTrack.enabled = !muted; },
        getOriginalStream: () => dst.stream,
        getStreamId: () => dst.stream.id,
        getTrackId: () => silentTrack.id,
        getTrackLabel: () => silentTrack.label,
        dispose: () => {
          try {
            silentTrack.stop();
            audioCtx.close();
          } catch (e) {
            console.warn('Cleanup error:', e);
          }
        },
        on: () => {},
        off: () => {},
        once: () => {},
        emit: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        removeAllListeners: () => {}
      };

      await this.activeConference.addTrack(wrappedTrack);
      this.placeholderJitsiAudioTrack = wrappedTrack;
      console.log('✅ Synthetic placeholder audio track added');

      await new Promise(resolve => setTimeout(resolve, 200));

      this.agentAudioSender = this.getAudioSender();
      if (this.agentAudioSender) {
        console.log('🔗 Cached audio RTCRtpSender from placeholder');
      } else {
        console.warn('⚠️ Could not locate audio RTCRtpSender yet');
      }
    } catch (e) {
      console.error('❌ ensurePlaceholderAudioTrack failed:', e);
      throw e;
    }
  }

  /**
   * Get or create audio sender for agent audio injection
   */
  async ensureOrCreateAudioSender(): Promise<RTCRtpSender | null> {
    try {
      console.log('🔍 ensureOrCreateAudioSender: Starting...');

      const rtc = this.activeConference?.rtc || (this.activeConference?.getRTC && this.activeConference.getRTC());
      if (!rtc) {
        console.warn('⚠️ ensureOrCreateAudioSender: No RTC object found');
        return null;
      }

      console.log('🔍 ensureOrCreateAudioSender: RTC object keys:', Object.keys(rtc));

      let containers: any = rtc.peerConnections || rtc._peerConnections || rtc._peerConnectionsMap || rtc.peerconnections;

      if (containers instanceof Map) {
        containers = Array.from(containers.values());
      } else if (typeof containers === 'object') {
        containers = Object.values(containers);
      } else {
        containers = [];
      }

      const pcHolders = containers as any[];
      console.log('🔍 ensureOrCreateAudioSender: Found', pcHolders.length, 'peer connections');

      if (pcHolders.length === 0) {
        console.warn('⚠️ ensureOrCreateAudioSender: No peer connections found');
      }

      let pc: RTCPeerConnection | undefined;
      let activeHolder: any = null;

      if (pcHolders.length > 0) {
        activeHolder = pcHolders.find(h => (h as any)._isMediaTransferActive);

        if (!activeHolder) {
          console.warn('⚠️ ensureOrCreateAudioSender: No active media transfer PC found');
        } else {
          pc = activeHolder.peerconnection || activeHolder.pc || activeHolder._pc;
          console.log('✅ Found active holder:', {
            type: (activeHolder as any).type,
            isActive: (activeHolder as any)._isMediaTransferActive
          });
        }
      }

      if (!pc) {
        console.log('⚠️ ensureOrCreateAudioSender: No PC from holders, trying jingleSession...');
        try {
          const p2pSession = (this.activeConference as any).p2pJingleSession || (this.activeConference as any)._p2pJingleSession;
          if (p2pSession) {
            const pcWrapper = p2pSession.peerconnection;
            if (pcWrapper) {
              pc = pcWrapper.peerconnection || pcWrapper._pc || pcWrapper.pc || pcWrapper;
              console.log('✅ Found PC via p2pJingleSession');
            }
          }

          if (!pc || !(pc as any)?.getSenders) {
            const jingleSession = (this.activeConference as any).jvbJingleSession || (this.activeConference as any)._jvbJingleSession;
            if (jingleSession) {
              const pcWrapper = jingleSession.peerconnection;
              if (pcWrapper) {
                pc = pcWrapper.peerconnection || pcWrapper._pc || pcWrapper.pc || pcWrapper;
                console.log('✅ Found PC via jvbJingleSession');
              }
            }
          }
        } catch (err) {
          console.warn('⚠️ Failed to access jingleSession:', err);
        }
      }

      if (!pc) {
        console.warn('⚠️ ensureOrCreateAudioSender: No peer connection found');
        return null;
      }

      if (!(pc as any)?.getSenders || typeof (pc as any).getSenders !== 'function') {
        console.error('❌ Found object is not a valid RTCPeerConnection');
        return null;
      }

      console.log('🔍 ensureOrCreateAudioSender: Waiting for PC to be ready...');
      for (let i = 0; i < 10; i++) {
        const connected = (pc as any).connectionState === 'connected' || (pc as any).iceConnectionState === 'connected';
        const stable = pc.signalingState === 'stable';
        if (connected && stable) {
          console.log('✅ ensureOrCreateAudioSender: PC is ready');
          break;
        }
        await new Promise(r => setTimeout(r, 150));
      }

      const allSenders = pc.getSenders();
      console.log('🔍 ensureOrCreateAudioSender: Found', allSenders.length, 'senders on PC');

      const existing = allSenders.find(s => s.track && s.track.kind === 'audio');
      if (existing) {
        console.log('🔗 Found existing audio sender:', existing.track?.id);
        return existing;
      }

      console.log('⚠️ ensureOrCreateAudioSender: No existing audio sender found');

      const localTracks = this.activeConference.getLocalTracks();
      const hasLocalAudioTrack = localTracks.some((t: any) => t.getType && t.getType() === 'audio');

      if (hasLocalAudioTrack && this.placeholderJitsiAudioTrack) {
        console.log('📡 Placeholder exists but no sender on active PC - likely P2P transition');
        console.log('⏳ Waiting for Jitsi to migrate track...');

        for (let i = 0; i < 5; i++) {
          const sender = pc.getSenders().find(s => s.track && s.track.kind === 'audio');
          if (sender) {
            console.log('✅ Found sender after auto-migration (iteration', i, ')');
            return sender;
          }
          await new Promise(r => setTimeout(r, 200));
        }

        console.log('⚠️ Jitsi did not auto-migrate. Manually re-adding placeholder...');
        try {
          const placeholderTrack = this.placeholderJitsiAudioTrack;
          await this.activeConference.removeTrack(placeholderTrack);
          console.log('🗑️ Removed old placeholder track');

          await new Promise(r => setTimeout(r, 300));

          await this.activeConference.addTrack(placeholderTrack);
          console.log('➕ Re-added placeholder track');

          for (let i = 0; i < 15; i++) {
            const sender = pc.getSenders().find(s => s.track && s.track.kind === 'audio');
            if (sender) {
              console.log('✅ Found sender after manual re-add (iteration', i, ')');
              return sender;
            }
            await new Promise(r => setTimeout(r, 200));
          }
        } catch (err) {
          console.error('❌ Failed to manually re-add placeholder:', err);
        }
      }

      if (!hasLocalAudioTrack) {
        console.log('🎤 No local audio track - creating placeholder');
        await this.ensurePlaceholderAudioTrack();

        for (let i = 0; i < 15; i++) {
          const viaConference = this.getAudioSender();
          if (viaConference) {
            console.log('✅ Found sender after creating placeholder (iteration', i, ')');
            return viaConference;
          }
          await new Promise(r => setTimeout(r, 200));
        }
      }

      console.log('⚠️ Fallback: creating sendonly transceiver');
      try {
        const tx = pc.addTransceiver('audio', { direction: 'sendonly' });
        for (let i = 0; i < 10; i++) {
          const s = pc.getSenders().find(snd => snd.track && snd.track.kind === 'audio') || tx.sender;
          if (s) {
            console.log('✅ Created sender via transceiver');
            return s;
          }
          await new Promise(r => setTimeout(r, 150));
        }
        return tx.sender || null;
      } catch (err) {
        console.error('❌ Failed to create transceiver:', err);
        return null;
      }
    } catch (err) {
      console.warn('⚠️ ensureOrCreateAudioSender failed:', err);
      return null;
    }
  }

  /**
   * Get audio sender from conference
   */
  getAudioSender(): RTCRtpSender | null {
    if (!this.activeConference) {
      return null;
    }

    try {
      const localTracks = this.activeConference.getLocalTracks();
      const currentLocalAudioTrack = localTracks.find((t: any) => t.getType() === 'audio');

      if (!currentLocalAudioTrack) {
        console.warn('[getAudioSender] No local audio track found');
        return null;
      }

      const trackToFind = currentLocalAudioTrack.getTrack();
      if (!trackToFind) {
        console.warn('[getAudioSender] Local audio track has no MediaStreamTrack');
        return null;
      }

      const rtc = this.activeConference.rtc || (this.activeConference.getRTC && this.activeConference.getRTC());
      if (!rtc) return null;

      const containers = rtc.peerConnections || rtc._peerConnections || rtc._peerConnectionsMap || {};
      const pcHolders = Object.values(containers) as any[];

      const activeHolder = pcHolders.find(h => (h as any)._isMediaTransferActive);
      if (activeHolder) {
        const activePc = activeHolder.peerconnection || activeHolder.pc || activeHolder._pc;
        if (activePc) {
          const sender = activePc.getSenders().find((s: RTCRtpSender) => s.track === trackToFind);
          if (sender) {
            console.log(`[getAudioSender] Found sender on ACTIVE PC`);
            return sender;
          }
        }
      }

      for (const holder of pcHolders) {
        const pc = holder?.peerconnection || holder?.pc || holder?._pc;
        if (pc) {
          const sender = pc.getSenders().find((s: RTCRtpSender) => s.track === trackToFind);
          if (sender) {
            console.log(`[getAudioSender] Found sender on inactive PC`);
            return sender;
          }
        }
      }

      console.warn('[getAudioSender] No sender found for track', trackToFind.id);
    } catch (err) {
      console.warn('⚠️ Error during getAudioSender:', err);
    }

    return null;
  }

  /**
   * Inject agent audio track into conference
   */
  async injectAgentAudioTrack(destTrack: MediaStreamTrack): Promise<boolean> {
    if (!this.activeConference) {
      console.warn('⚠️ Cannot inject audio: no conference');
      return false;
    }

    try {
      console.log('🎯 Attempting to inject agent audio into conference...');

      const sender = await this.ensureOrCreateAudioSender();
      if (!sender) {
        console.error('❌ Failed to obtain RTCRtpSender for audio');
        return false;
      }

      this.agentAudioSender = sender;
      console.log('🔄 Replacing sender track with agent audio');

      await this.agentAudioSender.replaceTrack(destTrack);
      this.agentAudioTrack = destTrack;
      this.agentAudioTrack.enabled = true;
      this.agentTrackInjected = true;

      console.log('✅ Agent audio track successfully injected into conference');
      return true;
    } catch (e) {
      console.error('❌ Failed to inject agent audio:', e);
      this.agentTrackInjected = false;
      return false;
    }
  }

  /**
   * Re-inject agent audio after P2P transition
   */
  async reInjectAgentAudio(destTrack: MediaStreamTrack): Promise<void> {
    console.log('🔄 Re-injecting agent audio after P2P transition...');
    const wasInjected = this.agentTrackInjected;
    this.agentTrackInjected = false;

    const sender = await this.ensureOrCreateAudioSender();
    if (sender) {
      console.log('✅ Got sender after P2P transition, injecting agent audio');
      await this.injectAgentAudioTrack(destTrack);
    } else {
      console.warn('⚠️ Could not obtain sender after P2P transition');
      this.agentTrackInjected = wasInjected;
    }
  }

  /**
   * Leave conference and cleanup
   */
  async cleanup(): Promise<void> {
    console.log('[Jitsi] Cleaning up resources...');

    this.stopPollingForTrack();

    if (this.agentAudioTrack && this.activeConference) {
      try {
        this.activeConference.removeTrack(this.agentAudioTrack);
        console.log('🎤 Removed agent audio track');
      } catch (e) {
        console.warn('⚠️ Error removing agent audio track:', e);
      }
    }

    if (this.placeholderJitsiAudioTrack && this.activeConference) {
      try {
        this.activeConference.removeTrack(this.placeholderJitsiAudioTrack);
        console.log('🧹 Removed placeholder audio track');
      } catch (e) {
        console.warn('⚠️ Error removing placeholder audio track:', e);
      }
      this.placeholderJitsiAudioTrack = null;
    }

    if (this.activeConference) {
      try {
        this.activeConference.removeAllTracks();
        this.activeConference.leave();
        console.log('🚪 Left Jitsi conference');
      } catch (e) {
        console.warn('⚠️ Error leaving conference:', e);
      }
      this.activeConference = null;
    }

    this.agentAudioTrack = null;
    this.agentAudioSender = null;
    this.agentTrackInjected = false;
    this.activeRemoteTrackId = null;
  }

  /**
   * Getters
   */
  getActiveConference(): any {
    return this.activeConference;
  }

  getActiveRemoteTrackId(): string | null {
    return this.activeRemoteTrackId;
  }

  setActiveRemoteTrackId(trackId: string | null): void {
    this.activeRemoteTrackId = trackId;
  }

  isAgentTrackInjected(): boolean {
    return this.agentTrackInjected;
  }

  getAgentAudioTrack(): MediaStreamTrack | null {
    return this.agentAudioTrack;
  }
}
