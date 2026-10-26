In `serve` (src/server/server.ts) the input is read with `for await (const chunk of input)`. Node may emit the
input's `end` event while the consumer is still dispatching lines from a chunk it already received. So a flag set
"the moment the trigger is observed" (design sec-6: `closed` at `end`) is set *before* "the reader reached EOF".

Consequences:
- With the `dispatchLines` guard (`!context.closed`), lines a client sent before closing stdin may or may not be
  dispatched. Correct under DEC-103 (the client is gone), but nondeterministic.
- The order is environment-timed. The same Readable gave `end` first in a standalone probe and last under
  `node --test`. A test asserting EOF ordering can pass vacuously. Prove the guard through the signal path
  instead (abort from inside the output's first write), as server.test "the shutdown signal stops dispatch at
  once" does.
- A client that writes and closes in one breath (`printf req | quotient`) may get no replies. The test rig's
  converse() and scripts/pack-check wait for replies before closing, so they are unaffected.
