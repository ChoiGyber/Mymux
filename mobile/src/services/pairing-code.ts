export type PairingCode = {
  v: 1;
  kind: 'mymux-pair';
  host: string;
  port: number;
  serverKey: string;
  nonce: string;
  expiresAt: number;
};

/** Mobile list shape returned by the authenticated gateway, with no filesystem paths. */
export type PairedSession = {
  id: string;
  label: string;
  exited: boolean;
  agents: PairedAgent[];
};

export type PairedAgent = {
  id: string;
  name: string;
  description: string;
  status: 'running' | 'done' | 'failed' | 'cancelled' | 'ended';
};

export type PtyOutputBatch = {
  chunks: string[];
  next: number;
  exited: boolean;
  truncated: boolean;
};

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (const char of value) {
    const codePoint = char.codePointAt(0) ?? 0;
    bytes += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
  }
  return bytes;
}

export function parsePtyOutputBatch(value: unknown, requestedOffset: number): PtyOutputBatch {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      !Number.isSafeInteger(requestedOffset) || requestedOffset < 0) throw new Error('터미널 출력 응답 형식이 올바르지 않습니다.');
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.chunks) || record.chunks.length > 1024 ||
      !Number.isSafeInteger(record.next) || (record.next as number) < 0 || typeof record.exited !== 'boolean' ||
      typeof record.truncated !== 'boolean' ||
      (record.next as number) < requestedOffset && record.truncated !== true) {
    throw new Error('터미널 출력 응답이 유효하지 않습니다.');
  }
  let size = 0;
  const chunks = record.chunks.map((chunk) => {
    if (typeof chunk !== 'string') throw new Error('터미널 출력에 문자열이 아닌 데이터가 있습니다.');
    size += utf8ByteLength(chunk);
    if (size > 64 * 1024) throw new Error('터미널 출력 배치가 허용 크기를 초과했습니다.');
    return chunk;
  });
  return { chunks, next: record.next as number, exited: record.exited, truncated: record.truncated };
}

export function parsePairedSessions(value: unknown): PairedSession[] {
  if (!Array.isArray(value) || value.length > 256) throw new Error('세션 목록 응답 형식이 올바르지 않습니다.');
  const ids = new Set<string>();
  return value.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('세션 정보 형식이 올바르지 않습니다.');
    const session = entry as Record<string, unknown>;
    if (typeof session.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(session.id) || ids.has(session.id) ||
        typeof session.label !== 'string' || session.label.trim().length === 0 || Array.from(session.label).length > 64 ||
        /[\u0000-\u001f\u007f]/.test(session.label) ||
        typeof session.exited !== 'boolean' || !Array.isArray(session.agents) || session.agents.length > 60) {
      throw new Error('세션 정보가 유효하지 않습니다.');
    }
    ids.add(session.id);
    const agentIds = new Set<string>();
    const agents = session.agents.map((entry): PairedAgent => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('에이전트 정보 형식이 올바르지 않습니다.');
      const agent = entry as Record<string, unknown>;
      if (typeof agent.id !== 'string' || !/^[a-zA-Z0-9_-]{1,96}$/.test(agent.id) || agentIds.has(agent.id) ||
          typeof agent.name !== 'string' || agent.name.trim().length === 0 || Array.from(agent.name).length > 80 ||
          typeof agent.description !== 'string' || Array.from(agent.description).length > 256 ||
          /[\u0000-\u001f\u007f]/.test(agent.name + agent.description) ||
          !['running', 'done', 'failed', 'cancelled', 'ended'].includes(String(agent.status))) {
        throw new Error('에이전트 정보가 유효하지 않습니다.');
      }
      agentIds.add(agent.id);
      return {
        id: agent.id,
        name: agent.name,
        description: agent.description,
        status: agent.status as PairedAgent['status'],
      };
    });
    return { id: session.id, label: session.label, exited: session.exited, agents };
  });
}

const BASE64URL_32_BYTES = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;

export function isLanHost(host: string): boolean {
  if (/\.local$/i.test(host) && host.length <= 253) {
    const labels = host.slice(0, -6).split('.');
    return labels.length > 0 && labels.every((label) =>
      label.length > 0 && label.length <= 63 &&
      /^[a-z\d](?:[a-z\d-]*[a-z\d])?$/i.test(label),
    );
  }
  const octets = host.split('.');
  if (octets.length !== 4 || octets.some((part) => !/^(?:0|[1-9]\d{0,2})$/.test(part))) return false;
  const [a, b, c, d] = octets.map(Number);
  if ([a, b, c, d].some((part) => part < 0 || part > 255)) return false;
  if (a === 0 || a === 127 || a === 169 && b === 254 || a >= 224) return false;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

export function parsePairingCode(raw: string, now = Date.now()): PairingCode {
  if (raw.length > 2048) throw new Error('연결 코드가 너무 큽니다.');
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('Mymux 연결 QR 코드가 아닙니다.');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('연결 코드 형식이 올바르지 않습니다.');
  }
  const code = value as Record<string, unknown>;
  if (code.v !== 1 || code.kind !== 'mymux-pair') throw new Error('지원하지 않는 연결 코드입니다.');
  if (typeof code.host !== 'string' || !isLanHost(code.host)) throw new Error('LAN 주소가 올바르지 않습니다.');
  if (typeof code.port !== 'number' || !Number.isInteger(code.port) || code.port < 1024 || code.port > 65535) {
    throw new Error('포트 번호가 올바르지 않습니다.');
  }
  if (typeof code.serverKey !== 'string' || !BASE64URL_32_BYTES.test(code.serverKey)) {
    throw new Error('데스크톱 공개키 형식이 올바르지 않습니다.');
  }
  if (typeof code.nonce !== 'string' || !BASE64URL_32_BYTES.test(code.nonce)) {
    throw new Error('일회용 연결 코드가 올바르지 않습니다.');
  }
  if (typeof code.expiresAt !== 'number' || !Number.isSafeInteger(code.expiresAt)) {
    throw new Error('만료 시각이 올바르지 않습니다.');
  }
  if (code.expiresAt <= now || code.expiresAt > now + 10 * 60 * 1000) {
    throw new Error('연결 코드가 만료되었거나 유효 시간이 너무 깁니다.');
  }
  return code as PairingCode;
}
