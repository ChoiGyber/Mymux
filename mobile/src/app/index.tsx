import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  AppState,
  PanResponder,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type GestureResponderEvent,
  type ViewInstance,
} from 'react-native';
import { useIsFocused } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { TerminalView } from '@/components/terminal-view';
import { TerminalKeypad } from '@/components/terminal-keypad';
import { loadMobileLayout, saveMobileLayout, type MobileTab } from '@/services/mobile-layout';
import { MobileDesktopClient, MobileDeviceRevokedError } from '@/services/mobile-client';
import {
  forgetPairedDesktop,
  getActivePairedDesktopKey,
  getPairedDesktopSummaries,
  getPairedDesktops,
  setActivePairedDesktopKey,
  type PairedDesktopSummary,
} from '@/services/paired-desktops';
import type { PairedAgent } from '@/services/pairing-code';
import { pollSelectedSessionOutput } from '@/services/session-output.mjs';

type Session = {
  id: string;
  tabId: string;
  name: string;
  exited: boolean;
  agents: PairedAgent[];
};

type TabBounds = { x: number; y: number; width: number; height: number };
type DragTarget = { itemId: string; targetTabId: string };

const INITIAL_TABS: MobileTab[] = [
  { id: 'tab-main', name: '작업' },
  { id: 'tab-review', name: '검토' },
];
const COLORS = {
  background: '#101218', panel: '#191d26', raised: '#202632', line: '#2b3340',
  text: '#edf1f7', muted: '#929baa', accent: '#69a8ff', green: '#66d19e', yellow: '#f4be63',
};

function isForegrounded(): boolean {
  return AppState.currentState !== 'background' && AppState.currentState !== 'inactive';
}

