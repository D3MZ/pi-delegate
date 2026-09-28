# pi-delegate

Pointer-only background delegation for [Pi](https://github.com/earendil-works/pi).

```js
delegate({})                                       // latest user message
delegate({ messageId: "abc123" })                  // earlier request
delegate({ messageId: "abc123", start: 20, end: 90 }) // part of a request
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

- `/delegation on` — delegate execution requests by default (initial setting).
- `/delegation off` — work directly; the tool rejects new launches.
- `/delegation status` — show mode and currently running worker IDs.
- `/delegation cancel <worker-id>` or `/delegation cancel all` — stop workers.

The mode is saved in the current session and restored on reload. Turning it off
does not cancel existing workers. The default-use policy is an instruction to
the parent model, not automatic dispatch of every user message. Questions and
reviews remain in the parent conversation.

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

On exit, the extension wakes the parent with a minimal follow-up callback:

```text
finished: /absolute/path/to/child-session.jsonl
```

Failure, cancellation, and incomplete runs retain their respective status. If
Pi exits before creating a session log, the callback points to stderr instead.
A failure to spawn Pi is returned immediately as a tool error. No task text, worker summary, or repeated instructions are included.
A finished process is not proof of task success: its final response may report
a blocker. The parent can read the referenced log to review the result.

Children inherit `PI_DELEGATE_CHILD=1`, which disables this extension inside them.
The fixed worker instruction also forbids further delegation. This is not a
sandbox: other installed extensions and shell access retain their usual powers.

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
