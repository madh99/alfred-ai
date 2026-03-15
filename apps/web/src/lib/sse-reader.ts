/**
 * Read SSE events from a fetch Response body stream.
 * Handles chunked transfers and partial lines correctly.
 */
export async function* readSseStream(
  response: Response,
): AsyncGenerator<{ event: string; data: string }> {
  const reader = response.body?.getReader();
  if (!reader) return;

  const decoder = new TextDecoder();
  let buffer = '';
  let currentEvent = '';
  let currentData = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() ?? ''; // keep incomplete last line

      for (const line of lines) {
        if (line.startsWith('event: ')) {
          currentEvent = line.slice(7).trim();
        } else if (line.startsWith('data: ')) {
          currentData += (currentData ? '\n' : '') + line.slice(6);
        } else if (line === '') {
          // Empty line = end of event block
          if (currentEvent && currentData) {
            yield { event: currentEvent, data: currentData };
          }
          currentEvent = '';
          currentData = '';
        }
      }
    }

    // Flush remaining
    if (currentEvent && currentData) {
      yield { event: currentEvent, data: currentData };
    }
  } finally {
    reader.releaseLock();
  }
}
