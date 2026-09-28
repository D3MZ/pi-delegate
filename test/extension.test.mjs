import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Optional harness integration, using an installed Pi (no model calls).
const piPackage = process.env.PI_DELEGATE_PI_PACKAGE;
test('Pi loader, global mode, pointer-only tool, notification, shutdown, and child guard',
  { skip: !piPackage, timeout: 15000 }, async t => {
    const root = mkdtempSync(join(tmpdir(), 'pi-delegate-extension-'));
    const saved = { PATH: process.env.PATH, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
      PI_DELEGATE_CHILD: process.env.PI_DELEGATE_CHILD, FIXTURE_MODE: process.env.FIXTURE_MODE };
    t.after(() => {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      rmSync(root, { recursive: true, force: true });
    });
    process.env.PI_CODING_AGENT_DIR = root;
    delete process.env.PI_DELEGATE_CHILD;
    const fixture = fileURLToPath(new URL('./fixtures/child.mjs', import.meta.url));
    writeFileSync(join(root, 'pi'), `#!/bin/sh\nexec "${process.execPath}" "${fixture}" "$@"\n`, { mode: 0o700 });
    process.env.PATH = root + ':' + saved.PATH;
    const { loadExtensions } = await import(pathToFileURL(join(piPackage, 'dist/core/extensions/loader.js')));
    const entryPath = fileURLToPath(new URL('../src/extension.ts', import.meta.url));
    const loaded = await loadExtensions([entryPath], root);
    assert.deepEqual(loaded.errors, []);
    const extension = loaded.extensions[0];
    const branch = [{ type: 'message', id: 'request', parentId: null,
      message: { role: 'user', content: 'private synthetic task text' } }];
    const sessionFile = join(root, 'parent.jsonl');
    writeFileSync(sessionFile, branch.map(x => JSON.stringify(x)).join('\n'));
    const notices = [];
    const ctx = { cwd: root, ui: { notify: (...args) => notices.push(args) },
      sessionManager: { getBranch: () => branch, getSessionFile: () => sessionFile } };
    loaded.runtime.appendEntry = (customType, data) => branch.push({ type: 'custom', customType, data, id: 'mode' });
    let notifyResolve;
    const results = [];
    const notification = new Promise(resolve => { notifyResolve = resolve; });
    loaded.runtime.sendMessage = (message, options) => {
      results.push(message.details);
      notifyResolve({ message, options });
    };
    const emit = async name => { for (const fn of extension.handlers.get(name) ?? []) await fn({}, ctx); };
    await emit('session_start');
    const command = extension.commands.get('delegation').handler;
    const tool = extension.tools.get('delegate').definition;
    const context = extension.handlers.get('context')[0];
    const indexed = context({ messages: [] }, ctx);
    assert.match(indexed.messages[0].content, /"messageId":"request"/);
    assert.ok(!indexed.messages[0].content.includes('private synthetic task text'));
    await command('off', ctx);
    assert.equal(context({ messages: [] }, ctx), undefined);
    await assert.rejects(tool.execute('t', {}, undefined, undefined, ctx), /off/);
    await emit('session_start'); // Restores persisted off mode.
    await assert.rejects(tool.execute('t', {}, undefined, undefined, ctx), /off/);
    await command('on', ctx);
    const result = await tool.execute('t', {}, undefined, undefined, ctx);
    assert.equal(result.details.pointer.messageId, 'request');
    assert.ok(!JSON.stringify(result).includes('private synthetic task text'));
    const { message, options } = await notification;
    assert.equal(message.details.status, 'finished');
    assert.equal(options.deliverAs, 'followUp');
    assert.equal(options.triggerTurn, true);
    // Multiple calls can address disjoint portions of an earlier request.
    branch.push({ type: 'message', id: 'newer', message: { role: 'user', content: 'A newer request.' } });
    const concurrentDone = new Promise(resolve => {
      loaded.runtime.sendMessage = message => {
        results.push(message.details);
        if (results.length === 3) resolve();
      };
    });
    const assignments = await Promise.all([
      tool.execute('range1', { messageId: 'request', start: 0, end: 7 }, undefined, undefined, ctx),
      tool.execute('range2', { messageId: 'request', start: 8, end: 17 }, undefined, undefined, ctx),
    ]);
    assert.notEqual(assignments[0].details.id, assignments[1].details.id);
    await concurrentDone;
    for (let i = 0; i < assignments.length; i++) {
      const pointer = assignments[i].details.pointer;
      assert.equal(pointer.messageId, 'request');
      assert.equal(pointer.contextLeafId, 'newer');
      const completion = results.find(result => result.id === assignments[i].details.id);
      const fixture = JSON.parse(readFileSync(completion.sessionFile, 'utf8'));
      assert.ok(fixture.args.at(-1).includes(JSON.stringify(pointer)));
      assert.ok(!fixture.args.at(-1).includes('private synthetic task text'));
    }
    process.env.FIXTURE_MODE = 'wait';
    const pending = await tool.execute('t2', {}, undefined, undefined, ctx);
    assert.ok(pending.details.id);
    await emit('session_shutdown');
    await command('status', ctx);
    assert.match(notices.at(-1)[0], /Running: none/);
    process.env.PI_DELEGATE_CHILD = '1';
    const child = await loadExtensions([entryPath], root);
    assert.deepEqual(child.errors, []);
    assert.equal(child.extensions[0].tools.size, 0);
    assert.equal(child.extensions[0].handlers.size, 0);
  });
