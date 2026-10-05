import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, openSync, closeSync, readdirSync, fstatSync, readSync } from 'node:fs';
import { join } from 'node:path';
// Refresh the handoff prompt too when Pi reloads the extension in the same process.
const { makePrompt, messageText } = await import(`./pointer.mjs?reload=${Date.now()}-${Math.random()}`);

// Bounded, LF-only JSONL parser. Never retain streamed thinking or tool output.
export function eventReader(onEvent, maxLength = 8 * 1024 * 1024) {
  let buffer = '', dropping = false;
  return chunk => {
    for (const [index, piece] of chunk.split('\n').entries()) {
      if (index > 0) {
        if (!dropping && buffer.trim()) {
          try { onEvent(JSON.parse(buffer)); } catch { /* Non-protocol diagnostics. */ }
        }
        buffer = ''; dropping = false;
      }
      if (!dropping) {
        buffer += piece;
        if (buffer.length > maxLength) { buffer = ''; dropping = true; }
      }
    }
  };
}

export function completionText(result, returnLastResponse = false) {
  const outcome = `${result.id}:${result.success ? 'Completed' : 'Error'}`;
  const response = returnLastResponse
    ? ` last response: ${result.lastResponse || '(no assistant text response)'}` : '';
  const diagnostic = !result.success && result.error ? `\nError: ${result.error}` : '';
  return outcome + response + diagnostic;
}

function stderrTail(path) {
  let fd;
  try {
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    const buffer = Buffer.alloc(Math.min(size, 8192));
    const length = readSync(fd, buffer, 0, buffer.length, size - buffer.length);
    return buffer.subarray(0, length).toString('utf8').trim() || undefined;
  } catch { return undefined; }
  finally { if (fd !== undefined) closeSync(fd); }
}

export async function startWorker({ cwd, root, pointer, command = 'pi', prefix = [], env = process.env }) {
  const id = randomUUID();
  const directory = join(root, id);
  const sessions = join(directory, 'sessions');
  mkdirSync(sessions, { recursive: true, mode: 0o700 });
  const stderrFile = join(directory, 'stderr.log');
  const fd = openSync(stderrFile, 'wx', 0o600);
  let child;
  try {
    child = spawn(command, [...prefix, '--mode', 'json', '--session-dir', sessions,
      '--session-id', id, '--', makePrompt(pointer)], {
      cwd, env: { ...env, PI_DELEGATE_CHILD: '1' },
      stdio: ['ignore', 'pipe', fd], detached: process.platform !== 'win32',
    });
  } finally { closeSync(fd); }
  let lastAssistant, lastResponse = '', processError, assistantError, cancelled = false, settled = false, killTimer;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', eventReader(event => {
    if (event.type === 'message_end' && event.message?.role === 'assistant') {
      lastAssistant = { stopReason: event.message.stopReason };
      const text = messageText(event.message.content);
      if (text.trim()) lastResponse = text;
      assistantError = event.message.errorMessage;
    }
  }));
  child.on('error', error => { processError = error.message; });
  const signal = value => {
    try {
      if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, value);
      else child.kill(value);
    } catch (error) { if (error.code !== 'ESRCH') throw error; }
  };
  const done = new Promise(resolve => child.once('close', (code, exitSignal) => {
    settled = true;
    clearTimeout(killTimer);
    let sessionFile;
    try { sessionFile = readdirSync(sessions).find(name => name.endsWith('.jsonl')); }
    catch { /* Logs may have been removed externally. */ }
    resolve({ id, directory, stderrFile, sessionFile: sessionFile && join(sessions, sessionFile),
      status: cancelled ? 'cancelled' : code === 0 && !processError && !assistantError && lastAssistant?.stopReason === 'stop' ? 'finished'
        : code === 0 && !processError && !assistantError && lastAssistant?.stopReason === 'length' ? 'incomplete' : 'failed',
      success: !cancelled && !processError && !assistantError && code === 0 && lastAssistant?.stopReason === 'stop',
      lastResponse,
      code, signal: exitSignal, error: processError || assistantError ||
        (!cancelled && code !== 0 ? stderrTail(stderrFile) || `Worker exited with code ${code}, signal ${exitSignal || 'none'}.` : undefined) });
  }));
  try {
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
  } catch (error) {
    await done;
    throw error;
  }
  return { id, directory, pid: child.pid, done, cancel() {
    if (settled || cancelled) return;
    cancelled = true;
    signal('SIGTERM');
    killTimer = setTimeout(() => signal('SIGKILL'), 2000);
    killTimer.unref();
  } };
}
