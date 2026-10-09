# pi-delegate

Pointer-only background delegation for [Pi](https://github.com/earendil-works/pi).

```js
delegate({})                                       // latest user message
delegate({ messageId: "abc123" })                  // earlier request
delegate({ messageId: "abc123", start: 20, end: 90 }) // part of a request
delegate({ notifyOnCompletion: true, returnLastResponse: true }) // wake for next steps
delegate_callback({ id: "<worker-id>" })             // subscribe later; no new worker
```

The parent supplies no task text. The extension resolves the session log path,
message ID, and active thread leaf, then launches a fresh native `pi --mode json`
process. The worker reads the logs and executes the referenced request itself.
The tool returns after process startup. Completion arrives through an event,
not polling.

## Install globally

Requires Node.js 22+ and `pi` on PATH. Targets the `@earendil-works/pi-coding-agent`
harness; compatibility with other Pi distributions is not tested.

```sh
pi install git:github.com/D3MZ/pi-delegate
# Or, from a local checkout:
pi install /absolute/path/to/pi-delegate
```

Run `/reload` in existing sessions. New sessions load it automatically.
No Fabric or subagent extension dependency; no runtime npm dependencies beyond
Pi's supplied peer packages.

## Controls

- `/delegate on` — enable delegation for execution requests.
- `/delegate off` — work directly (initial setting); the tool rejects new launches.
  Explicitly requested subagents through other installed tools remain allowed.
- `/delegate status` — show mode and currently running worker IDs.
- `/delegate cancel <worker-id>` or `/delegate cancel all` — stop workers.

`/delegate` is the only command, keeping autocomplete to one menu item.
The legacy `/delegation` alias has been removed.

The mode is saved in the current session and restored on reload, including older
saved on/off choices. New sessions start off. Turning it off does not cancel
existing workers. Routing when on is an instruction to the parent model, not
automatic dispatch. Questions and review discussion remain in the parent
conversation.

Both modes follow the project's validation, commit, and push-approval rules.
Explicitly requested subagent orchestration stays in the parent in either mode;
workers may not spawn subagents themselves.

The policy lives in a named system-prompt section, not a new chat entry each turn.
Unchanged turns add no policy delta; mode/session changes replace that section.
Legacy `pi-delegate-policy` messages are filtered from model context without
rewriting session logs. Run `/reload` to apply this to an existing session.

## Pointer contract

`messageId` identifies the top-level `id` of a **user-message entry on the active
branch**, not an ID inside its `message` object or a model-generated conversation
label. For the current request, use `delegate({})` without specifying an ID.
The parent session must already be persisted.

The parent receives only a short lookup instruction and the session-log path,
not a message index. For earlier requests, it reads the log on demand to find
the exact top-level user-entry ID. The tool validates that ID against the active
branch when called; latest-message delegation needs no lookup.

Supply both `start` and `end`, or neither. Offsets are zero-based Unicode code
points, end-exclusive, over text blocks joined with `\n`. For example, the emoji
in `a😀bc` occupies `[1, 2)`. A range limits the assignment, not the context the
worker may read. Image blocks remain available in the source log. An explicitly
context-edited target is rejected; submit the intended request as a new message.

The worker receives a fixed instruction plus pointers, never an agent-written
summary, copied request, or handoff file. It reconstructs the captured branch
through `parentId`, including subsequent reviews already present at launch.
New messages after launch do not silently change its assignment. Issue a new
assignment after the worker finishes to incorporate further feedback.

## Defaults and lifecycle

Children use the same working directory and normal Pi startup configuration:
model, thinking, authentication, global resources, and trusted project resources.
They do **not** inherit the parent's in-session model overrides or command-line-only
extensions. Pi defaults are not necessarily the parent's currently selected model.

Child sessions and stderr are retained locally under
`<agent-dir>/delegate-runs/<worker-id>/` (normally `~/.pi/agent/delegate-runs/`).
These files can contain private data; nothing is uploaded. Each worker gets a
separate `.jsonl` session file. Its first user message holds the original parent
log/message/range pointer; the rest records the worker's investigation, actions,
and final response. The file alone identifies the run—no start/stop offsets or
second task reference are needed.

On exit, clean worker completions are displayed in chat without triggering a model call
and remain in context for the next normal turn. If the parent is streaming, Pi safely
appends them when its current turn ends. Failures wake the parent with a follow-up turn
by default. Set `notifyOnCompletion: true` on `delegate` to wake the parent on any
completion, for example to continue a user-requested audit/publish sequence.
Set it to `false` for passive display even on errors. This controls model wake-up,
not whether a completion is displayed; `returnLastResponse` independently controls
whether the worker's answer is included.

Subscribe or change that choice later with the **parent-side** tool:

```js
delegate_callback({ id: "<worker-id>" }) // defaults: wake + include last response
delegate_callback({ id: "<worker-id>", notifyOnCompletion: false }) // disable wake
```

For a running task, this updates its eventual notification. For an already completed
task with a result on the active session branch, it sends an immediate follow-up
with the stored result, without rerunning the task. Repeated subscriptions do not
wake again within the same runtime. Completed results remain available after reload;
live workers still do not survive reload. Callbacks work even with delegate mode off.
They never execute a next task by themselves: the awakened parent reviews the result
and continues only the sequence the user already authorized. They are not a polling
or waiting API. Unknown IDs and other-session/abandoned-branch results are rejected.

Use `delegate({ returnLastResponse: true })` when the parent needs the worker's
answer or summary, including on failure. The option defaults to false; it forwards
only assistant text, never tool calls or tool results.

Default notifications:

```text
cb9064da-6b6f-49d7-9cba-e83731e9d0c1:Completed
# or
cb9064da-6b6f-49d7-9cba-e83731e9d0c1:Error
# with returnLastResponse: true:
cb9064da-6b6f-49d7-9cba-e83731e9d0c1:Completed last response: <worker's last response>
```

The worker ends with a final result or blocker; there is no child callback tool.
Completed indicates a clean exit after a final response. The response explains
the result or blocker; use `returnLastResponse: true` to pass it to the parent.
Cancellation, incomplete output, provider errors, and process failures produce Error. If forwarding is requested
but no assistant text exists, the notification says `(no assistant text response)`. Provider errors
such as `WebSocket error` are included as diagnostics, not passed off as worker
responses. Logs and process diagnostics remain in notification details for
optional investigation. A failure to spawn Pi is returned immediately as a tool error.

Children inherit `PI_DELEGATE_CHILD=1`, which disables the parent delegation tool inside them.
The fixed worker instruction requires direct execution and forbids spawning any
agents, even when the assigned request asks for them. Such a misrouted request
must be reported as blocked; the parent owns explicitly requested subagent fanout.
This is not a sandbox: the no-subagent rule is an instruction, and other installed
extensions and shell access retain their usual powers.

Workers share the repository, without worktrees. Multiple calls are suitable
for independent work; avoid overlapping edits. Closing/reloading/switching the
parent session cancels its workers (TERM, then KILL after two seconds on POSIX).
This initial version does not support detached survival or notification recovery
after a parent crash. On Windows only the direct child is signalled; descendant
process cleanup is not guaranteed. Cancelling cannot roll back edits already made.

## Development

```sh
npm test
# Also exercise the installed Pi loader, tool, toggle, and notifications:
PI_DELEGATE_PI_PACKAGE=/path/to/node_modules/@earendil-works/pi-coding-agent npm test
pi -e ./src/extension.ts
```

The default tests use synthetic logs and native fixture subprocesses without
credentials or model calls. To exercise the globally installed extension with
real parent and worker models (uses your normal credentials and incurs usage):

```sh
npm run test:live
```

Live tests create temporary workspaces outside the checkout. They verify that
the parent answers during background work, resumes on completion without polling,
and launches two workers using ranges of an earlier message. Synthetic session
logs and diagnostics stay local; paths are printed for inspection. MIT licensed.
