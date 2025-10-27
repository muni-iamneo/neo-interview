import { Injectable } from '@angular/core';
import { Subject, BehaviorSubject } from 'rxjs';
import { WebSocketMessage } from '../models/websocket-message.interface';

export interface WebSocketConfig {
  url: string;
  reconnectInterval?: number;
  maxReconnectAttempts?: number;
}

@Injectable({
  providedIn: 'root'
})
export class VoiceWebSocketService {
  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectInterval = 2000; // Start with 2 seconds
  private reconnectTimer: any = null;
  private url: string = '';
  private isIntentionallyClosed = false;

  // Observables for component communication
  public messages$ = new Subject<any>();
  public audioData$ = new Subject<Blob>();
  public connectionStatus$ = new BehaviorSubject<'disconnected' | 'connecting' | 'connected' | 'error'>('disconnected');
  public errors$ = new Subject<string>();

  constructor() {}

  /**
   * Connect to WebSocket with automatic reconnection
   */
  connect(config: WebSocketConfig): void {
    this.url = config.url;
    this.maxReconnectAttempts = config.maxReconnectAttempts || 5;
    this.reconnectInterval = config.reconnectInterval || 2000;
    this.isIntentionallyClosed = false;
    
    this.attemptConnection();
  }

  private attemptConnection(): void {
    if (this.ws && (this.ws.readyState === WebSocket.CONNECTING || this.ws.readyState === WebSocket.OPEN)) {
      console.log('[WS] Already connected or connecting');
      return;
    }

    this.connectionStatus$.next('connecting');
    console.log(`[WS] Attempting connection (attempt ${this.reconnectAttempts + 1}/${this.maxReconnectAttempts})`);

    try {
      this.ws = new WebSocket(this.url);
      this.setupEventHandlers();
    } catch (error) {
      console.error('[WS] Connection error:', error);
      this.handleReconnect();
    }
  }

  private setupEventHandlers(): void {
    if (!this.ws) return;

    this.ws.onopen = () => {
      console.log('[WS] Connected successfully');
      this.connectionStatus$.next('connected');
      this.reconnectAttempts = 0; // Reset reconnect counter on successful connection
      this.reconnectInterval = 2000; // Reset interval
    };

    this.ws.onmessage = async (event) => {
      if (event.data instanceof Blob) {
        // Binary audio data
        this.audioData$.next(event.data);
      } else {
        // JSON message
        try {
          const data = JSON.parse(event.data);
          this.messages$.next(data);
        } catch (error) {
          console.error('[WS] Failed to parse message:', error);
        }
      }
    };

    this.ws.onerror = (error) => {
      console.error('[WS] WebSocket error:', error);
      this.connectionStatus$.next('error');
      this.errors$.next('WebSocket connection error');
    };

    this.ws.onclose = (event) => {
      console.log(`[WS] Connection closed (code: ${event.code}, reason: ${event.reason})`);
      this.connectionStatus$.next('disconnected');
      
      if (!this.isIntentionallyClosed) {
        this.handleReconnect();
      }
    };
  }

  private handleReconnect(): void {
    if (this.isIntentionallyClosed) {
      console.log('[WS] Not reconnecting - connection intentionally closed');
      return;
    }

    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('[WS] Max reconnect attempts reached');
      this.errors$.next(`Failed to reconnect after ${this.maxReconnectAttempts} attempts`);
      return;
    }

    this.reconnectAttempts++;
    
    // Exponential backoff with jitter
    const backoffTime = Math.min(
      this.reconnectInterval * Math.pow(1.5, this.reconnectAttempts - 1),
      30000 // Max 30 seconds
    );
    const jitter = Math.random() * 1000; // Add up to 1 second of jitter
    const delay = backoffTime + jitter;

    console.log(`[WS] Reconnecting in ${(delay / 1000).toFixed(1)} seconds...`);
    
    this.reconnectTimer = setTimeout(() => {
      this.attemptConnection();
    }, delay);
  }

  /**
   * Send binary data (audio)
   */
  sendBinary(data: ArrayBuffer | Blob): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(data);
    } else {
      console.warn('[WS] Cannot send binary - WebSocket not open');
    }
  }

  /**
   * Send JSON message
   */
  sendMessage(message: WebSocketMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    } else {
      console.warn('[WS] Cannot send message - WebSocket not open');
    }
  }

  /**
   * Close connection (will not auto-reconnect)
   */
  disconnect(): void {
    this.isIntentionallyClosed = true;
    
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    this.connectionStatus$.next('disconnected');
    console.log('[WS] Disconnected');
  }

  /**
   * Get current connection status
   */
  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  /**
   * Ping server to keep connection alive
   */
  ping(): void {
    this.sendMessage({ type: 'ping' });
  }
}

