export const MOBILE_OUTPUT_WINDOW_CHARS = 24_000;

/** Append a consumed PTY batch while keeping the visible character window bounded. */
export function appendOutputWindow(current, incoming, maxChars = MOBILE_OUTPUT_WINDOW_CHARS) {
  const combined = current + incoming;
  if (combined.length <= maxChars) return combined;
  let start = combined.length - maxChars;
  // Do not leave an unpaired low surrogate at the start of the visible tail.
  if (start > 0 && /[\uDC00-\uDFFF]/.test(combined[start]) && /[\uD800-\uDBFF]/.test(combined[start - 1])) {
    start += 1;
  }
  return combined.slice(start);
}

/** Find the new suffix when a bounded display window slides forward. */
export function getOutputUpdate(previous, next) {
  if (next.startsWith(previous)) return { append: true, delta: next.slice(previous.length) };
  if (previous.startsWith(next)) return { append: true, delta: '' };
  const patternLength = Math.min(previous.length, next.length);
  if (patternLength === 0) return { append: false, delta: next };

  const pattern = next.slice(0, patternLength);
  const prefix = new Uint32Array(patternLength);
  for (let index = 1, matched = 0; index < patternLength; index += 1) {
    while (matched > 0 && pattern[index] !== pattern[matched]) matched = prefix[matched - 1];
    if (pattern[index] === pattern[matched]) matched += 1;
    prefix[index] = matched;
  }

  let matched = 0;
  const scanStart = previous.length - patternLength;
  for (let index = scanStart; index < previous.length; index += 1) {
    const char = previous[index];
    while (matched > 0 && char !== pattern[matched]) matched = prefix[matched - 1];
    if (char === pattern[matched]) matched += 1;
    if (matched === patternLength && index < previous.length - 1) matched = prefix[matched - 1];
  }
  return matched > 0
    ? { append: true, delta: next.slice(matched) }
    : { append: false, delta: next };
}

/** Read whichever session is selected at call time and advance by the server cursor. */
export async function pollSelectedSessionOutput({ client, getSelectedSessionId, offsets, outputs }) {
  const sessionId = getSelectedSessionId();
  if (!sessionId) return null;

  const offset = offsets[sessionId] ?? 0;
  const batch = await client.readOutput(sessionId, offset);
  const marker = batch.truncated ? '\n[이전 출력 일부가 보존 한도를 넘어 생략되었습니다]\n' : '';
  const output = appendOutputWindow(outputs[sessionId] ?? '', marker + batch.chunks.join(''));

  // `next` is the PTY owner's byte cursor for the entire consumed batch. Keep
  // it independent from the bounded display window, which counts characters.
  offsets[sessionId] = batch.next;
  outputs[sessionId] = output;
  return { sessionId, batch, output };
}