export default function SessionsScreen() {
  const isFocused = useIsFocused();
  const [appActive, setAppActive] = useState(isForegrounded);
  const [tabs, setTabs] = useState(INITIAL_TABS);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeTabId, setActiveTabId] = useState(INITIAL_TABS[0].id);
  const [layoutReady, setLayoutReady] = useState(false);
  const [layoutError, setLayoutError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [draggingSessionId, setDraggingSessionId] = useState<string | null>(null);
  const [draggingTabId, setDraggingTabId] = useState<string | null>(null);
  const [dropTabId, setDropTabId] = useState<string | null>(null);
  const [focusedSessionId, setFocusedSessionId] = useState<string | null>(null);
  const [pairedDesktops, setPairedDesktops] = useState<PairedDesktopSummary[]>([]);
  const [activeDesktopKey, setActiveDesktopKey] = useState<string | null>(null);
  const [desktopSelectionReady, setDesktopSelectionReady] = useState(false);
  const [showDesktopPicker, setShowDesktopPicker] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState('연결 안 됨');
  const [terminalOutput, setTerminalOutput] = useState('');
  const [terminalInput, setTerminalInput] = useState('');
  const [tabBounds, setTabBounds] = useState<Record<string, TabBounds>>({});

  const tabsRef = useRef(tabs);
  const clientRef = useRef<MobileDesktopClient | null>(null);
  const focusedSessionRef = useRef<string | null>(null);
  const outputOffsetsRef = useRef<Record<string, number>>({});
  const outputsRef = useRef<Record<string, string>>({});
  const closingSessionIdsRef = useRef(new Set<string>());
  const revokedDesktopKeysRef = useRef(new Set<string>());
  const resizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sessionDragRef = useRef<DragTarget>({ itemId: '', targetTabId: '' });
  const tabDragRef = useRef<DragTarget>({ itemId: '', targetTabId: '' });

  const visibleSessions = useMemo(
    () => sessions.filter((session) => session.tabId === activeTabId),
    [activeTabId, sessions],
  );

  useEffect(() => { tabsRef.current = tabs; }, [tabs]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => setAppActive(state === 'active'));
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    if (!isFocused) return;
    let mounted = true;
    void Promise.all([getPairedDesktopSummaries(), getActivePairedDesktopKey()]).then(([desktops, savedKey]) => {
      if (!mounted) return;
      setPairedDesktops(desktops);
      const selected = savedKey && desktops.some((desktop) => desktop.serverKey === savedKey)
        ? savedKey
        : desktops[0]?.serverKey ?? null;
      setActiveDesktopKey(selected);
      setDesktopSelectionReady(true);
      if (selected && selected !== savedKey) {
        void setActivePairedDesktopKey(selected).catch(() => {
          if (mounted) setLayoutError('선택한 데스크톱을 저장하지 못했습니다.');
        });
      }
    }).catch(() => {
      if (!mounted) return;
      setPairedDesktops([]);
      setActiveDesktopKey(null);
      setDesktopSelectionReady(true);
      setLayoutError('저장된 데스크톱 목록을 읽지 못했습니다.');
    });
    return () => { mounted = false; };
  }, [isFocused]);

  useEffect(() => {
    if (!isFocused || !desktopSelectionReady || !appActive) return;
    let mounted = true;
    let client: MobileDesktopClient | null = null;
    let connectedServerKey: string | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let retryDelay = 1_000;

    const clearRevokedDesktop = async () => {
      const serverKey = connectedServerKey;
      if (!serverKey) return;
      revokedDesktopKeysRef.current.add(serverKey);
      if (clientRef.current === client) clientRef.current = null;
      client?.close();
      client = null;
      try {
        await forgetPairedDesktop(serverKey);
        const [desktops, activeKey] = await Promise.all([
          getPairedDesktopSummaries(), getActivePairedDesktopKey(),
        ]);
        if (!mounted) return;
        setPairedDesktops(desktops);
        setActiveDesktopKey(activeKey);
        setConnectionStatus('승인이 취소되었습니다. QR 코드로 다시 연결해 주세요.');
      } catch {
        if (mounted) setConnectionStatus('기기 자격 증명을 삭제하지 못했습니다.');
      }
    };

    const poll = async () => {
      if (!mounted || !client || !isForegrounded()) return;
      try {
        const remote = await client.listSessions();
        if (!mounted) return;
        setSessions((current) => {
          const tabBySession = new Map(current.map((session) => [session.id, session.tabId]));
          return remote.map((session) => ({
            id: session.id,
            tabId: tabBySession.get(session.id) ?? tabsRef.current[0]?.id ?? INITIAL_TABS[0].id,
            name: session.label,
            exited: session.exited,
            agents: session.agents,
          }));
        });

        const selectedId = focusedSessionRef.current;
        if (selectedId && !remote.some((session) => session.id === selectedId)) {
          if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
          focusedSessionRef.current = null;
          setFocusedSessionId((current) => current === selectedId ? null : current);
          setTerminalOutput('');
          setTerminalInput('');
        } else if (selectedId && !closingSessionIdsRef.current.has(selectedId)) {
          const output = await pollSelectedSessionOutput({
            client,
            getSelectedSessionId: () => focusedSessionRef.current,
            offsets: outputOffsetsRef.current,
            outputs: outputsRef.current,
          });
          if (!mounted) return;
          if (output && focusedSessionRef.current === output.sessionId &&
              !closingSessionIdsRef.current.has(output.sessionId)) {
            setTerminalOutput(output.output);
          }
        }
      } catch (error) {
        if (!mounted) {
          client?.close();
          return;
        }
        if (!isForegrounded()) return;
        if (error instanceof MobileDeviceRevokedError) {
          await clearRevokedDesktop();
          return;
        }
        setConnectionStatus(error instanceof Error ? error.message : '데스크톱 연결이 끊겼습니다.');
        client?.close();
        client = null;
        clientRef.current = null;
        timer = setTimeout(() => { void connect(); }, retryDelay);
        retryDelay = Math.min(15_000, retryDelay * 2);
        return;
      }
      timer = setTimeout(() => { if (isForegrounded()) void poll(); }, 900);
    };

    async function connect() {
      if (!mounted || !isForegrounded()) return;
      try {
        const desktops = await getPairedDesktops();
        if (!mounted) return;
        if (desktops.length === 0) {
          setConnectionStatus('QR 코드로 데스크톱을 먼저 페어링해 주세요.');
          return;
        }
        const desktop = desktops.find((item) => item.serverKey === activeDesktopKey &&
          !revokedDesktopKeysRef.current.has(item.serverKey)) ??
          desktops.find((item) => !revokedDesktopKeysRef.current.has(item.serverKey));
        if (!desktop) {
          setConnectionStatus('이 기기에서 다시 페어링해 주세요.');
          return;
        }
        connectedServerKey = desktop.serverKey;
        setConnectionStatus(`${desktop.name} 연결 중`);
        client = await MobileDesktopClient.connect(desktop);
        if (!mounted || !isForegrounded()) { client.close(); return; }
        clientRef.current = client;
        retryDelay = 1_000;
        setConnectionStatus(`${desktop.name} 연결됨`);
        await poll();
      } catch (error) {
        if (error instanceof MobileDeviceRevokedError) {
          await clearRevokedDesktop();
          return;
        }
        if (mounted) setConnectionStatus(error instanceof Error ? error.message : '데스크톱 연결에 실패했습니다.');
        if (mounted) {
          timer = setTimeout(() => { void connect(); }, retryDelay);
          retryDelay = Math.min(15_000, retryDelay * 2);
        }
      }
    }

    void connect();
    return () => {
      mounted = false;
      if (timer) clearTimeout(timer);
      if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
      client?.close();
      clientRef.current = null;
    };
  }, [activeDesktopKey, appActive, desktopSelectionReady, isFocused]);

  useEffect(() => {
    let mounted = true;
    void loadMobileLayout().then((layout) => {
      if (!mounted) return;
      if (layout) {
        setTabs(layout.tabs);
        setActiveTabId(layout.activeTabId);
      }
    }).catch(() => {
      if (mounted) setLayoutError('탭 배치를 불러오지 못했습니다.');
    }).finally(() => {
      if (mounted) setLayoutReady(true);
    });
    return () => { mounted = false; };
  }, []);

  useEffect(() => {
    if (!layoutReady) return;
    void saveMobileLayout({ tabs, activeTabId }).then(() => setLayoutError(null)).catch(() => {
      setLayoutError('탭 배치를 기기에 저장하지 못했습니다.');
    });
  }, [activeTabId, layoutReady, tabs]);

  const sendTerminalInput = useCallback((sessionId: string | null, appendEnter: boolean) => {
    const client = clientRef.current;
    if (!sessionId || !client || terminalInput.length === 0) return;
    const input = terminalInput;
    setTerminalInput('');
    void client.writeInput(sessionId, appendEnter ? `${input}\r` : input).catch((error: unknown) => {
      setConnectionStatus(error instanceof Error ? error.message : '터미널 입력을 보내지 못했습니다.');
    });
  }, [terminalInput]);

  const sendTerminalKey = useCallback((sessionId: string, data: string) => {
    const client = clientRef.current;
    if (!client) return;
    void client.writeInput(sessionId, data).catch((error: unknown) => {
      setConnectionStatus(error instanceof Error ? error.message : '터미널 키를 보내지 못했습니다.');
    });
  }, []);

  const resizeTerminal = useCallback((sessionId: string, cols: number, rows: number) => {
    if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
    resizeTimerRef.current = setTimeout(() => {
      const client = clientRef.current;
      if (!client) return;
      void client.resize(sessionId, cols, rows).catch((error: unknown) => {
        setConnectionStatus(error instanceof Error ? error.message : '터미널 크기를 반영하지 못했습니다.');
      });
    }, 150);
  }, []);

  const selectDesktop = useCallback((desktop: PairedDesktopSummary) => {
    if (desktop.serverKey === activeDesktopKey) {
      setShowDesktopPicker(false);
      return;
    }
    if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
    focusedSessionRef.current = null;
    setFocusedSessionId(null);
    setTerminalOutput('');
    setTerminalInput('');
    setSessions([]);
    setActiveDesktopKey(desktop.serverKey);
    setShowDesktopPicker(false);
    setConnectionStatus(`${desktop.name} 연결 중`);
    void setActivePairedDesktopKey(desktop.serverKey).catch(() => {
      setLayoutError('선택한 데스크톱을 저장하지 못했습니다.');
    });
  }, [activeDesktopKey]);

  const tabRefs = useRef<Record<string, ViewInstance | null>>({});
  const measureTab = useCallback((tabId: string) => {
    tabRefs.current[tabId]?.measureInWindow((x, y, width, height) => {
      setTabBounds((current) => ({ ...current, [tabId]: { x, y, width, height } }));
    });
  }, []);

  const startSessionDrag = useCallback((sessionId: string) => {
    sessionDragRef.current = { itemId: sessionId, targetTabId: '' };
    setDraggingSessionId(sessionId);
  }, []);
  const updateDropTarget = useCallback((event: GestureResponderEvent, drag: React.MutableRefObject<DragTarget>) => {
    const { pageX, pageY } = event.nativeEvent;
    const target = Object.entries(tabBounds).find(([, bounds]) =>
      pageX >= bounds.x && pageX <= bounds.x + bounds.width &&
      pageY >= bounds.y && pageY <= bounds.y + bounds.height,
    )?.[0] ?? '';
    drag.current.targetTabId = target;
    setDropTabId(target || null);
  }, [tabBounds]);
  const updateSessionDropTarget = useCallback((event: GestureResponderEvent) => {
    updateDropTarget(event, sessionDragRef);
  }, [updateDropTarget]);
  const finishSessionDrag = useCallback(() => {
    const { itemId: sessionId, targetTabId } = sessionDragRef.current;
    const sourceTabId = sessions.find((session) => session.id === sessionId)?.tabId;
    if (sourceTabId && targetTabId && sourceTabId !== targetTabId) {
      setSessions((current) => current.map((session) => session.id === sessionId
        ? { ...session, tabId: targetTabId }
        : session));
      setActiveTabId(targetTabId);
    }
    sessionDragRef.current = { itemId: '', targetTabId: '' };
    setDraggingSessionId(null);
    setDropTabId(null);
  }, [sessions]);
  const cancelSessionDrag = useCallback(() => {
    sessionDragRef.current = { itemId: '', targetTabId: '' };
    setDraggingSessionId(null);
    setDropTabId(null);
  }, []);

  const toggleAgents = useCallback((sessionId: string) => {
    setCollapsed((current) => ({ ...current, [sessionId]: !current[sessionId] }));
  }, []);

  const startTabDrag = useCallback((tabId: string) => {
    tabDragRef.current = { itemId: tabId, targetTabId: tabId };
    setDraggingTabId(tabId);
  }, []);
  const updateTabDropTarget = useCallback((event: GestureResponderEvent) => {
    updateDropTarget(event, tabDragRef);
  }, [updateDropTarget]);
  const finishTabDrag = useCallback(() => {
    const { itemId, targetTabId } = tabDragRef.current;
    if (itemId && targetTabId && itemId !== targetTabId) {
      setTabs((current) => {
        const next = [...current];
        const from = next.findIndex((tab) => tab.id === itemId);
        const to = next.findIndex((tab) => tab.id === targetTabId);
        if (from < 0 || to < 0) return current;
        const [moved] = next.splice(from, 1);
        next.splice(to, 0, moved);
        return next;
      });
    }
    tabDragRef.current = { itemId: '', targetTabId: '' };
    setDraggingTabId(null);
    setDropTabId(null);
  }, []);
  const cancelTabDrag = useCallback(() => {
    tabDragRef.current = { itemId: '', targetTabId: '' };
    setDraggingTabId(null);
    setDropTabId(null);
  }, []);

  const closeSession = useCallback((sessionId: string) => {
    const session = sessions.find((item) => item.id === sessionId);
    if (!session) return;
    Alert.alert(
      '세션 종료',
      `${session.name}의 PTY 세션을 종료할까요? 실행 중인 작업이 중단됩니다.`,
      [
        { text: '취소', style: 'cancel' },
        {
          text: '세션 종료',
          style: 'destructive',
          onPress: () => {
            if (closingSessionIdsRef.current.has(sessionId)) return;
            closingSessionIdsRef.current.add(sessionId);
            const client = clientRef.current;
            if (!client) {
              closingSessionIdsRef.current.delete(sessionId);
              setConnectionStatus('데스크톱에 연결되어 있지 않습니다.');
              return;
            }
            void client.closeSession(sessionId).then(() => {
              if (focusedSessionRef.current === sessionId) {
                if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
                focusedSessionRef.current = null;
                setFocusedSessionId(null);
                setTerminalOutput('');
                setTerminalInput('');
              }
              setSessions((current) => current.filter((item) => item.id !== sessionId));
              delete outputOffsetsRef.current[sessionId];
              delete outputsRef.current[sessionId];
              closingSessionIdsRef.current.delete(sessionId);
            }).catch((error: unknown) => {
              closingSessionIdsRef.current.delete(sessionId);
              setConnectionStatus(error instanceof Error ? error.message : '세션을 종료하지 못했습니다.');
            });
          },
        },
      ],
    );
  }, [sessions]);

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.header}>
        <View>
          <Text style={styles.eyebrow}>MYMUX COMPANION</Text>
          <Text style={styles.title}>세션</Text>
        </View>
        <View style={styles.connectionPill}>
          <View style={[styles.offlineDot, connectionStatus.endsWith('연결됨') && styles.onlineDot]} />
          <Text numberOfLines={1} style={styles.connectionText}>{connectionStatus}</Text>
        </View>
      </View>
      {sessions.length === 0 && <View style={styles.previewNotice}>
        <Text style={styles.previewTitle}>데스크톱 연결이 필요합니다</Text>
        <Text style={styles.previewCopy}>연결 탭에서 Mymux 페어링 QR을 스캔하면 기존 실행 세션이 여기에 표시됩니다.</Text>
      </View>}
      {layoutError && <Text accessibilityRole="alert" style={styles.layoutError}>{layoutError}</Text>}
      {pairedDesktops.length > 1 && <View style={styles.desktopPicker}>
        <Pressable accessibilityRole="button" accessibilityState={{ expanded: showDesktopPicker }}
          onPress={() => setShowDesktopPicker((current) => !current)} style={styles.desktopPickerButton}>
          <Text style={styles.desktopPickerLabel}>연결된 데스크톱</Text>
          <Text numberOfLines={1} style={styles.desktopPickerValue}>
            {pairedDesktops.find((desktop) => desktop.serverKey === activeDesktopKey)?.name ?? '선택'} {showDesktopPicker ? '▴' : '▾'}
          </Text>
        </Pressable>
        {showDesktopPicker && <View style={styles.desktopPickerOptions}>
          {pairedDesktops.map((desktop) => (
            <Pressable key={desktop.serverKey} accessibilityRole="button"
              accessibilityState={{ selected: desktop.serverKey === activeDesktopKey }}
              onPress={() => selectDesktop(desktop)} style={styles.desktopPickerOption}>
              <View style={styles.desktopPickerInfo}>
                <Text numberOfLines={1} style={styles.desktopPickerName}>{desktop.name}</Text>
                <Text numberOfLines={1} style={styles.desktopPickerAddress}>{desktop.host}:{desktop.port}</Text>
              </View>
              {desktop.serverKey === activeDesktopKey && <Text style={styles.desktopPickerCheck}>✓</Text>}
            </Pressable>
          ))}
        </View>}
      </View>}
      <View style={styles.sectionHeading}>
        <Text style={styles.sectionTitle}>탭</Text>
        <Text style={styles.hint}>탭을 끌어 순서를 변경 · 세션 손잡이로 탭 이동</Text>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.tabs}>
        {tabs.map((tab) => (
          <DraggableTab key={tab.id} tab={tab} active={activeTabId === tab.id}
            dragging={draggingTabId === tab.id} dropTarget={dropTabId === tab.id}
            count={sessions.filter((session) => session.tabId === tab.id).length}
            onPress={() => setActiveTabId(tab.id)} onLayout={() => requestAnimationFrame(() => measureTab(tab.id))}
            onDragStart={() => startTabDrag(tab.id)} onDragMove={updateTabDropTarget}
            onDragEnd={finishTabDrag} onDragCancel={cancelTabDrag}
            setRef={(node) => { tabRefs.current[tab.id] = node; }} />
        ))}
      </ScrollView>
      <View style={styles.sectionHeading}>
        <Text style={styles.sectionTitle}>{tabs.find((tab) => tab.id === activeTabId)?.name ?? '세션'}</Text>
        <Text style={styles.hint}>{visibleSessions.length}개 세션</Text>
      </View>
      <ScrollView style={styles.sessionList} contentContainerStyle={styles.sessionListContent}>
        {visibleSessions.map((session) => (
          <SessionCard key={session.id} session={session} selected={focusedSessionId === session.id}
            collapsed={collapsed[session.id] ?? true} dragging={draggingSessionId === session.id}
            onToggleAgents={() => toggleAgents(session.id)}
            onFocus={() => {
              if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
              focusedSessionRef.current = session.id;
              setFocusedSessionId(session.id);
              setTerminalOutput(outputsRef.current[session.id] ?? '');
            }} onDragStart={() => startSessionDrag(session.id)} onDragMove={updateSessionDropTarget}
            onDragEnd={finishSessionDrag} onDragCancel={cancelSessionDrag} />
        ))}
      </ScrollView>
      <View style={styles.bottomPanel}>
        {focusedSessionId ? <>
          <View style={styles.terminalHeading}>
            <View style={styles.terminalHeadingInfo}>
              <Text style={styles.terminalLabel}>선택한 세션</Text>
              <Text numberOfLines={1} style={styles.terminalTitle}>
                {sessions.find((session) => session.id === focusedSessionId)?.name}
              </Text>
            </View>
            <Pressable accessibilityRole="button" accessibilityLabel="선택한 PTY 세션 종료"
              onPress={() => closeSession(focusedSessionId)} style={styles.closeSessionButton}>
              <Text style={styles.closeSessionText}>종료</Text>
            </Pressable>
          </View>
          <Text style={styles.terminalHint}>
            {sessions.find((session) => session.id === focusedSessionId)?.exited ? '종료된 세션' : '실행 중인 세션'}
          </Text>
          <TerminalView key={focusedSessionId} value={terminalOutput} style={styles.terminalViewport}
            foregrounded={isFocused && appActive}
            onInput={(data) => sendTerminalKey(focusedSessionId, data)}
            onResize={(cols, rows) => resizeTerminal(focusedSessionId, cols, rows)} />
          <TerminalKeypad onPressKey={(data) => sendTerminalKey(focusedSessionId, data)} />
          <View style={styles.inputRow}>
            <TextInput accessibilityLabel="터미널 입력" value={terminalInput} onChangeText={setTerminalInput}
              multiline submitBehavior="newline" blurOnSubmit={false}
              placeholder="명령 또는 터미널 입력" placeholderTextColor={COLORS.muted} style={styles.input} />
            <View style={styles.inputActions}>
              <Pressable accessibilityRole="button" onPress={() => sendTerminalInput(focusedSessionId, false)} style={styles.sendButton}>
                <Text style={styles.sendText}>입력</Text>
              </Pressable>
              <Pressable accessibilityRole="button" onPress={() => sendTerminalInput(focusedSessionId, true)} style={styles.sendButton}>
                <Text style={styles.sendText}>실행 ↵</Text>
              </Pressable>
            </View>
          </View>
        </> : <Text style={styles.terminalHint}>연결된 데스크톱 세션이 없습니다.</Text>}
      </View>
    </SafeAreaView>
  );
}

