# Working agreements

## Every change

**Typecheck, lint, build.** All three, every time — not "it should compile":

```sh
pnpm typecheck && pnpm lint && pnpm build
```

`tsc` catches what the bundler does not, and the build is where a worker import
or a Turbopack resolution actually gets exercised.

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

## Git

**Never commit on your own.** Do not run `git commit`, `git push`, `git tag`, or
anything else that writes to history unless I ask for it in that same turn.
Finishing a task, getting a green run, or updating docs is not a request to
commit — leave the work in the tree and tell me what changed. Ask if you think a
commit is warranted; do not assume.

**A commit you make is mine, not yours.** When I do ask for one, author it with
the repository's configured identity (`user.name` / `user.email`) and nothing
else:

- No `Co-Authored-By: Claude ...` trailer.
- No "Generated with Claude Code" line.
- Do not pass `--author`, and do not set `GIT_AUTHOR_*` or `GIT_COMMITTER_*`.

Write the message in my voice: what changed and why, no AI attribution. The same
goes for pull request titles and bodies.
