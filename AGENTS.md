# Development

- Delegation has exactly two modes: `on` and `off`, with `off` as the default. Do not add extra modes or deprecated aliases; when a feature is explicitly removed, remove its named compatibility paths, fixtures, and documentation too.
- Keep mode validation behavior-based using the installed Pi loader and fixture subprocesses, without model calls.
