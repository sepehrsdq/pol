// Types for the parts of node-datachannel the CLI uses (only .cjs import).
declare module 'node-datachannel' {
  export interface PeerConnection {
    onLocalDescription(cb: (sdp: string, type: string) => void): void;
    onLocalCandidate(cb: (candidate: string, mid: string) => void): void;
    onStateChange(cb: (state: string) => void): void;
    onDataChannel(cb: (channel: DataChannel) => void): void;
    setRemoteDescription(sdp: string, type: string): void;
    addRemoteCandidate(candidate: string, mid: string): void;
    createDataChannel(label: string, options: Record<string, unknown>): DataChannel;
    localDescription(): { sdp: string; type: string } | null;
    state(): string;
    close(): void;
  }
  export interface DataChannel {
    onOpen(cb: () => void): void;
    onClosed(cb: () => void): void;
    onError(cb: (message: string) => void): void;
    onMessage(cb: (message: string | ArrayBuffer) => void): void;
    sendMessage(text: string): boolean;
    sendMessageBinary(bytes: Uint8Array): boolean;
    bufferedAmount(): number;
    close(): void;
  }
  export class PeerConnection {
    constructor(name: string, options: Record<string, unknown>);
  }
}
