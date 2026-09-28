import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, openSync, closeSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { makePrompt } from './pointer.mjs';

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

export function completionText(result) {
  return result.sessionFile
    ? `${result.status}: ${result.sessionFile}`
    : `${result.status}: no session log; diagnostics: ${result.stderrFile}`;
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
  let lastAssistant, processError, cancelled = false, settled = false, killTimer;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', eventReader(event => {
    if (event.type === 'message_end' && event.message?.role === 'assistant') {
      lastAssistant = { stopReason: event.message.stopReason };
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
      status: cancelled ? 'cancelled' : code === 0 && ['stop', 'length'].includes(lastAssistant?.stopReason)
        ? (lastAssistant.stopReason === 'stop' ? 'finished' : 'incomplete') : 'failed',
      code, signal: exitSignal, error: processError });
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
