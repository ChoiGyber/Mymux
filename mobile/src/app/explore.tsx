import { useCallback, useEffect, useState } from 'react';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { useIsFocused } from 'expo-router';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { parsePairingCode, type PairingCode } from '@/services/pairing-code';
import { forgetPairedDesktop, getPairedDesktopSummaries, savePairedDesktop, type PairedDesktopSummary } from '@/services/paired-desktops';
import { MobileDesktopClient } from '@/services/mobile-client';

const bg = '#101218';
const panel = '#191d26';
const text = '#edf1f7';
const muted = '#929baa';
const accent = '#69a8ff';

export default function PairingScreen() {
  const isFocused = useIsFocused();
  const [permission, requestPermission] = useCameraPermissions();
  const [scanning, setScanning] = useState(false);
  const [pairingCode, setPairingCode] = useState<PairingCode | null>(null);
  const [paired, setPaired] = useState<PairedDesktopSummary[]>([]);
  const [pairedError, setPairedError] = useState<string | null>(null);
  const [now, setNow] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [pairingBusy, setPairingBusy] = useState(false);
  const [pairingProgress, setPairingProgress] = useState<string | null>(null);
  const expired = pairingCode !== null && pairingCode.expiresAt <= now;
  const secondsRemaining = pairingCode ? Math.max(0, Math.ceil((pairingCode.expiresAt - now) / 1000)) : 0;

  const refreshPaired = useCallback(async () => {
    try {
      setPaired(await getPairedDesktopSummaries());
      setPairedError(null);
    } catch {
      setPairedError('저장된 데스크톱 목록을 읽지 못했습니다.');
    }
  }, []);

  useEffect(() => {
    let mounted = true;
    getPairedDesktopSummaries().then((items) => {
      if (!mounted) return;
      setPaired(items);
      setPairedError(null);
    }).catch(() => {
      if (mounted) setPairedError('저장된 데스크톱 목록을 읽지 못했습니다.');
    });
    return () => { mounted = false; };
  }, []);

  useEffect(() => {
    if (!pairingCode) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [pairingCode]);

  const startScan = async () => {
    setError(null);
    setPairingProgress(null);
    setPairingCode(null);
    setNow(Date.now());
    if (!permission?.granted) {
      const result = await requestPermission();
      if (!result.granted) {
        setError('카메라 권한이 필요합니다. 설정에서 Mymux 카메라 접근을 허용해 주세요.');
        return;
      }
    }
    setScanning(true);
  };

  const requestPairing = async () => {
    if (!pairingCode || expired || pairingBusy) return;
    setPairingBusy(true);
    setError(null);
    setPairingProgress('암호화 연결 후 데스크톱 승인을 기다립니다.');
    let client: MobileDesktopClient | null = null;
    try {
      const result = await MobileDesktopClient.pair(pairingCode);
      client = result.client;
      await savePairedDesktop(result.desktop);
      setPairingProgress('데스크톱 승인 완료 · 자격 증명을 이 기기에 저장했습니다.');
      setPairingCode(null);
      await refreshPaired();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '데스크톱 페어링에 실패했습니다.');
      setPairingProgress(null);
    } finally {
      client?.close();
      setPairingBusy(false);
    }
  };

  return (
    <SafeAreaView style={styles.safe}>
      <Text style={styles.kicker}>MYMUX COMPANION</Text>
      <Text style={styles.title}>데스크톱 연결</Text>
      <View style={styles.savedCard}>
        <Text style={styles.savedTitle}>저장된 데스크톱</Text>
        {paired.map((desktop) => <View key={desktop.serverKey} style={styles.savedRow}>
          <View style={styles.savedInfo}>
            <Text numberOfLines={1} style={styles.savedName}>{desktop.name}</Text>
            <Text numberOfLines={1} style={styles.savedAddress}>{desktop.host}:{desktop.port}</Text>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${desktop.name} 기기에서 저장 자격 증명 지우기`}
            onPress={() => Alert.alert(
              '이 기기에서 연결 정보 삭제',
              `${desktop.name}의 모바일 저장 자격 증명만 이 기기에서 제거합니다. 데스크톱의 기기 등록은 별도로 해제해야 합니다.`,
              [
                { text: '취소', style: 'cancel' },
                { text: '삭제', style: 'destructive', onPress: () => { void forgetPairedDesktop(desktop.serverKey).then(refreshPaired).catch(() => setPairedError('연결 정보를 삭제하지 못했습니다.')); } },
              ],
            )}
            style={styles.forgetButton}>
            <Text style={styles.forgetText}>삭제</Text>
          </Pressable>
        </View>)}
        {paired.length === 0 && <Text style={styles.savedEmpty}>승인되어 저장된 데스크톱이 없습니다.</Text>}
      </View>
      {pairedError && <Text accessibilityRole="alert" style={styles.error}>{pairedError}</Text>}
      {scanning ? <View style={styles.cameraFrame}>
        <CameraView
          active={isFocused}
          style={styles.camera}
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          onBarcodeScanned={({ data }) => {
            setScanning(false);
            setNow(Date.now());
            try {
              setPairingCode(parsePairingCode(data));
              setError(null);
            } catch (cause) {
              setError(cause instanceof Error ? cause.message : '연결 코드를 읽지 못했습니다.');
            }
          }}
        />
        <Text style={styles.cameraHint}>데스크톱 Mymux의 모바일 연결 QR을 비춰 주세요</Text>
        <Pressable onPress={() => setScanning(false)} style={styles.secondaryButton}><Text style={styles.secondaryText}>취소</Text></Pressable>
      </View> : <View style={styles.card}>
        <Text style={styles.icon}>⌁</Text>
        <Text style={styles.cardTitle}>{pairingCode ? '연결 코드 확인됨' : '데스크톱 연결'}</Text>
        <Text style={styles.copy}>
          {pairingCode
            ? expired
              ? `${pairingCode.host}:${pairingCode.port}\n연결 코드가 만료되었습니다. 다시 스캔해 주세요.`
              : `${pairingCode.host}:${pairingCode.port}\n서버 키: ${pairingCode.serverKey.slice(0, 12)}…\n코드 만료까지 ${secondsRemaining}초 · 페어링 전 단계입니다.`
            : '데스크톱 Mymux에서 모바일 연결을 켜고 QR 코드를 스캔하세요. 일회용 연결 코드와 만료 시각을 확인합니다.'}
        </Text>
        {!pairingCode && <Pressable onPress={startScan} style={styles.scanButton}><Text style={styles.scanText}>QR 코드 스캔</Text></Pressable>}
        {pairingCode && <Pressable disabled={expired || pairingBusy} onPress={() => { void requestPairing(); }} style={[styles.scanButton, (expired || pairingBusy) && styles.disabledButton]}><Text style={styles.scanText}>{pairingBusy ? '데스크톱 승인 대기 중' : expired ? '코드 만료' : '연결 요청 및 승인 대기'}</Text></Pressable>}
        {pairingCode && !pairingBusy && <Pressable onPress={() => { setPairingCode(null); setError(null); setPairingProgress(null); }} style={styles.secondaryButton}><Text style={styles.secondaryText}>다른 코드 스캔</Text></Pressable>}
        {pairingProgress && <Text accessibilityRole="status" style={styles.pairingProgress}>{pairingProgress}</Text>}
      </View>}
      {error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
      <Text style={styles.footnote}>QR nonce로 암호화된 Noise 핸드셰이크를 시작합니다. 데스크톱 승인 전에는 기기 자격 증명을 저장하지 않습니다.</Text>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: bg, paddingHorizontal: 20, paddingTop: 22 },
  kicker: { color: accent, fontSize: 10, fontWeight: '800', letterSpacing: 1.5 },
  title: { color: text, fontSize: 27, fontWeight: '800', marginTop: 6, marginBottom: 20 },
  card: { alignItems: 'center', backgroundColor: panel, borderColor: '#2b3340', borderWidth: 1, borderRadius: 18, padding: 24 },
  savedCard: { backgroundColor: panel, borderColor: '#2b3340', borderWidth: 1, borderRadius: 14, padding: 14, marginBottom: 14 },
  savedTitle: { color: text, fontSize: 13, fontWeight: '800', marginBottom: 8 },
  savedRow: { minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 10, borderTopWidth: 1, borderTopColor: '#2b3340', paddingVertical: 8 },
  savedInfo: { flex: 1, minWidth: 0 },
  savedName: { color: text, fontSize: 12, fontWeight: '700' },
  savedAddress: { color: muted, fontSize: 10, marginTop: 3 },
  savedEmpty: { color: muted, fontSize: 11, lineHeight: 16 },
  forgetButton: { paddingHorizontal: 11, paddingVertical: 7, borderRadius: 8, backgroundColor: '#302126' },
  forgetText: { color: '#ff9b9b', fontSize: 11, fontWeight: '700' },
  icon: { color: accent, fontSize: 40, marginBottom: 12 },
  cardTitle: { color: text, fontSize: 17, fontWeight: '800', marginBottom: 9 },
  copy: { color: muted, fontSize: 13, lineHeight: 20, textAlign: 'center' },
  badge: { backgroundColor: '#1d2a3d', paddingHorizontal: 11, paddingVertical: 8, borderRadius: 9, marginTop: 18 },
  badgeText: { color: '#a8cbff', fontSize: 11, fontWeight: '700' },
  footnote: { color: muted, fontSize: 11, lineHeight: 17, marginTop: 14 },
  scanButton: { backgroundColor: '#24456c', borderRadius: 10, paddingHorizontal: 18, paddingVertical: 11, marginTop: 18 },
  scanText: { color: '#e8f2ff', fontWeight: '800', fontSize: 13 },
  disabledButton: { opacity: 0.45 },
  pairingProgress: { color: '#a8cbff', fontSize: 12, lineHeight: 18, textAlign: 'center', marginTop: 14 },
  cameraFrame: { borderRadius: 16, overflow: 'hidden', backgroundColor: panel, borderColor: '#2b3340', borderWidth: 1, padding: 10 },
  camera: { height: 320, borderRadius: 10, overflow: 'hidden' },
  cameraHint: { color: text, fontSize: 12, textAlign: 'center', paddingVertical: 12 },
  secondaryButton: { alignItems: 'center', padding: 10 },
  secondaryText: { color: muted, fontWeight: '700' },
  error: { color: '#ff8585', fontSize: 12, lineHeight: 17, marginTop: 12 },
});
