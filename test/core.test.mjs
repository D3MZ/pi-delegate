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

test('completion callbacks contain only status and child log pointer', () => {
  for (const status of ['finished', 'failed', 'cancelled', 'incomplete']) {
    assert.equal(completionText({ status, sessionFile: '/private/child.jsonl', stderrFile: '/private/stderr.log' }),
      `${status}: /private/child.jsonl`);
  }
  assert.equal(completionText({ status: 'failed', stderrFile: '/private/stderr.log' }),
    'failed: no session log; diagnostics: /private/stderr.log');
});

for (const [mode, status] of [['normal', 'finished'], ['error', 'failed'], ['exit', 'failed'], ['wait', 'cancelled']]) {
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
    if (mode !== 'wait') {
      const fixture = JSON.parse(readFileSync(result.sessionFile, 'utf8'));
      assert.equal(fixture.child, '1');
      for (const override of ['--model', '--thinking', '--no-extensions', '--no-session', '--continue', '--fork']) {
        assert.ok(!fixture.args.includes(override));
      }
      assert.ok(!fixture.args.at(-1).includes('original request'));
    }
  });
}
test('spawn failure rejects without an unhandled rejection', async t => {
  const root = mkdtempSync(join(tmpdir(), 'pi-delegate-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  await assert.rejects(startWorker({ cwd: root, root, pointer: resolvePointer('/tmp/s', branch), command: '/missing/pi' }), /ENOENT/);
});
