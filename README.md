# tsym

Symbol-level reading of a TypeScript codebase, from the compiler's own resolution.

`tsym` answers questions about TypeScript symbols — where something is declared, what its type resolves to, who calls it, what it calls, what implements it — through a resident bundled TypeScript 7 process and its persisted index rather than by matching text. The answers come from the same program the compiler builds, so they can be acted on without re-reading files to confirm.

Output is one named XML block on stdout per call, with a one-line receipt on stderr. It is written for agents first: `-h` on any command prints a machine-readable description of its arguments, flags, and output contract.

## Install

```bash
npm install -g @crouton-kit/tsym
```

Requires Node 22.13 or newer (the resident server locks its per-workspace slot with `node:sqlite`).

## Commands

| Command | What it answers |
| --- | --- |
| `tsym outline` | Structure of a file, a directory, or the whole repository. |
| `tsym find <name>` | The canonical address of a declaration. |
| `tsym show <target>` | The declaration's source text. |
| `tsym type <target>` | Resolved type, signature, and doc comment. |
| `tsym inspect <target>` | References, callers, calls, and implementations. |
| `tsym search <pattern>` | Structural syntax search (ast-grep patterns). |
| `tsym check` | Semantic and syntactic diagnostics. |
| `tsym rename <target> <new>` | Rename a symbol across the program. |
| `tsym server` | Status, reload, and stop for the resident process. |

Every printed `path:line:col` address is accepted by every symbol command, so an address from `find`, `outline`, or `inspect` can be passed straight to `show` or `type`.

```bash
tsym find reviveNode
tsym inspect reviveNode --only callers --each 3
tsym server status
```

## The resident server

A semantic command starts one resident process per workspace root and leaves it running, so the second and later commands reuse the loaded program and persisted index. It exits on its own after an idle period. `tsym server status` reports the process, memory, bundled TypeScript 7 version, store path, indexed commit, selected-scope counts, files outside configured projects, index state, and last index duration; `tsym server reload` forces a full index rebuild after a branch switch or dependency install; `tsym server stop` ends it.

The bundled TypeScript 7 process is always used, so `tsym` works in a checkout with no dependencies installed.

## Using it from crtr

`tsym` is available inside [crtr](https://www.npmjs.com/package/@north-light/crouter) as `crtr tsym` via the `tsym` plugin in the crouter official marketplace. The plugin passes through to this executable, so it must be on `PATH`. Prose output of `show`, `type`, or `outline` may be preceded by an `<auto-loaded-context>` block when run inside a crtr node.

## License

MIT
