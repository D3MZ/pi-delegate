import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const piPackage = process.env.PI_DELEGATE_PI_PACKAGE;
test('reload refreshes worker and pointer dependencies in the same Pi process',
  { skip: !piPackage }, async t => {
    const root = mkdtempSync(join(tmpdir(), 'pi-delegate-reload-'));
    const child = process.env.PI_DELEGATE_CHILD;
    delete process.env.PI_DELEGATE_CHILD;
    t.after(() => {
      if (child === undefined) delete process.env.PI_DELEGATE_CHILD;
      else process.env.PI_DELEGATE_CHILD = child;
      rmSync(root, { recursive: true, force: true });
    });
    const entry = join(root, 'extension.ts');
    writeFileSync(entry, readFileSync(new URL('../src/extension.ts', import.meta.url)));
    const sessionFile = join(root, 'parent.jsonl');
    writeFileSync(sessionFile, '{}');
    const { loadExtensions, clearExtensionCache } = await import(pathToFileURL(join(piPackage, 'dist/core/extensions/loader.js')));
    for (const version of ['before', 'after']) {
      writeFileSync(join(root, 'pointer.mjs'), `export function resolvePointer() { return { sessionFile: ${JSON.stringify(sessionFile)}, version: ${JSON.stringify(version)} }; }`);
      writeFileSync(join(root, 'runner.mjs'), `
        export function completionText() { return ${JSON.stringify(version)}; }
        export async function startWorker({pointer}) {
          if (pointer.version !== ${JSON.stringify(version)}) throw new Error('Stale pointer');
          return {id: 'worker', directory: '/tmp', done: Promise.resolve({success:true}), cancel() {}};
        }
      `);
      clearExtensionCache();
      const loaded = await loadExtensions([entry], root);
      assert.deepEqual(loaded.errors, []);
      const notification = new Promise(resolve => { loaded.runtime.sendMessage = resolve; });
      const ctx = { cwd: root, sessionManager: { getSessionFile: () => sessionFile, getBranch: () => [] }, ui: { notify() {} } };
      loaded.runtime.appendEntry = () => {};
      await loaded.extensions[0].commands.get('delegate').handler('on', ctx);
      await loaded.extensions[0].tools.get('delegate').definition.execute('test', {}, undefined, undefined, ctx);
      assert.equal((await notification).content, version);
    }
  });
