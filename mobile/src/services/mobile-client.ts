import type { PairedDesktop } from './paired-desktops';
import { decodeBase64Url, MobileNoiseHandshake } from './noise-handshake';
import { parsePairedSessions, parsePtyOutputBatch, type PairingCode, type PairedSession, type PtyOutputBatch } from './pairing-code';

const HANDSHAKE_TIMEOUT_MS = 8_000;
const REQUEST_TIMEOUT_MS = 12_000;
const PAIRING_APPROVAL_TIMEOUT_MS = 125_000;
// Torann's Noise transport follows the 65,535-byte Noise message ceiling.
// Leave room for tags and JSON escaping, especially terminal control bytes.
const MAX_RPC_PLAINTEXT_BYTES = 60 * 1024;
const MAX_RPC_CIPHERTEXT_BYTES = MAX_RPC_PLAINTEXT_BYTES + 16;
const MAX_REQUEST_ID = 0x7fff_ffff;
const DEVICE_REVOKED_ERROR = 'mobile device approval was revoked';

export class MobileDeviceRevokedError extends Error {
  constructor() {
    super(DEVICE_REVOKED_ERROR);
    this.name = 'MobileDeviceRevokedError';
  }
}

type RpcEnvelope = { v: 1; id: number; op: string; payload?: Record<string, unknown> };
function bytesFromSocketData(data: unknown): Uint8Array {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  throw new Error('데스크톱에서 잘못된 데이터 형식이 도착했습니다.');
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function waitForSocket(socket: WebSocket, timeout: number): Promise<Event> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('데스크톱 연결 시간이 초과되었습니다.')), timeout);
    const onOpen = (event: Event) => finish(undefined, event);
    const onClose = (event: Event) => finish(new Error(`데스크톱 연결이 닫혔습니다 (${(event as CloseEvent).code}).`));
    const onError = () => finish(new Error('데스크톱 네트워크 연결에 실패했습니다.'));
    function finish(error?: Error, event?: Event) {
      clearTimeout(timer);
      socket.removeEventListener('open', onOpen);
      socket.removeEventListener('close', onClose);
      socket.removeEventListener('error', onError);
      if (error) reject(error);
      else resolve(event!);
    }
    socket.addEventListener('open', onOpen, { once: true });
    socket.addEventListener('close', onClose, { once: true });
    socket.addEventListener('error', onError, { once: true });
    if (socket.readyState === WebSocket.OPEN) finish(undefined, new Event('open'));
    if (socket.readyState === WebSocket.CLOSED) finish(new Error('데스크톱 연결이 닫혔습니다.'));
  });
}

