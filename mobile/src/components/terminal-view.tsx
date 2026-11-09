import { useCallback, useEffect, useMemo, useRef } from 'react';
import { StyleSheet, View, type ViewStyle } from 'react-native';
import { WebView, type WebViewMessageEvent, type WebViewNavigation } from 'react-native-webview';
import { terminalCss, terminalJavaScript } from './terminal-web-assets';
import { getOutputUpdate } from '@/services/session-output.mjs';

type TerminalViewProps = {
  value: string;
  onInput: (data: string) => void;
  onResize: (cols: number, rows: number) => void;
  foregrounded: boolean;
  style?: ViewStyle;
};

function createTerminalPage(): string {
  const safeScript = terminalJavaScript.replace(/<\/script/gi, '<\\/script');
  const safeCss = terminalCss.replace(/<\/style/gi, '<\\/style');
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no"><style>${safeCss}
html,body,#terminal{width:100%;height:100%;margin:0;overflow:hidden;background:#0b0e13}body{padding:4px;box-sizing:border-box}#terminal{height:100%}</style></head><body><div id="terminal"></div><script>${safeScript}</script></body></html>`;
}

const INTERNAL_PAGE_URLS = new Set(['about:blank', 'about:srcdoc']);

function javascriptString(value: string): string {
  return JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

export function TerminalView({ value, onInput, onResize, foregrounded, style }: TerminalViewProps) {
  const webView = useRef<WebView<object> | null>(null);
  const ready = useRef(false);
  const previousValue = useRef('');
  const page = useMemo(() => createTerminalPage(), []);

  const syncOutput = useCallback((nextValue: string) => {
    if (!ready.current) return;
    const update = getOutputUpdate(previousValue.current, nextValue);
    if (update.append) {
      if (update.delta) {
        webView.current?.injectJavaScript(`window.mymuxTerminalWrite(${javascriptString(update.delta)});true;`);
      }
    } else {
      webView.current?.injectJavaScript(`window.mymuxTerminalReset(${javascriptString(nextValue)});true;`);
    }
    previousValue.current = nextValue;
  }, []);

  useEffect(() => {
    syncOutput(value);
  }, [syncOutput, value]);

  useEffect(() => {
    if (!ready.current || !foregrounded) return;
    webView.current?.injectJavaScript('window.mymuxTerminalFit?.();true;');
  }, [foregrounded]);

  const onMessage = useCallback((event: WebViewMessageEvent) => {
    if (event.nativeEvent.data.length > 64 * 1024) return;
    let message: unknown;
    try {
      message = JSON.parse(event.nativeEvent.data);
    } catch {
      return;
    }
    if (!message || typeof message !== 'object' || Array.isArray(message)) return;
    const record = message as Record<string, unknown>;
    if (record.type === 'ready') {
      ready.current = true;
      syncOutput(value);
      if (foregrounded) webView.current?.injectJavaScript('window.mymuxTerminalFit?.();true;');
    } else if (record.type === 'input' && typeof record.data === 'string') {
      onInput(record.data);
    } else if (record.type === 'resize' && Number.isInteger(record.cols) && Number.isInteger(record.rows) &&
      (record.cols as number) >= 20 && (record.cols as number) <= 500 &&
      (record.rows as number) >= 5 && (record.rows as number) <= 200) {
      onResize(record.cols as number, record.rows as number);
    }
  }, [foregrounded, onInput, onResize, syncOutput, value]);

  const allowNavigation = useCallback((request: WebViewNavigation) => INTERNAL_PAGE_URLS.has(request.url), []);
  return (
    <View style={[styles.container, style]}>
      <WebView<object>
        ref={webView}
        originWhitelist={['*']}
        source={{ html: page }}
        onMessage={onMessage}
        onShouldStartLoadWithRequest={allowNavigation}
        javaScriptEnabled
        domStorageEnabled={false}
        allowFileAccess={false}
        allowFileAccessFromFileURLs={false}
        allowUniversalAccessFromFileURLs={false}
        mixedContentMode="never"
        setSupportMultipleWindows={false}
        scrollEnabled={false}
        showsHorizontalScrollIndicator={false}
        showsVerticalScrollIndicator={false}
        style={styles.webView}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { overflow: 'hidden', backgroundColor: '#0b0e13' },
  webView: { flex: 1, backgroundColor: '#0b0e13' },
});
