Start one pi agent run and answer at once with its handle (`pi-run-handle/1`); the run carries on without you. It takes `pi_agent`'s arguments, plus `key`. The handle's `taskId` is the run's id: pass it to `pi_agent_wait` to collect the result. A refused start answers a `pi-agent-result/2` refusal, and nothing runs.

`lane` queues the run behind the runs already started in that lane; it launches when they have settled. With `needs_success: true` it launches only if the lane's previous run completed, and is otherwise refused `lane-predecessor-failed`. A run that waited in a lane is checked against the operator's policy again when it launches, and can be refused then.

Starting again with the same `key` and the same arguments answers the same run, in its current state; the same key with different arguments is refused. Keys last as long as the server.