export class MobileDesktopClient {
  private readonly socket: WebSocket;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (reason: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private nextRequestId = 1;
  private closed = false;

  private constructor(socket: WebSocket, private readonly transport: import('@stonygrey/torann').Transport) {
    this.socket = socket;
    this.socket.binaryType = 'arraybuffer';
    this.socket.addEventListener('message', this.onMessage);
    this.socket.addEventListener('close', this.onClose);
    this.socket.addEventListener('error', this.onSocketError);
  }

  static async connect(desktop: PairedDesktop): Promise<MobileDesktopClient> {
    const result = await MobileDesktopClient.establish(
      { host: desktop.host, port: desktop.port, serverKey: desktop.serverKey },
      decodeBase64Url(desktop.devicePrivateKey),
      undefined,
      REQUEST_TIMEOUT_MS,
    );
    return result.client;
  }

  static async pair(code: PairingCode): Promise<{ client: MobileDesktopClient; desktop: PairedDesktop }> {
    const result = await MobileDesktopClient.establish(code, undefined, PAIRING_APPROVAL_TIMEOUT_MS, PAIRING_APPROVAL_TIMEOUT_MS);
    return { client: result.client, desktop: result.pairedDesktop! };
  }

  private static async establish(
    pairing: Pick<PairingCode, 'host' | 'port' | 'serverKey'> & Partial<Pick<PairingCode, 'nonce'>>,
    devicePrivateKey: Uint8Array | undefined,
    approvalWaitMs: number | undefined,
    initialRequestTimeout: number,
  ): Promise<{ client: MobileDesktopClient; pairedDesktop?: PairedDesktop }> {
    let handshake: MobileNoiseHandshake | null = null;
    let transport: import('@stonygrey/torann').Transport | null = null;
    let client: MobileDesktopClient | null = null;
    let socket: WebSocket | null = null;
    try {
      try {
        handshake = MobileNoiseHandshake.create(pairing, devicePrivateKey);
      } finally {
        devicePrivateKey?.fill(0);
      }
      const url = `ws://${pairing.host}:${pairing.port}/mymux/v1`;
      const activeSocket = new WebSocket(url);
      socket = activeSocket;
      activeSocket.binaryType = 'arraybuffer';
      await waitForSocket(activeSocket, HANDSHAKE_TIMEOUT_MS);
      socket.send(toArrayBuffer(handshake.firstMessage()));
      const secondFrame = await MobileDesktopClient.readBinaryMessage(activeSocket, HANDSHAKE_TIMEOUT_MS);
      const second = handshake.secondMessageAndReply(secondFrame);
      activeSocket.send(toArrayBuffer(second));
      transport = handshake.takeTransport();
      client = new MobileDesktopClient(activeSocket, transport);
      transport = null;
      await client.request('session.list', undefined, initialRequestTimeout);
      const pairedDesktop = approvalWaitMs ? handshake.exportApprovedCredentials('Mymux Companion') : undefined;
      handshake.close();
      return { client, pairedDesktop };
    } catch (error) {
      client?.close();
      transport?.close();
      handshake?.close();
      socket?.close();
      throw error instanceof Error ? error : new Error('데스크톱 연결에 실패했습니다.');
    }
  }

  async listSessions(): Promise<PairedSession[]> {
    const result = await this.request('session.list');
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('세션 목록 응답이 올바르지 않습니다.');
    return parsePairedSessions((result as Record<string, unknown>).sessions);
  }

  async readOutput(sessionId: string, offset: number): Promise<PtyOutputBatch> {
    const result = await this.request('terminal.output', { sessionId, offset, maxBytes: 8 * 1024 });
    return parsePtyOutputBatch(result, offset);
  }

  async writeInput(sessionId: string, data: string): Promise<void> {
    const batches: string[] = [];
    let batch = '';
    let byteLength = 0;
    for (const character of data) {
      const point = character.codePointAt(0) ?? 0;
      const size = point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
      if (byteLength > 0 && byteLength + size > 16 * 1024) {
        batches.push(batch);
        batch = '';
        byteLength = 0;
      }
      batch += character;
      byteLength += size;
    }
    if (batch) batches.push(batch);
    for (const part of batches) await this.request('terminal.input', { sessionId, data: part });
  }

  async resize(sessionId: string, cols: number, rows: number): Promise<void> {
    if (!Number.isInteger(cols) || cols < 20 || cols > 500 || !Number.isInteger(rows) || rows < 5 || rows > 200) {
      throw new Error('터미널 크기가 허용 범위를 벗어났습니다.');
    }
    await this.request('terminal.resize', { sessionId, cols, rows });
  }

  async closeSession(sessionId: string): Promise<void> {
    await this.request('session.close', { sessionId });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.socket.removeEventListener('message', this.onMessage);
    this.socket.removeEventListener('close', this.onClose);
    this.socket.removeEventListener('error', this.onSocketError);
    this.socket.close();
    this.transport.close();
    this.failAll(new Error('데스크톱 연결을 종료했습니다.'));
  }

  private request(op: string, payload?: Record<string, unknown>, timeoutMs = REQUEST_TIMEOUT_MS): Promise<unknown> {
    if (this.closed || this.socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('데스크톱에 연결되어 있지 않습니다.'));
    const id = this.nextRequestId;
    this.nextRequestId = this.nextRequestId >= MAX_REQUEST_ID ? 1 : this.nextRequestId + 1;
    if (this.pending.has(id)) return Promise.reject(new Error('요청 번호가 사용 중입니다.'));
    const message: RpcEnvelope = { v: 1, id, op, ...(payload ? { payload } : {}) };
    const encoded = new TextEncoder().encode(JSON.stringify(message));
    if (encoded.byteLength > MAX_RPC_PLAINTEXT_BYTES) return Promise.reject(new Error('요청 크기가 너무 큽니다.'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('데스크톱 요청 시간이 초과되었습니다.'));
        this.close();
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.socket.send(toArrayBuffer(this.transport.writeMessage(encoded)));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        this.close();
        reject(error instanceof Error ? error : new Error('암호화 요청을 보내지 못했습니다.'));
      }
    });
  }

  private readonly onMessage = (event: MessageEvent) => {
    try {
      const cipher = bytesFromSocketData(event.data);
      if (cipher.byteLength < 16 || cipher.byteLength > MAX_RPC_CIPHERTEXT_BYTES) throw new Error('암호문 크기가 올바르지 않습니다.');
      const plaintext = this.transport.readMessage(cipher);
      if (plaintext.byteLength > MAX_RPC_PLAINTEXT_BYTES) throw new Error('응답 크기가 너무 큽니다.');
      const reply: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext));
      if (!reply || typeof reply !== 'object' || Array.isArray(reply)) throw new Error('RPC 응답 형식이 올바르지 않습니다.');
      const record = reply as Record<string, unknown>;
      if (record.v !== 1 || !Number.isSafeInteger(record.id) ||
          (record.error !== undefined && typeof record.error !== 'string') ||
          (record.result !== undefined && record.error !== undefined)) throw new Error('RPC 응답 필드가 올바르지 않습니다.');
      const pending = this.pending.get(record.id as number);
      if (!pending) throw new Error('알 수 없는 RPC 응답입니다.');
      this.pending.delete(record.id as number);
      clearTimeout(pending.timer);
      if (record.error === DEVICE_REVOKED_ERROR) pending.reject(new MobileDeviceRevokedError());
      else if (typeof record.error === 'string') pending.reject(new Error(record.error));
      else pending.resolve(record.result);
    } catch (error) {
      this.close();
      this.failAll(error instanceof Error ? error : new Error('암호화 응답을 처리하지 못했습니다.'));
    }
  };

  private readonly onClose = () => {
    this.closed = true;
    this.transport.close();
    this.failAll(new Error('데스크톱 연결이 끊겼습니다.'));
  };

  private readonly onSocketError = () => {
    this.close();
    this.failAll(new Error('데스크톱 연결에서 네트워크 오류가 발생했습니다.'));
  };

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private static readBinaryMessage(socket: WebSocket, timeout: number): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error('Noise 핸드셰이크 응답 시간이 초과되었습니다.')), timeout);
      const onMessage = (event: MessageEvent) => {
        try {
          resolve(bytesFromSocketData(event.data));
          finish();
        } catch (error) {
          finish(error instanceof Error ? error : new Error('핸드셰이크 프레임을 읽을 수 없습니다.'));
        }
      };
      const onClose = () => finish(new Error('핸드셰이크 도중 연결이 닫혔습니다.'));
      const onError = () => finish(new Error('핸드셰이크 네트워크 오류가 발생했습니다.'));
      function finish(error?: Error) {
        clearTimeout(timer);
        socket.removeEventListener('message', onMessage);
        socket.removeEventListener('close', onClose);
        socket.removeEventListener('error', onError);
        if (error) reject(error);
      }
      socket.addEventListener('message', onMessage, { once: true });
      socket.addEventListener('close', onClose, { once: true });
      socket.addEventListener('error', onError, { once: true });
    });
  }
}
