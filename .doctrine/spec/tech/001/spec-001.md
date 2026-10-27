# SPEC-001: quotient system context

<!-- Reference forms: `lib:reference/glossary.md` § reference forms. -->

## Overview

quotient is one process, the `quotient` binary, sitting between an MCP client
(the calling agent's harness) and pi delegate processes it launches inside
operator-chosen forms. Product intent: PRD-001.

```
            operator
               │ writes policy, profiles, help overrides;
               │ approves project forms (quotient allow)
               ▼
   ┌───────── operator config (XDG) ─────────┐
   │ policy.json  approvals.json  profiles/  │   read-only to every delegate
   │ help/                                   │
   └─────────────────────────────────────────┘
               │ read
MCP client ──stdio JSON-RPC──▶ quotient ──exec──▶ form ──exec──▶ pi ──▶ model provider
(calling agent)                   │          (confines)     (delegate)
                                  │ writes
                                  ▼
                 run dir: evidence, result.json, attempts.jsonl   (unreachable from runs)
                 session home: pi sessions                         (one writable per run)
```

Actors:

- **Calling agent** — speaks MCP to quotient through its client (Claude Code,
  Codex, others). Holds no authority beyond what a call may narrow.
- **Operator** — the human owning the host configuration. Holds all authority.
- **Delegate** — the pi process of one run. Untrusted.

External systems:

- **MCP client** — owns quotient's lifetime through stdin.
- **pi** — the agent harness quotient launches; a prerequisite, not a
  dependency.
- **Form** — an operator-chosen executable that confines one pi process.
  Defined by an interface, not shipped (SPEC-004).
- **Model provider / broker** — reached by pi, never by quotient.

Containers:

| container | spec | what it is |
|---|---|---|
| quotient process | SPEC-002 | the stdio MCP server and run engine, plus the operator verbs of the same binary |

The process's components: admission and the confinement policy (SPEC-003),
the form interface (SPEC-004), configuration, profiles and help (SPEC-005),
and the command-line verbs (SPEC-006).

## Responsibilities

- Name the system's actors, external systems and single container, and where
  trust boundaries fall between them.

## Concerns

- **Trust boundary.** Everything left of the form is trusted; the delegate and
  everything it writes are not. The operator config, the run directory and
  other sessions sit outside every delegate's writable view.
- **Lifetime.** The client's stdin is the server's lifeline; nothing quotient
  starts outlives it.
- **Shared state between servers.** Several quotient processes on one host may
  share the run directory and session home; coordination between them is
  through the filesystem only.

## Hypotheses

- One container suffices: the CLI verbs and the server share configuration
  and the approvals store, and nothing needs a second long-lived process.

## Decisions

- quotient never talks to a model provider; spend is observed through pi's
  event stream (SPEC-002).
