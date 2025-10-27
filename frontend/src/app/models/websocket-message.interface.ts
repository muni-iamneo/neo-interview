/**
 * WebSocket Message Type Definitions
 */

// Base message interface
export interface WebSocketMessage {
  type: string;
  timestamp?: number;
}

// Status messages
export interface StatusMessage extends WebSocketMessage {
  type: 'status';
  message?: string;
  status?: string;
  active?: boolean;
  started?: boolean;
  reason?: string;
}

// Text response from agent
export interface TextResponseMessage extends WebSocketMessage {
  type: 'text_response';
  text: string;
}

// Audio response metadata
export interface AudioResponseMessage extends WebSocketMessage {
  type: 'audio_response';
  size: number;
}

// Error messages
export interface ErrorMessage extends WebSocketMessage {
  type: 'error';
  message: string;
}

// Client to server messages
export interface PingMessage extends WebSocketMessage {
  type: 'ping';
}

export interface StopMessage extends WebSocketMessage {
  type: 'stop';
}

export interface ForceStartMessage extends WebSocketMessage {
  type: 'force_start';
}

// Union type for all message types
export type AnyWebSocketMessage =
  | StatusMessage
  | TextResponseMessage
  | AudioResponseMessage
  | ErrorMessage
  | PingMessage
  | StopMessage
  | ForceStartMessage;

// Type guards
export function isStatusMessage(msg: WebSocketMessage): msg is StatusMessage {
  return msg.type === 'status';
}

export function isTextResponse(msg: WebSocketMessage): msg is TextResponseMessage {
  return msg.type === 'text_response';
}

export function isAudioResponse(msg: WebSocketMessage): msg is AudioResponseMessage {
  return msg.type === 'audio_response';
}

export function isErrorMessage(msg: WebSocketMessage): msg is ErrorMessage {
  return msg.type === 'error';
}

