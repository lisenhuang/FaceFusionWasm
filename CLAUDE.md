# Working agreements

<!-- AGENTS.md sits next to this file and contains only `@CLAUDE.md`. They are
     two separate files: editing one no longer changes the other. The rules
     themselves live here, not there. -->

## Every change

**Bump the version, then verify.** Both, every time — not just when it feels
significant, and not only when I remember to ask.

1. **Bump.** Raise `version` in `package.json`: patch for a fix (`1.1.1` →
   `1.1.2`), minor for a new feature. Unlike the iOS and macOS projects there is
   no separate build number here — that one semver string is the whole version,
   so it is the only thing distinguishing one deploy from the next.

2. **Typecheck, lint, build.** All three, every time — not "it should compile":

   ```sh
   pnpm typecheck && pnpm lint && pnpm build
   ```

   `tsc` catches what the bundler does not, and the build is where a worker
   import or a Turbopack resolution actually gets exercised.

Work that has not been built is not finished, and I do not want to hear it is
done until it has compiled.

## Verifying

Two harnesses, and they answer different questions. Neither replaces the other.

```sh
pnpm verify:pipeline     # the maths, against ground truth, in Node
pnpm smoke               # the browser, against a real install, in Chromium
```

**Touching anything under `src/engine/` means running `verify:pipeline`.** It
compares against values captured from the reference FaceFusion pipeline and
against the macOS app's own output, so an arithmetic regression fails the run
rather than quietly degrading every swap. A change there that has not been
verified is a change whose effect nobody knows.

`pnpm smoke` needs the app running (`pnpm build && pnpm start`). It reuses a
persistent Chromium profile under `.verify-out/profile`, so the 903 MB install
happens on the first run only; pass `--fresh` to exercise the install path
again, and `--headed` to watch it.

Both default to the macOS app's model container and self-test assets. On a
machine without those, pass `--models` and `--assets`.

## Two rules the code depends on

**`src/engine/` must not import a browser API.** That is what lets
`verify:pipeline` load the shipping modules and run them under
`onnxruntime-node`. The moment something in there reaches for `document`,
`navigator` or `OffscreenCanvas`, the pipeline can only be tested by hand.
Browser-shaped work belongs in `src/worker/`.

**Inference is serialised, deliberately.** `Serializer` in
[`src/engine/runtime.ts`](src/engine/runtime.ts) puts every `session.run` in one
queue. ONNX Runtime Web's WebGPU backend shares a command encoder across
sessions, and concurrent runs there do not fail cleanly — they produce a wrong
or failed frame. Removing the queue looks like free parallelism and is not.

## The two document pages

`/support` and `/privacy` are the URLs App Store Connect points at, and they are
the only **server** components in the app — everything else is `'use client'`
because it needs workers, WebGPU and OPFS. Keep them server-rendered: App Review
opens them without the studio, and they have to read with JavaScript off.

Every claim in `/privacy` is a claim about code that exists. If a change adds a
second network request anywhere, that page is wrong and has to change with it.

## Git

**Never commit on your own.** Do not run `git commit`, `git push`, `git tag`, or
anything else that writes to history unless I ask for it in that same turn.
Finishing a task, getting a green run, or updating docs is not a request to
commit — leave the work in the tree and tell me what changed. Ask if you think a
commit is warranted; do not assume.

### The commit is mine, and so is the name on it

When I ask you to commit, **the author and the committer are me, not you.** Take
the identity from the repository's own configuration — `git config user.name`
and `git config user.email`, currently `Ethan <lisen8018@gmail.com>` — and do
nothing that changes it:

- **Do not pass `--author`.** Do not set `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`,
  `GIT_COMMITTER_NAME` or `GIT_COMMITTER_EMAIL`.
- **Never put an assistant, bot or tool address in either field.**
  `noreply@anthropic.com`, `claude@…`, `bot@…`, `*@users.noreply.github.com`
  and anything similar are all wrong, in the author field and the committer
  field alike.
- **No `Co-Authored-By:` trailer for an AI**, and no second author of any kind.
- **No "Generated with Claude Code", "🤖", or any tool named anywhere** in the
  subject, body or trailers.

If `user.name` or `user.email` is unset, stop and ask me. Do not guess, and do
not let git fall back to the `user@hostname` identity it derives on its own —
a commit authored by `easonsmith@Mac.local` is as wrong as one authored by a
model.

After committing, check it actually landed as me:

```sh
git log -1 --format='%an <%ae> | %cn <%ce>'
```

This holds however the commit is made — the CLI, the VS Code Source Control
panel, or a generated message — and it holds for pull request titles and bodies,
issue comments and release notes too. Write the message in my voice: what
changed and why, no AI attribution.

`.vscode/git-commit-instructions.md` is the standard this repository holds
commit messages to; follow it when you write one, so a message you draft and one
the editor generates read the same.
