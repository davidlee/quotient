Wait for runs to settle, then answer `pi-agent-wait/1`: an entry per run, holding a settled run's `pi-agent-result/2` as its `result`. Waiting changes nothing.

Name the runs you hold in `runs`, or whole lanes in `lanes`. With neither, it waits on every run started with `pi_agent_start` that no one has acknowledged. `until` is `all` (the default) or `any`. `timeout_s` defaults to 45 and is capped at the policy's wall-clock maximum; `0` answers now. When the timeout passes first, the answer reports each run as it stands with `timed_out: true`: wait again.

Results share a byte budget (`budget_bytes`, default 65536). An entry that did not fit is `status_only` with no result: wait on it again. The first settled result is always included whole.

The loop: wait on your ids with `until: "any"`; use each result; acknowledge the runs you used with `pi_agent_ack`; drop their ids, any id listed in `unknown`, and any run whose `state` is `lost` (it has no result: its evidence is under `artifacts.dir`). Repeat until no ids are left.
