import { NoiseProtocol, type HandshakeState, type KeyPair, type Transport } from '@stonygrey/torann';
import type { PairedDesktop } from './paired-desktops';

const PROTOCOL_NAME = 'Noise_XX_25519_ChaChaPoly_SHA256';
const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

export function decodeBase64Url(value: string): Uint8Array {
  const output = new Uint8Array(Math.floor(value.length * 3 / 4));
  let bits = 0;
  let accumulator = 0;
  let index = 0;
  for (const char of value) {
    const digit = BASE64URL.indexOf(char);
    if (digit < 0) throw new Error('잘못된 키 인코딩입니다.');
    accumulator = (accumulator << 6) | digit;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      output[index++] = (accumulator >> bits) & 0xff;
    }
  }
  if (bits > 0 && (accumulator & ((1 << bits) - 1)) !== 0) throw new Error('잘못된 키 인코딩입니다.');
  if (index !== output.length) return output.slice(0, index);
  return output;
}

export function encodeBase64Url(bytes: Uint8Array): string {
  let output = '';
  for (let offset = 0; offset < bytes.length; offset += 3) {
    const a = bytes[offset];
    const hasB = offset + 1 < bytes.length;
    const hasC = offset + 2 < bytes.length;
    const b = hasB ? bytes[offset + 1] : 0;
    const c = hasC ? bytes[offset + 2] : 0;
    output += BASE64URL[a >> 2];
    output += BASE64URL[((a & 3) << 4) | (b >> 4)];
    if (hasB) output += BASE64URL[((b & 15) << 2) | (c >> 6)];
    if (hasC) output += BASE64URL[c & 63];
  }
  return output;
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) difference |= a[index] ^ b[index];
  return difference === 0;
}

/**
 * Owns the mobile side of Noise XX. Call `verifyServerKey` only after message 2;
 * no application data may be sent before `finish` has returned the transport.
 */
export class MobileNoiseHandshake {
  private readonly protocol: NoiseProtocol;
  private readonly deviceKey: KeyPair;
  private readonly handshake: HandshakeState;
  private transport: Transport | null = null;
  private completed = false;
  private closed = false;
  private replySent = false;

  private constructor(private readonly pairing: { serverKey: string; nonce?: string; host?: string; port?: number }, privateKey?: Uint8Array) {
    this.protocol = NoiseProtocol.parse(PROTOCOL_NAME);
    if (privateKey && privateKey.length !== 32) throw new Error('기기 개인 키 길이가 올바르지 않습니다.');
    this.deviceKey = privateKey ? this.protocol.createKeyPair(privateKey) : this.protocol.generateKeyPair();
    this.handshake = this.protocol.createHandshake({ initiator: true, localStatic: this.deviceKey });
  }

  static create(pairing: { serverKey: string; nonce?: string; host?: string; port?: number }, devicePrivateKey?: Uint8Array): MobileNoiseHandshake {
    return new MobileNoiseHandshake(pairing, devicePrivateKey);
  }

  get devicePublicKey(): Uint8Array {
    this.ensureOpen();
    return this.deviceKey.publicKey;
  }

  firstMessage(): Uint8Array {
    this.ensureOpen();
    const payload = this.pairing.nonce ? new TextEncoder().encode(JSON.stringify({ nonce: this.pairing.nonce })) : new Uint8Array();
    return this.handshake.writeMessage(payload).message;
  }

  /** Read the desktop's first response, pin its static key to the scanned QR, and return the final client message. */
  secondMessageAndReply(serverMessage: Uint8Array): Uint8Array {
    this.ensureOpen();
    if (this.completed || this.replySent) throw new Error('핸드셰이크 단계가 올바르지 않습니다.');
    this.handshake.readMessage(serverMessage);
    const remote = this.handshake.remoteStaticPublicKey();
    if (!remote || !equalBytes(remote, decodeBase64Url(this.pairing.serverKey))) {
      this.close();
      throw new Error('데스크톱 키가 QR 코드와 다릅니다. 연결을 종료했습니다.');
    }
    const result = this.handshake.writeMessage();
    if (!result.transport) {
      this.close();
      throw new Error('Noise 핸드셰이크가 예상 단계에서 완료되지 않았습니다.');
    }
    this.transport = result.transport;
    this.completed = true;
    this.replySent = true;
    this.handshake.close();
    return result.message;
  }

  takeTransport(): Transport {
    this.ensureOpen();
    if (!this.completed || !this.transport) throw new Error('Noise transport를 아직 사용할 수 없습니다.');
    const transport = this.transport;
    this.transport = null;
    return transport;
  }

  exportApprovedCredentials(name: string): PairedDesktop {
    this.ensureOpen();
    if (!this.completed || !this.pairing.host || !this.pairing.port) {
      throw new Error('데스크톱 승인 뒤에만 기기 자격 증명을 저장할 수 있습니다.');
    }
    const privateKey = this.deviceKey.privateKey();
    try {
      return {
        name: name.trim(),
        host: this.pairing.host,
        port: this.pairing.port,
        serverKey: this.pairing.serverKey,
        devicePublicKey: encodeBase64Url(this.deviceKey.publicKey),
        devicePrivateKey: encodeBase64Url(privateKey),
        pairedAt: Date.now(),
      };
    } finally {
      privateKey.fill(0);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.transport?.close();
    this.handshake.close();
    this.deviceKey.close();
  }

  private ensureOpen(): void {
    if (this.closed) throw new Error('Noise 핸드셰이크가 닫혔습니다.');
  }
}