function DraggableTab({
  tab, active, dragging, dropTarget, count, onPress, onLayout, onDragStart, onDragMove, onDragEnd, onDragCancel, setRef,
}: {
  tab: MobileTab; active: boolean; dragging: boolean; dropTarget: boolean; count: number;
  onPress: () => void; onLayout: () => void; onDragStart: () => void;
  onDragMove: (event: GestureResponderEvent) => void; onDragEnd: () => void; onDragCancel: () => void;
  setRef: (node: ViewInstance | null) => void;
}) {
  const pan = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => false,
    onMoveShouldSetPanResponder: (_, gesture) => Math.abs(gesture.dx) > 8 || Math.abs(gesture.dy) > 8,
    onPanResponderGrant: onDragStart,
    onPanResponderMove: onDragMove,
    onPanResponderRelease: onDragEnd,
    onPanResponderTerminate: onDragCancel,
  }), [onDragCancel, onDragEnd, onDragMove, onDragStart]);

  return (
    <View ref={setRef} onLayout={onLayout} {...pan.panHandlers}>
      <Pressable onPress={onPress} style={[styles.tab, active && styles.tabActive, (dropTarget || dragging) && styles.tabDropTarget]}>
        <Text style={[styles.tabText, active && styles.tabTextActive]}>{tab.name}</Text>
        <Text style={styles.tabCount}>{count}</Text>
      </Pressable>
    </View>
  );
}

