import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolvePointer, makePrompt, messageText } from '../src/pointer.mjs';
import { startWorker, eventReader, completionText } from '../src/runner.mjs';
const user = (id, content) => ({ type: 'message', id, message: { role: 'user', content } });
const branch = [user('first', 'original request'), user('last', 'a😀bc')];

test('explicit IDs must identify user messages on the active branch', () => {
  const entries = [...branch, { type: 'message', id: 'assistant-id', message: { role: 'assistant', content: [] } }];
  for (const messageId of ['assistant-id', 'abandoned-branch-id', 'concat-000002-user']) {
    assert.throws(() => resolvePointer('/tmp/s', entries, { messageId }), /read the session log/);
  }
  assert.equal(resolvePointer('/tmp/s', entries, { messageId: 'first' }).messageId, 'first');
});

test('defaults to latest user message, retaining thread leaf', () => {
  assert.deepEqual(resolvePointer('/tmp/session.jsonl', [...branch, { type: 'custom', id: 'leaf' }]),
    { sessionFile: '/tmp/session.jsonl', messageId: 'last', contextLeafId: 'leaf' });
});
test('explicit earlier request and Unicode range', () => {
  assert.equal(resolvePointer('/tmp/s', branch, { messageId: 'first' }).messageId, 'first');
  assert.equal(resolvePointer('/tmp/s', branch, { start: 1, end: 2 }).end, 2);
  assert.equal(messageText([{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }]), 'a\nb');
});
test('rejects invalid pointers, ranges, context edits, and task text', () => {
  for (const args of [{ messageId: 'absent' }, { start: 0 }, { end: 1 }, { start: -1, end: 1 },
    { start: 1, end: 1 }, { start: 0, end: 5 }, { start: 0.1, end: 1 }, { task: 'rewrite' }]) {
    assert.throws(() => resolvePointer('/tmp/s', branch, args));
  }
  assert.throws(() => resolvePointer(undefined, branch));
  assert.throws(() => resolvePointer('relative', branch));
  assert.throws(() => resolvePointer('/tmp/s', []));
  assert.throws(() => resolvePointer('/tmp/s', [...branch, { type: 'context_edit', targetId: 'last' }]));
});
test('handoff includes pointers but no task contents', () => {
  const prompt = makePrompt(resolvePointer('/tmp/s', branch));
  assert.ok(prompt.includes('"messageId":"last"'));
  assert.ok(!prompt.includes('original request'));
  assert.ok(!prompt.includes('a😀bc'));
});
test('JSONL handles chunk boundaries, Unicode separators, oversized records, and diagnostics', () => {
  const events = [];
  const read = eventReader(event => events.push(event), 80);
  read('{"text":"a\u2028'); read('b"}\r\nnot json\n');
  read('x'.repeat(90)); read('\n{"ok":true}\n');
  assert.deepEqual(events, [{ text: 'a\u2028b' }, { ok: true }]);
});

test('completion notifications forward the final response only when requested', () => {
  assert.equal(completionText({ id: 'worker', success: true, lastResponse: 'hidden' }), 'worker:Completed');
  assert.equal(completionText({ id: 'worker', success: false, lastResponse: 'Blocked 😀\nDetails' }), 'worker:Error');
  assert.equal(completionText({ id: 'worker', success: false, lastResponse: 'Blocked 😀\nDetails' }, true),
    'worker:Error last response: Blocked 😀\nDetails');
  assert.equal(completionText({ id: 'worker', success: true, lastResponse: 'Answer' }, true),
    'worker:Completed last response: Answer');
  assert.equal(completionText({ id: 'worker' }), 'worker:Error');
  assert.equal(completionText({ id: 'worker' }, true), 'worker:Error last response: (no assistant text response)');
});

for (const [mode, status] of [['normal', 'finished'], ['blocked', 'finished'], ['length', 'incomplete'], ['error', 'failed'], ['exit', 'failed'], ['wait', 'cancelled']]) {
  test(`native child lifecycle: ${mode}`, async t => {
    const root = mkdtempSync(join(tmpdir(), 'pi-delegate-test-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const worker = await startWorker({ cwd: root, root,
      pointer: resolvePointer('/tmp/s', branch), command: process.execPath,
      prefix: [fileURLToPath(new URL('./fixtures/child.mjs', import.meta.url))],
      env: { ...process.env, FIXTURE_MODE: mode },
    });
    assert.ok(worker.pid);
    if (mode === 'wait') worker.cancel();
    const result = await worker.done;
    assert.equal(result.status, status);
    assert.equal(result.success, mode === 'normal' || mode === 'blocked');
    if (mode === 'blocked') {
      assert.equal(result.lastResponse, 'Blocked: cannot finish');
      assert.equal(completionText(result), `${result.id}:Completed`);
      assert.equal(completionText(result, true), `${result.id}:Completed last response: Blocked: cannot finish`);
    }
    if (mode === 'normal') assert.equal(result.error, undefined);
    if (mode !== 'wait' && mode !== 'blocked') assert.equal(result.lastResponse, 'Worker result 😀');
    if (mode !== 'wait') {
      const fixture = JSON.parse(readFileSync(result.sessionFile, 'utf8'));
      assert.equal(fixture.child, '1');
      for (const override of ['--model', '--thinking', '--no-extensions', '--no-session', '--continue', '--fork']) {
        assert.ok(!fixture.args.includes(override));
      }
      assert.ok(!fixture.args.at(-1).includes('original request'));
      assert.ok(!fixture.args.includes('--extension'));
      assert.ok(!fixture.args.at(-1).includes('delegate_callback'));
    }
  });
}
for (const mode of ['tool-error', 'empty-error']) {
  test(`provider failure preserves text, not tool calls: ${mode}`, async t => {
    const root = mkdtempSync(join(tmpdir(), 'pi-delegate-error-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const worker = await startWorker({ cwd: root, root, pointer: resolvePointer('/tmp/s', branch),
      command: process.execPath, prefix: [fileURLToPath(new URL('./fixtures/child.mjs', import.meta.url))],
      env: { ...process.env, FIXTURE_MODE: mode } });
    const result = await worker.done;
    assert.equal(result.success, false);
    assert.equal(result.error, 'WebSocket error');
    assert.equal(result.lastResponse, mode === 'tool-error' ? 'Last real response' : '');
    for (const option of [false, true]) {
      assert.match(completionText(result, option), /Error: WebSocket error/);
      assert.equal(completionText(result, option).includes('last response:'), option);
      assert.ok(!completionText(result, option).includes('partial'));
      assert.ok(!completionText(result, option).includes('Not the response'));
    }
  });
}

test('startup failures surface stderr even without an assistant response', async t => {
  const root = mkdtempSync(join(tmpdir(), 'pi-delegate-startup-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const worker = await startWorker({ cwd: root, root, pointer: resolvePointer('/tmp/s', branch),
    command: process.execPath, prefix: [fileURLToPath(new URL('./fixtures/child.mjs', import.meta.url))],
    env: { ...process.env, FIXTURE_MODE: 'startup-error' } });
  const result = await worker.done;
  assert.equal(result.success, false);
  assert.equal(result.lastResponse, '');
  assert.match(completionText(result), /Error: Failed to load extension: missing callback.ts/);
});

test('spawn failure rejects without an unhandled rejection', async t => {
  const root = mkdtempSync(join(tmpdir(), 'pi-delegate-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  await assert.rejects(startWorker({ cwd: root, root, pointer: resolvePointer('/tmp/s', branch), command: '/missing/pi' }), /ENOENT/);
});
