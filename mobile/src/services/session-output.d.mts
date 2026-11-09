import type { PtyOutputBatch } from './pairing-code';

export const MOBILE_OUTPUT_WINDOW_CHARS: number;
export function appendOutputWindow(current: string, incoming: string, maxChars?: number): string;
export function getOutputUpdate(previous: string, next: string): { append: boolean; delta: string };
export function pollSelectedSessionOutput(args: {
  client: { readOutput(sessionId: string, offset: number): Promise<PtyOutputBatch> };
  getSelectedSessionId(): string | null;
  offsets: Record<string, number>;
  outputs: Record<string, string>;
}): Promise<{ sessionId: string; batch: PtyOutputBatch; output: string } | null>;