function SessionCard({
  session, selected, collapsed, dragging, onToggleAgents, onFocus, onDragStart, onDragMove, onDragEnd, onDragCancel,
}: {
  session: Session; selected: boolean; collapsed: boolean; dragging: boolean;
  onToggleAgents: () => void; onFocus: () => void; onDragStart: () => void;
  onDragMove: (event: GestureResponderEvent) => void; onDragEnd: () => void; onDragCancel: () => void;
}) {
  const running = session.agents.filter((agent) => agent.status === 'running').length;
  const state = session.exited ? '종료' : '실행 중';
  const pan = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => false,
    onMoveShouldSetPanResponder: (_, gesture) => Math.abs(gesture.dx) > 8 || Math.abs(gesture.dy) > 8,
    onPanResponderGrant: onDragStart,
    onPanResponderMove: onDragMove,
    onPanResponderRelease: onDragEnd,
    onPanResponderTerminate: onDragCancel,
  }), [onDragCancel, onDragEnd, onDragMove, onDragStart]);

  return (
    <View style={[styles.sessionCard, selected && styles.sessionSelected, dragging && styles.sessionDragging]}>
      <Pressable accessibilityRole="button" accessibilityState={{ selected }} onPress={onFocus} style={styles.sessionMain}>
        <View style={styles.sessionIcon}><Text style={styles.sessionIconText}>&gt;_</Text></View>
        <View style={styles.sessionInfo}>
          <Text numberOfLines={1} style={styles.sessionName}>{session.name}</Text>
          <Text numberOfLines={1} style={styles.sessionSubline}>{state}</Text>
        </View>
        <View style={[styles.liveBadge, session.exited && styles.exitedBadge]}>
          <View style={[styles.liveDot, session.exited && styles.exitedDot]} />
          <Text style={styles.liveText}>{state}</Text>
        </View>
      </Pressable>
      {session.agents.length > 0 && <>
        <Pressable accessibilityRole="button" accessibilityLabel={`${session.name} 에이전트 목록 ${collapsed ? '펴기' : '접기'}`}
          onPress={onToggleAgents} style={styles.agentToggle}>
          <Text style={styles.agentChevron}>{collapsed ? '>' : 'v'}</Text>
          <Text style={styles.agentToggleText}>에이전트 {running}/{session.agents.length} 실행 중</Text>
          <Text style={styles.agentToggleAction}>{collapsed ? '펴기' : '접기'}</Text>
        </Pressable>
        {!collapsed && <View style={styles.agentList}>
          {session.agents.map((agent) => (
            <View key={agent.id} style={styles.agentRow}>
              <View style={[styles.agentDot, agent.status === 'running' ? styles.agentRunning : agent.status === 'done' ? styles.agentDone : styles.agentFailed]} />
              <View style={styles.agentInfo}>
                <Text style={styles.agentName}>{agent.name}</Text>
                <Text numberOfLines={1} style={styles.agentTask}>{agent.description}</Text>
              </View>
              <Text style={[styles.agentState, agent.status === 'running' ? styles.agentStateRunning : styles.agentStateDone]}>
                {agent.status === 'running' ? '실행 중' : agent.status === 'done' ? '완료' : agent.status === 'failed' ? '실패' : agent.status === 'cancelled' ? '취소' : '종료'}
              </Text>
            </View>
          ))}
        </View>}
      </>}
      <View style={styles.sessionFooter}>
        <Text style={styles.dragHint}>드래그해 세션을 이동하세요</Text>
        <View {...pan.panHandlers} style={styles.dragHandle}><Text style={styles.dragHandleText}>이동</Text></View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: COLORS.background, paddingHorizontal: 18 },
  header: { paddingTop: 12, paddingBottom: 18, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  eyebrow: { color: COLORS.accent, fontSize: 10, fontWeight: '800', letterSpacing: 1.5 },
  title: { color: COLORS.text, fontSize: 30, fontWeight: '800', marginTop: 4 },
  connectionPill: { flexDirection: 'row', alignItems: 'center', gap: 7, backgroundColor: COLORS.panel, borderColor: COLORS.line, borderWidth: 1, borderRadius: 20, paddingHorizontal: 11, paddingVertical: 8 },
  offlineDot: { width: 7, height: 7, borderRadius: 5, backgroundColor: COLORS.yellow },
  onlineDot: { backgroundColor: COLORS.green },
  connectionText: { color: COLORS.muted, fontSize: 12, fontWeight: '700' },
  previewNotice: { backgroundColor: '#172235', borderColor: '#2b4568', borderWidth: 1, padding: 12, borderRadius: 12, marginBottom: 18 },
  previewTitle: { color: '#d9e8ff', fontSize: 13, fontWeight: '800' },
  previewCopy: { color: '#aab8cc', fontSize: 12, lineHeight: 17, marginTop: 5 },
  desktopPicker: { backgroundColor: COLORS.panel, borderColor: COLORS.line, borderWidth: 1, borderRadius: 11, marginBottom: 14, overflow: 'hidden' },
  desktopPickerButton: { minHeight: 46, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  desktopPickerLabel: { color: COLORS.muted, fontSize: 11, fontWeight: '700' },
  desktopPickerValue: { color: COLORS.text, fontSize: 12, fontWeight: '800', maxWidth: '65%' },
  desktopPickerOptions: { borderTopWidth: 1, borderTopColor: COLORS.line },
  desktopPickerOption: { minHeight: 50, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', gap: 10, borderBottomWidth: 1, borderBottomColor: COLORS.line },
  desktopPickerInfo: { flex: 1, minWidth: 0 },
  desktopPickerName: { color: COLORS.text, fontSize: 12, fontWeight: '700' },
  desktopPickerAddress: { color: COLORS.muted, fontSize: 10, marginTop: 3 },
  desktopPickerCheck: { color: COLORS.green, fontSize: 15, fontWeight: '900' },
  layoutError: { color: '#ff8585', fontSize: 11, marginBottom: 8 },
  sectionHeading: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 9 },
  sectionTitle: { color: COLORS.text, fontSize: 15, fontWeight: '800' },
  hint: { color: COLORS.muted, fontSize: 11 },
  tabs: { gap: 8, paddingBottom: 20 },
  tab: { flexDirection: 'row', alignItems: 'center', gap: 9, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 10, backgroundColor: COLORS.panel, borderColor: COLORS.line, borderWidth: 1 },
  tabActive: { backgroundColor: '#1d2a3d', borderColor: COLORS.accent },
  tabDropTarget: { backgroundColor: '#294667', borderColor: '#9ac5ff', borderWidth: 2 },
  tabText: { color: COLORS.muted, fontSize: 13, fontWeight: '700' },
  tabTextActive: { color: COLORS.text },
  tabCount: { color: COLORS.accent, fontSize: 11, fontWeight: '800' },
  sessionList: { flex: 1, marginHorizontal: -2 },
  sessionListContent: { gap: 10, paddingBottom: 14 },
  sessionCard: { backgroundColor: COLORS.panel, borderColor: COLORS.line, borderWidth: 1, borderRadius: 14, padding: 11 },
  sessionSelected: { borderColor: COLORS.accent },
  sessionDragging: { borderColor: COLORS.accent, opacity: 0.78 },
  sessionMain: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 43 },
  sessionIcon: { width: 34, height: 34, borderRadius: 9, backgroundColor: COLORS.raised, alignItems: 'center', justifyContent: 'center' },
  sessionIconText: { color: COLORS.green, fontSize: 14, fontWeight: '800' },
  sessionInfo: { flex: 1, minWidth: 0 },
  sessionName: { color: COLORS.text, fontSize: 14, fontWeight: '700' },
  sessionSubline: { color: COLORS.muted, fontSize: 10, marginTop: 3 },
  liveBadge: { flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: COLORS.raised, borderRadius: 8, paddingHorizontal: 7, paddingVertical: 5 },
  liveDot: { width: 5, height: 5, borderRadius: 4, backgroundColor: COLORS.yellow },
  exitedBadge: { opacity: 0.68 },
  exitedDot: { backgroundColor: COLORS.muted },
  liveText: { color: COLORS.muted, fontSize: 9, fontWeight: '700' },
  agentToggle: { marginTop: 9, minHeight: 34, borderTopWidth: 1, borderTopColor: COLORS.line, flexDirection: 'row', alignItems: 'center', gap: 7 },
  agentChevron: { color: COLORS.accent, width: 14, fontSize: 15, textAlign: 'center' },
  agentToggleText: { color: COLORS.muted, fontSize: 11, flex: 1 },
  agentToggleAction: { color: COLORS.accent, fontSize: 11, fontWeight: '700' },
  agentList: { gap: 2, paddingTop: 3 },
  agentRow: { minHeight: 43, flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 8 },
  agentDot: { width: 7, height: 7, borderRadius: 5 },
  agentRunning: { backgroundColor: COLORS.green },
  agentDone: { backgroundColor: COLORS.muted },
  agentFailed: { backgroundColor: '#ff7777' },
  agentInfo: { flex: 1, minWidth: 0 },
  agentName: { color: COLORS.text, fontSize: 11, fontWeight: '700' },
  agentTask: { color: COLORS.muted, fontSize: 10, marginTop: 2 },
  agentState: { fontSize: 10, fontWeight: '700' },
  agentStateRunning: { color: COLORS.green },
  agentStateDone: { color: COLORS.muted },
  sessionFooter: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 8, paddingTop: 8, borderTopWidth: 1, borderTopColor: COLORS.line },
  dragHint: { color: COLORS.muted, fontSize: 10 },
  dragHandle: { backgroundColor: COLORS.raised, paddingHorizontal: 10, paddingVertical: 7, borderRadius: 8 },
  dragHandleText: { color: COLORS.accent, fontSize: 11, fontWeight: '800' },
  bottomPanel: { backgroundColor: COLORS.panel, borderColor: COLORS.line, borderWidth: 1, borderRadius: 13, padding: 13, marginTop: 8, marginBottom: 8, minHeight: 72, maxHeight: 340, justifyContent: 'center' },
  terminalViewport: { marginTop: 8, height: 180, borderRadius: 8 },
  inputRow: { flexDirection: 'row', alignItems: 'stretch', gap: 8, marginTop: 8 },
  input: { flex: 1, minWidth: 0, minHeight: 42, maxHeight: 96, color: COLORS.text, backgroundColor: COLORS.raised, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 9, fontSize: 13, textAlignVertical: 'top' },
  inputActions: { justifyContent: 'space-between', gap: 6 },
  sendButton: { backgroundColor: '#24456c', borderRadius: 8, paddingHorizontal: 14, justifyContent: 'center' },
  sendText: { color: '#e8f2ff', fontWeight: '800', fontSize: 12 },
  terminalLabel: { color: COLORS.muted, fontSize: 10, fontWeight: '700' },
  terminalTitle: { color: COLORS.text, fontSize: 13, fontWeight: '800', marginTop: 3 },
  terminalHeading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  terminalHeadingInfo: { flex: 1, minWidth: 0 },
  closeSessionButton: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 7, backgroundColor: '#302126' },
  closeSessionText: { color: '#ff9b9b', fontSize: 10, fontWeight: '800' },
  terminalHint: { color: COLORS.muted, fontSize: 11, lineHeight: 16 },
});
