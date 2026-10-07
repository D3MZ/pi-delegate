import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Optional harness integration, using an installed Pi (no model calls).
const piPackage = process.env.PI_DELEGATE_PI_PACKAGE;
test('command autocomplete exposes one delegation control across prefixes and reloads',
  { skip: !piPackage }, async t => {
    const root = mkdtempSync(join(tmpdir(), 'pi-delegate-menu-'));
    const child = process.env.PI_DELEGATE_CHILD;
    delete process.env.PI_DELEGATE_CHILD;
    t.after(() => {
      if (child === undefined) delete process.env.PI_DELEGATE_CHILD;
      else process.env.PI_DELEGATE_CHILD = child;
      rmSync(root, { recursive: true, force: true });
    });
    const { loadExtensions } = await import(pathToFileURL(join(piPackage, 'dist/core/extensions/loader.js')));
    const { CombinedAutocompleteProvider } = await import(pathToFileURL(join(piPackage, '../pi-tui/dist/autocomplete.js')));
    const entryPath = fileURLToPath(new URL('../src/extension.ts', import.meta.url));
    for (let load = 0; load < 2; load++) {
      const loaded = await loadExtensions([entryPath], root);
      assert.deepEqual(loaded.errors, []);
      const commands = [...loaded.extensions[0].commands].map(([name, command]) => ({
        name, description: command.description,
      }));
      const provider = new CombinedAutocompleteProvider(commands, root);
      for (const prefix of ['/', '/d', '/de', '/del', '/dele', '/delegate']) {
        const suggestions = await provider.getSuggestions([prefix], 0, prefix.length, {
          signal: new AbortController().signal,
        });
        assert.equal(suggestions?.items.length, 1, `one control for ${prefix} on load ${load}`);
        assert.equal(suggestions.items[0].value, 'delegate');
      }
    }
  });
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
    const command = extension.commands.get('delegate').handler;
    await assert.rejects(command('invalid', ctx), /Use \/delegate on\|off\|status or \/delegate cancel/);
    await command('status', ctx);
    assert.match(notices.at(-1)[0], /^Delegate on\./);
    const tool = extension.tools.get('delegate').definition;
    const { normalizeBuildSystemPromptOptions, buildSystemPromptSections, diffSystemPromptSections } =
      await import(pathToFileURL(join(piPackage, 'dist/core/system-prompt.js')));
    const policyHandler = extension.handlers.get('before_agent_start')[0];
    const policyContext = {
      ...ctx, sessionManager: { ...ctx.sessionManager,
        getBranch: () => { throw new Error('Policy must not enumerate messages'); } },
    };
    const promptEvent = { systemPromptOptions: normalizeBuildSystemPromptOptions({ cwd: root,
      sections: { other_extension: 'Keep this section' } }) };
    assert.equal(policyHandler(promptEvent, policyContext), undefined, 'no persisted custom message');
    const policy = promptEvent.systemPromptOptions.sections.pi_delegate_policy;
    const firstPrompt = buildSystemPromptSections(promptEvent.systemPromptOptions);
    for (let turn = 0; turn < 20; turn++) {
      assert.equal(policyHandler(promptEvent, policyContext), undefined);
      assert.equal(diffSystemPromptSections(firstPrompt,
        buildSystemPromptSections(promptEvent.systemPromptOptions)), undefined, 'no repeated prompt delta');
    }
    assert.equal(promptEvent.systemPromptOptions.sections.other_extension, 'Keep this section');
    const messages = [
      { role: 'user', content: 'Keep user' },
      { role: 'custom', customType: 'pi-delegate-policy', content: 'old ON policy' },
      { role: 'custom', customType: 'pi-delegate-result', content: 'Keep result' },
      { role: 'custom', customType: 'pi-delegate-policy', content: 'old OFF policy' },
      { role: 'assistant', content: 'Keep assistant' },
      { role: 'custom', customType: 'other-extension', content: 'Keep other' },
    ];
    const original = structuredClone(messages);
    const filterContext = extension.handlers.get('context')[0];
    const filtered = filterContext({ messages }).messages;
    assert.deepEqual(filtered, [messages[0], messages[2], messages[4], messages[5]]);
    assert.deepEqual(messages, original, 'history not mutated');
    assert.deepEqual(filterContext({ messages: filtered }).messages, filtered);
    assert.ok(policy.includes(JSON.stringify(sessionFile)));
    assert.match(policy, /top-level user-entry ID/);
    assert.match(policy, /worker-ID:Completed/);
    assert.match(policy, /worker-ID:Error/);
    assert.doesNotMatch(policy, /worker-ID:(Success|Failed)|not that its task was verified/);
    assert.ok(!policy.includes('private synthetic task text'));
    assert.ok(!policy.includes('"messageId":"request"'));
    await command('off', ctx);
    policyHandler(promptEvent, policyContext);
    assert.match(promptEvent.systemPromptOptions.sections.pi_delegate_policy, /Delegate mode is OFF/);
    assert.doesNotMatch(promptEvent.systemPromptOptions.sections.pi_delegate_policy, /Delegate mode is ON/);
    const offPrompt = buildSystemPromptSections(promptEvent.systemPromptOptions);
    assert.deepEqual(Object.keys(diffSystemPromptSections(firstPrompt, offPrompt)), ['pi_delegate_policy']);
    await assert.rejects(tool.execute('t', {}, undefined, undefined, ctx), /off/);
    await emit('session_start'); // Restores persisted off mode.
    await assert.rejects(tool.execute('t', {}, undefined, undefined, ctx), /off/);
    await command('on', ctx);
    policyHandler(promptEvent, policyContext);
    assert.equal(promptEvent.systemPromptOptions.sections.pi_delegate_policy, policy);
    const changedSession = { ...policyContext, sessionManager: { ...policyContext.sessionManager,
      getSessionFile: () => join(root, 'other.jsonl') } };
    policyHandler(promptEvent, changedSession);
    assert.ok(promptEvent.systemPromptOptions.sections.pi_delegate_policy.includes(JSON.stringify(join(root, 'other.jsonl'))));
    assert.ok(!promptEvent.systemPromptOptions.sections.pi_delegate_policy.includes(JSON.stringify(sessionFile)));
    policyHandler(promptEvent, policyContext);
    const result = await tool.execute('t', {}, undefined, undefined, ctx);
    assert.equal(result.details.pointer.messageId, 'request');
    assert.ok(!JSON.stringify(result).includes('private synthetic task text'));
    const { message, options } = await notification;
    assert.equal(message.details.status, 'finished');
    assert.equal(message.content, `${message.details.id}:Completed`);
    assert.ok(!message.content.includes('private synthetic task text'));
    assert.equal(message.display, true);
    assert.equal(options.deliverAs, undefined);
    assert.equal(options.triggerTurn, false);
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
    assert.equal(tool.parameters.properties.returnLastResponse.type, 'boolean');
    for (const [mode, returnLastResponse, expected] of [
      ['normal', true, 'Completed last response: Worker result 😀'],
      ['normal', false, 'Completed'],
      ['blocked', false, 'Completed'],
      ['blocked', true, 'Completed last response: Blocked: cannot finish'],
      ['length', false, 'Error'],
      ['length', true, 'Error last response: Worker result 😀'],
      ['tool-error', false, 'Error\nError: WebSocket error'],
      ['tool-error', true, 'Error last response: Last real response\nError: WebSocket error'],
      ['empty-error', true, 'Error last response: (no assistant text response)\nError: WebSocket error'],
    ]) {
      process.env.FIXTURE_MODE = mode;
      const done = new Promise(resolve => {
        loaded.runtime.sendMessage = (message, options) => resolve({ message, options });
      });
      const started = await tool.execute('option', { returnLastResponse }, undefined, undefined, ctx);
      const { message: completed, options } = await done;
      assert.equal(completed.content, `${started.details.id}:${expected}`);
      assert.equal(options.triggerTurn, !['normal', 'blocked'].includes(mode));
      assert.equal(completed.display, true);
      assert.equal(options.deliverAs, ['normal', 'blocked'].includes(mode) ? undefined : 'followUp');
      assert.equal('returnLastResponse' in started.details.pointer, false);
    }
    const callbackTool = extension.tools.get('delegate_callback').definition;
    assert.equal(tool.parameters.properties.notifyOnCompletion.type, 'boolean');
    assert.match(policy, /notifyOnCompletion:true/);
    assert.match(policy, /delegate_callback/);
    assert.match(policy, /previously user-requested sequence/);
    await assert.rejects(callbackTool.execute('unknown', { id: 'unknown' }, undefined, undefined, ctx), /Unknown worker/);
    const recorded = [];
    let completionResolve;
    loaded.runtime.sendMessage = (message, options) => {
      recorded.push({ message, options });
      branch.push({ type: 'custom_message', customType: message.customType,
        details: message.details, content: message.content, id: `completion-${recorded.length}` });
      completionResolve?.({ message, options });
    };
    const launchAndFinish = async args => {
      const done = new Promise(resolve => { completionResolve = resolve; });
      const started = await tool.execute('callback-launch', args, undefined, undefined, ctx);
      return { started, completed: await done };
    };
    process.env.FIXTURE_MODE = 'normal';
    const optedIn = await launchAndFinish({ notifyOnCompletion: true, returnLastResponse: true });
    assert.equal(optedIn.completed.options.triggerTurn, true);
    assert.equal(optedIn.completed.options.deliverAs, 'followUp');
    assert.match(optedIn.completed.message.content, /Worker result/);
    assert.equal('notifyOnCompletion' in optedIn.started.details.pointer, false);
    const passive = await launchAndFinish({});
    assert.equal(passive.completed.options.triggerTurn, false);
    await command('off', ctx); // Callback subscription does not start a task.
    await callbackTool.execute('late', { id: passive.started.details.id }, undefined, undefined, ctx);
    assert.equal(recorded.at(-1).options.triggerTurn, true);
    assert.equal(recorded.at(-1).options.deliverAs, 'followUp');
    assert.match(recorded.at(-1).message.content, /Worker result/);
    const count = recorded.length;
    await callbackTool.execute('duplicate', { id: passive.started.details.id }, undefined, undefined, ctx);
    assert.equal(recorded.length, count, 'no duplicate wake-up');
    await command('on', ctx);
    const runningDone = new Promise(resolve => { completionResolve = resolve; });
    const subscribed = await tool.execute('running', {}, undefined, undefined, ctx);
    await callbackTool.execute('subscribe', { id: subscribed.details.id }, undefined, undefined, ctx);
    assert.equal((await runningDone).options.triggerTurn, true);
    const disabledDone = new Promise(resolve => { completionResolve = resolve; });
    const disabled = await tool.execute('disable', { notifyOnCompletion: true }, undefined, undefined, ctx);
    await callbackTool.execute('disable-callback', { id: disabled.details.id, notifyOnCompletion: false }, undefined, undefined, ctx);
    assert.equal((await disabledDone).options.triggerTurn, false);
    process.env.FIXTURE_MODE = 'tool-error';
    assert.equal((await launchAndFinish({ notifyOnCompletion: false })).completed.options.triggerTurn, false);
    process.env.FIXTURE_MODE = 'normal';
    const historical = await launchAndFinish({});
    // A fresh extension runtime can subscribe to persisted completed results.
    const reloaded = await loadExtensions([entryPath], root);
    assert.deepEqual(reloaded.errors, []);
    const replay = [];
    reloaded.runtime.sendMessage = (message, options) => replay.push({ message, options });
    const restoredCallback = reloaded.extensions[0].tools.get('delegate_callback').definition;
    await restoredCallback.execute('restored', { id: historical.started.details.id }, undefined, undefined, ctx);
    assert.equal(replay.length, 1);
    assert.equal(replay[0].options.triggerTurn, true);
    assert.match(replay[0].message.content, /Worker result/);
    const otherSession = { ...ctx, sessionManager: { ...ctx.sessionManager,
      getSessionFile: () => join(root, 'other.jsonl'), getBranch: () => [] } };
    await assert.rejects(callbackTool.execute('foreign', { id: historical.started.details.id }, undefined, undefined, otherSession), /Unknown worker/);
    const abandoned = { ...ctx, sessionManager: { ...ctx.sessionManager, getBranch: () => branch.filter(entry => entry.type !== 'custom_message') } };
    await assert.rejects(callbackTool.execute('abandoned', { id: historical.started.details.id }, undefined, undefined, abandoned), /Unknown worker/);
    const aborted = new AbortController(); aborted.abort();
    await assert.rejects(callbackTool.execute('aborted', { id: historical.started.details.id }, aborted.signal, undefined, ctx), /cancelled/);
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
