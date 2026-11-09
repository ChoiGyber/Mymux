import * as SecureStore from 'expo-secure-store';

const LAYOUT_KEY = 'mymux.mobile.layout.v1';
const MAX_TABS = 20;
let writeQueue: Promise<void> = Promise.resolve();

export type MobileTab = { id: string; name: string };
export type MobileLayout = { tabs: MobileTab[]; activeTabId: string };

export function parseMobileLayout(value: unknown): MobileLayout | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.tabs) || record.tabs.length === 0 || record.tabs.length > MAX_TABS) return null;
  const ids = new Set<string>();
  const tabs: MobileTab[] = [];
  for (const item of record.tabs) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    const tab = item as Record<string, unknown>;
    if (typeof tab.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(tab.id) || ids.has(tab.id) ||
        typeof tab.name !== 'string' || tab.name.trim().length === 0 || tab.name.length > 32 ||
        /[\u0000-\u001f\u007f]/.test(tab.name)) return null;
    ids.add(tab.id);
    tabs.push({ id: tab.id, name: tab.name.trim() });
  }
  if (typeof record.activeTabId !== 'string' || !ids.has(record.activeTabId)) return null;
  return { tabs, activeTabId: record.activeTabId };
}

export async function loadMobileLayout(): Promise<MobileLayout | null> {
  const raw = await SecureStore.getItemAsync(LAYOUT_KEY);
  if (!raw || raw.length > 4096) return null;
  try {
    return parseMobileLayout(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function saveMobileLayout(layout: MobileLayout): Promise<void> {
  const safe = parseMobileLayout(layout);
  if (!safe) return Promise.reject(new Error('모바일 탭 배치가 올바르지 않습니다.'));
  const write = writeQueue.then(() => SecureStore.setItemAsync(LAYOUT_KEY, JSON.stringify(safe), {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  }));
  writeQueue = write.then(() => undefined, () => undefined);
  return write;
}
