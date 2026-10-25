# DEC-034: env and secretEnv refuse QUOTIENT_* names and HOME

<!-- Knowledge record body — context, detail, links. The structured, queried
     fields live in the sister `record-NNN.toml`; this prose is free-form and is
     never structurally parsed (the storage rule). -->
## Decision
mkFormFamily refuses, at evaluation, an `env` or `secretEnv` name that starts with `QUOTIENT_` or equals `HOME`. Check rule (e) also refuses a `QUOTIENT_` name in SECRET_ENV_NAMES.
## Context
RV-011 F-13/F-14: `secretEnv.QUOTIENT_DEBUG` reached pi through the secret descriptor; `env.HOME` overrode the forwarded home while mounts still targeted the host home.

## Basis
Operator, in session 2026-10-26: chose option A for RV-011 (fix inside SL-003), then "agreed" to the proposed amendments D1–D9 (D1 in its bash-as-parser form; D3 "yeah makes sense", with `/`).
