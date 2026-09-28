import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
const sessions = args[args.indexOf('--session-dir') + 1];
mkdirSync(sessions, { recursive: true });
writeFileSync(join(sessions, 'fixture.jsonl'), JSON.stringify({ args, child: process.env.PI_DELEGATE_CHILD }));
if (process.env.FIXTURE_MODE === 'wait') setInterval(() => {}, 1000);
else {
  const stopReason = process.env.FIXTURE_MODE === 'error' ? 'error' : 'stop';
  process.stdout.write(JSON.stringify({ type: 'message_end', message: { role: 'assistant', stopReason } }) + '\n');
  process.exitCode = process.env.FIXTURE_MODE === 'exit' ? 3 : 0;
}
