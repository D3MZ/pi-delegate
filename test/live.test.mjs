// Opt-in: real model calls, normal Pi configuration, synthetic temporary workspaces.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { eventReader, completionText } from '../src/runner.mjs';

function parent(t) {
  const root = mkdtempSync(join(tmpdir(), 'pi-delegate-live-'));
  const sessions = join(root, 'parent-sessions');
  const child = spawn('pi', ['--mode', 'rpc', '--session-dir', sessions], {
    cwd: root, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const events = [];
  let waiters = [], stderr = '', sequence = 0;
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdout.on('data', eventReader(event => {
    events.push({ ...event, receivedAt: Date.now() });
    const matched = waiters.filter(waiter => waiter.predicate(event));
    waiters = waiters.filter(waiter => !matched.includes(waiter));
    for (const waiter of matched) waiter.resolve(event);
  }));
  const failWaiters = error => {
    for (const waiter of waiters) waiter.reject(error);
    waiters = [];
  };
  child.on('error', failWaiters);
  child.on('exit', code => failWaiters(new Error(`Pi exited (${code})`)));
  function wait(predicate) {
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters = waiters.filter(waiter => waiter !== item);
        reject(new Error(`Live test deadline; evidence: ${root}`));
      }, 150000);
      const item = { predicate,
        resolve: value => { clearTimeout(timer); resolve(value); },
        reject: error => { clearTimeout(timer); reject(error); } };
      waiters.push(item);
    });
    // Cleanup may reject a future-stage waiter after an earlier assertion fails.
    void promise.catch(() => {});
    return promise;
  }
  async function prompt(message, options = {}) {
    const id = `request-${++sequence}`;
    const response = wait(event => event.type === 'response' && event.id === id);
    child.stdin.write(JSON.stringify({ id, type: 'prompt', message, ...options }) + '\n');
    const result = await response;
    assert.equal(result.success, true, result.error);
  }
  t.after(async () => {
    writeFileSync(join(root, 'events.json'), JSON.stringify(events, null, 2));
    writeFileSync(join(root, 'stderr.log'), stderr);
    t.diagnostic(`Private evidence retained at ${root}`);
    failWaiters(new Error('Live test ended'));
    if (child.exitCode === null && child.signalCode === null) {
      const closed = once(child, 'close');
      child.stdin.end();
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
      await closed;
      clearTimeout(timer);
    }
  });
  return { root, sessions, events, wait, prompt };
}
const isCompletion = event => event.type === 'message_end' && event.message?.customType === 'pi-delegate-result';
const isDelegateEnd = event => event.type === 'tool_execution_end' && event.toolName === 'delegate';
const options = { skip: process.env.PI_DELEGATE_LIVE !== '1', timeout: 240000 };

test('live: explicit background work leaves parent available and reports completion', options, async t => {
  const p = parent(t);
  await p.prompt('/delegate on');
  const launched = p.wait(isDelegateEnd);
  const completed = p.wait(isCompletion);
  await p.prompt('Run this task in the background: create proof.txt containing exactly POINTER_E2E_OK. Wait six seconds before writing it. This is a synthetic test; do not modify other files.');
  assert.ok(!(await launched).isError, 'default call must not need an invalid-ID retry');
  const answered = p.wait(event => event.type === 'message_end' && event.message?.role === 'assistant'
    && /\b4\b/.test(JSON.stringify(event.message.content)));
  await p.prompt('While that runs, what is 2+2? Answer directly without a tool or delegation.', { streamingBehavior: 'followUp' });
  await answered;
  assert.equal(p.events.filter(isCompletion).length, 0, 'parent answered before child completion');
  await completed;
  assert.equal(readFileSync(join(p.root, 'proof.txt'), 'utf8'), 'POINTER_E2E_OK');
  assert.equal(p.events.filter(isDelegateEnd).length, 1, 'no polling or re-delegation loop');
  const launch = p.events.find(isDelegateEnd);
  const completion = p.events.find(isCompletion);
  const log = completion.message.details.sessionFile;
  assert.equal(completion.message.details.success, true);
  const call = p.events.find(event => event.type === 'tool_execution_start' && event.toolName === 'delegate');
  assert.equal(completion.message.content, completionText(completion.message.details, call.args.returnLastResponse));
  const childEntries = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const task = childEntries.find(entry => entry.type === 'message' && entry.message.role === 'user');
  const taskText = typeof task.message.content === 'string' ? task.message.content
    : task.message.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
  assert.ok(taskText.includes(JSON.stringify(launch.result.details.pointer)), 'child log links back to exact source assignment');
  assert.ok(!taskText.includes('POINTER_E2E_OK'), 'task text was not copied into the handoff');
  assert.ok(p.events.filter(event => event.type === 'tool_execution_start'
    && event.receivedAt > launch.receivedAt && event.receivedAt < completion.receivedAt).length === 0,
  'no monitoring tools between launch and completion');
});

test('live: off/on and two workers assigned earlier-message character ranges', options, async t => {
  const p = parent(t);
  await p.prompt('/delegate off');
  const prefix = 'Do not execute yet. Keep these independent tasks for later:\n';
  const first = 'Wait six seconds, then create alpha.txt containing exactly ALPHA.';
  const second = 'Wait six seconds, then create beta.txt containing exactly BETA.';
  const idle = p.wait(event => event.type === 'agent_settled');
  await p.prompt(prefix + first + '\n' + second);
  await idle;
  assert.equal(p.events.filter(isDelegateEnd).length, 0);
  const file = join(p.sessions, readdirSync(p.sessions).find(name => name.endsWith('.jsonl')));
  const rows = readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const target = rows.find(row => row.type === 'message' && row.message.role === 'user'
    && JSON.stringify(row.message.content).includes('Keep these independent tasks'));
  assert.ok(target);
  await p.prompt('/delegate on');
  const start1 = Array.from(prefix).length, end1 = start1 + Array.from(first).length;
  const start2 = end1 + 1, end2 = start2 + Array.from(second).length;
  const done = p.wait(event => isCompletion(event) && p.events.filter(isCompletion).length === 2);
  await p.prompt(`Now execute those two tasks from my earlier message. Look up its real top-level user-entry ID in the session log. ` +
    `Spawn one worker for start ${start1}, end ${end1}, and another for start ${start2}, end ${end2}. ` +
    'Call delegate twice and return without waiting or polling. Do not create the files yourself.');
  await done;
  const calls = p.events.filter(event => event.type === 'tool_execution_start' && event.toolName === 'delegate');
  const lookup = p.events.slice(0, p.events.indexOf(calls[0])).find(event =>
    event.type === 'tool_execution_start' && event.toolName !== 'delegate'
      && JSON.stringify(event.args).includes(file));
  assert.ok(lookup, 'parent looked up the earlier ID in the log on demand');
  assert.deepEqual(calls.map(({ args: { returnLastResponse, ...pointer } }) => pointer).sort((a, b) => a.start - b.start), [
    { messageId: target.id, start: start1, end: end1 }, { messageId: target.id, start: start2, end: end2 },
  ]);
  const launches = p.events.filter(isDelegateEnd);
  assert.ok(launches.every(event => !event.isError));
  assert.ok(launches[1].receivedAt < p.events.find(isCompletion).receivedAt, 'both launched before either finished');
  assert.equal(readFileSync(join(p.root, 'alpha.txt'), 'utf8'), 'ALPHA');
  assert.equal(readFileSync(join(p.root, 'beta.txt'), 'utf8'), 'BETA');
});
