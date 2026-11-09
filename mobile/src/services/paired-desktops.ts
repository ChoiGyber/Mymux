import * as SecureStore from 'expo-secure-store';

import { isLanHost } from './pairing-code';

const INDEX_KEY = 'mymux.paired.index.v1';
const ACTIVE_KEY = 'mymux.paired.active.v1';
const RECORD_PREFIX = 'mymux.paired.';
const MAX_PAIRED_DESKTOPS = 20;
const KEY_32 = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;

export type PairedDesktop = {
  name: string;
  host: string;
  port: number;
  serverKey: string;
  devicePublicKey: string;
  devicePrivateKey: string;
  pairedAt: number;
};

export type PairedDesktopSummary = Pick<PairedDesktop, 'name' | 'host' | 'port' | 'serverKey' | 'pairedAt'>;

let writeQueue: Promise<void> = Promise.resolve();

function serializeWrite<T>(operation: () => Promise<T>): Promise<T> {
  const result = writeQueue.then(operation, operation);
  writeQueue = result.then(() => undefined, () => undefined);
  return result;
}

function recordKey(serverKey: string): string {
  return `${RECORD_PREFIX}${serverKey}`;
}

function isPairedDesktop(value: unknown): value is PairedDesktop {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.name === 'string' && record.name.trim().length > 0 && record.name.length <= 80 &&
    typeof record.host === 'string' && isLanHost(record.host) &&
    typeof record.port === 'number' && Number.isInteger(record.port) && record.port >= 1024 && record.port <= 65535 &&
    typeof record.serverKey === 'string' && KEY_32.test(record.serverKey) &&
    typeof record.devicePublicKey === 'string' && KEY_32.test(record.devicePublicKey) &&
    typeof record.devicePrivateKey === 'string' && KEY_32.test(record.devicePrivateKey) &&
    typeof record.pairedAt === 'number' && Number.isSafeInteger(record.pairedAt) && record.pairedAt > 0;
}

async function readIndex(): Promise<string[]> {
  const raw = await SecureStore.getItemAsync(INDEX_KEY);
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return [...new Set(value.filter((key): key is string => typeof key === 'string' && KEY_32.test(key)))].slice(0, MAX_PAIRED_DESKTOPS);
  } catch {
    return [];
  }
}

export async function getPairedDesktops(): Promise<PairedDesktop[]> {
  await writeQueue;
  const keys = await readIndex();
  const records = await Promise.all(keys.map(async (key) => {
    const raw = await SecureStore.getItemAsync(recordKey(key));
    if (!raw) return null;
    try {
      const value: unknown = JSON.parse(raw);
      if (!isPairedDesktop(value) || value.serverKey !== key) return null;
      return {
        name: value.name,
        host: value.host,
        port: value.port,
        serverKey: value.serverKey,
        devicePublicKey: value.devicePublicKey,
        devicePrivateKey: value.devicePrivateKey,
        pairedAt: value.pairedAt,
      };
    } catch {
      return null;
    }
  }));
  return records.filter((record): record is PairedDesktop => record !== null);
}

/** Public display data only; the device private key is not returned to screens. */
export async function getPairedDesktopSummaries(): Promise<PairedDesktopSummary[]> {
  await writeQueue;
  const keys = await readIndex();
  const summaries = await Promise.all(keys.map(async (key) => {
    const raw = await SecureStore.getItemAsync(recordKey(key));
    if (!raw) return null;
    try {
      const value: unknown = JSON.parse(raw);
      if (!isPairedDesktop(value) || value.serverKey !== key) return null;
      return { name: value.name, host: value.host, port: value.port, serverKey: value.serverKey, pairedAt: value.pairedAt };
    } catch {
      return null;
    }
  }));
  return summaries.filter((record): record is PairedDesktopSummary => record !== null);
}

/** Return the selected desktop only while its local credential remains paired. */
export async function getActivePairedDesktopKey(): Promise<string | null> {
  await writeQueue;
  const active = await SecureStore.getItemAsync(ACTIVE_KEY);
  if (!active || !KEY_32.test(active)) return null;
  return (await readIndex()).includes(active) ? active : null;
}

export function setActivePairedDesktopKey(serverKey: string): Promise<void> {
  if (!KEY_32.test(serverKey)) return Promise.reject(new Error('데스크톱 키 형식이 올바르지 않습니다.'));
  return serializeWrite(async () => {
    const keys = await readIndex();
    if (!keys.includes(serverKey)) throw new Error('저장된 데스크톱이 아닙니다.');
    await SecureStore.setItemAsync(ACTIVE_KEY, serverKey, {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
  });
}

/** Save only after the desktop has approved the Noise pairing handshake. */
export function savePairedDesktop(record: PairedDesktop): Promise<void> {
  if (!isPairedDesktop(record)) return Promise.reject(new Error('페어링 정보를 저장할 수 없습니다.'));
  const storedRecord: PairedDesktop = {
    name: record.name.trim(),
    host: record.host,
    port: record.port,
    serverKey: record.serverKey,
    devicePublicKey: record.devicePublicKey,
    devicePrivateKey: record.devicePrivateKey,
    pairedAt: record.pairedAt,
  };
  return serializeWrite(async () => {
    const keys = await readIndex();
    const key = record.serverKey;
    const existed = keys.includes(key);
    if (!existed && keys.length >= MAX_PAIRED_DESKTOPS) {
      throw new Error(`등록 가능한 데스크톱은 최대 ${MAX_PAIRED_DESKTOPS}대입니다.`);
    }
    const storageKey = recordKey(key);
    const previous = await SecureStore.getItemAsync(storageKey);
    await SecureStore.setItemAsync(storageKey, JSON.stringify(storedRecord), {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
    try {
      if (!existed) await SecureStore.setItemAsync(INDEX_KEY, JSON.stringify([...keys, key]));
    } catch (error) {
      if (previous === null) await SecureStore.deleteItemAsync(storageKey);
      else await SecureStore.setItemAsync(storageKey, previous, {
        keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
      });
      throw error;
    }
  });
}

/** Removes this app's local credential; the desktop must revoke it separately. */
export function forgetPairedDesktop(serverKey: string): Promise<void> {
  if (!KEY_32.test(serverKey)) return Promise.reject(new Error('데스크톱 키 형식이 올바르지 않습니다.'));
  return serializeWrite(async () => {
    const keys = await readIndex();
    if (!keys.includes(serverKey)) return;
    const remaining = keys.filter((key) => key !== serverKey);
    await SecureStore.deleteItemAsync(recordKey(serverKey));
    if (remaining.length === 0) await SecureStore.deleteItemAsync(INDEX_KEY);
    else await SecureStore.setItemAsync(INDEX_KEY, JSON.stringify(remaining));
    if (await SecureStore.getItemAsync(ACTIVE_KEY) === serverKey) {
      if (remaining.length > 0) await SecureStore.setItemAsync(ACTIVE_KEY, remaining[0]);
      else await SecureStore.deleteItemAsync(ACTIVE_KEY);
    }
  });
}
