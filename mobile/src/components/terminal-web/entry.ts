import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';

declare global {
  interface Window {
    ReactNativeWebView?: { postMessage(message: string): void };
    mymuxTerminalWrite?: (data: string) => void;
    mymuxTerminalReset?: (data: string) => void;
    mymuxTerminalFit?: () => void;
  }
}

const terminal = new Terminal({
  allowProposedApi: false,
  convertEol: false,
  cursorBlink: true,
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: 12,
  scrollback: 2_000,
  theme: {
    background: '#0b0e13',
    foreground: '#d5dbe6',
    cursor: '#69a8ff',
    selectionBackground: '#355578',
  },
});
const fit = new FitAddon();
terminal.loadAddon(fit);
terminal.open(document.getElementById('terminal')!);

function post(message: Record<string, unknown>) {
  window.ReactNativeWebView?.postMessage(JSON.stringify(message));
}

function fitAndReport() {
  try {
    fit.fit();
    post({ type: 'resize', cols: terminal.cols, rows: terminal.rows });
  } catch {
    return;
  }
}

function postInput(data: string) {
  let chunk = '';
  let bytes = 0;
  for (const character of data) {
    const point = character.codePointAt(0) ?? 0;
    const size = point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
    if (bytes > 0 && bytes + size > 4 * 1024) {
      post({ type: 'input', data: chunk });
      chunk = '';
      bytes = 0;
    }
    chunk += character;
    bytes += size;
  }
  if (chunk) post({ type: 'input', data: chunk });
}

window.mymuxTerminalWrite = (data) => terminal.write(data);
window.mymuxTerminalFit = fitAndReport;
window.mymuxTerminalReset = (data) => {
  terminal.reset();
  terminal.write(data);
};
terminal.onData(postInput);
terminal.onResize(({ cols, rows }) => post({ type: 'resize', cols, rows }));
window.addEventListener('resize', fitAndReport);
window.addEventListener('orientationchange', fitAndReport);
window.visualViewport?.addEventListener('resize', fitAndReport);
const terminalElement = document.getElementById('terminal');
if (terminalElement && typeof ResizeObserver !== 'undefined') {
  new ResizeObserver(fitAndReport).observe(terminalElement);
}
requestAnimationFrame(() => {
  fitAndReport();
  post({ type: 'ready' });
});
