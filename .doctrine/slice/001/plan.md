# Implementation Plan SL-001: Measure peak request context for token ceilings

Prose companion to `plan.toml`. Narrative only — no queried data lives here
(the storage rule); the phase list, criteria, verification, and links are
authored in the TOML. Use this for the plan's rationale and sequencing.
<!-- Reference forms: `lib:reference/glossary.md` § reference forms. -->

## Overview

Implement the locked design through the existing reducer, gate and result
seams. DEC-001 through DEC-006 govern semantics; CON-001 fixes the release at
0.2.0. The phase objectives and criteria in `plan.toml` own execution
obligations; this companion explains their boundaries.

## Sequencing & Rationale

Begin with internal context observation in the shared tally. Establish request
classification, footprint arithmetic, placeholder handling and context gaps
without changing public status, policy, gate or cost semantics. This keeps the
preparatory phase green and prevents a partly migrated public contract.

Then make an atomic public cutover: policy/caller fields, gate enforcement,
cost/token validity, status/result schemas, audit/CLI output, active contracts,
help and fixtures move together. Splitting these interfaces would reinterpret
the old token field or compare incompatible schemas in active drift tests.
The phase is larger because its interfaces form one observable change;
establish failing behavioral cases first and group repairs by shared owner.

Finish with release metadata and packaging/probe scripts. The installed-package
gate uses a stub provider and clones HEAD. Commit the intended candidate before
running it, retain the tested commit in execution evidence, and repeat it after
repairs. Passing an older HEAD does not verify uncommitted 0.2.0 code. This
commit boundary belongs to verification rather than being deferred to closure.

Keep phases serial because they share accumulator, schema and fixture owners.
Any later requested worker/worktree strategy must preserve those dependencies.

## Notes

All RV-001 findings use prose review routes; there are no unresolved
demonstrate/probe/control obligations to transcribe from their responses.
The plan includes their resulting counter, contract-prose, buffered-drain,
script-migration and installed-package checks. ASM-001 retains the runtime
limitation; it is not an already executed provider/session probe.

VT source keywords are Doctrine's discoverability floor, not proof that a test
passed. Execute the meaningful behavioral cases and phase suite/type-check/build
checks, preserving unrelated invariants. Do not add tests merely to mirror an
arithmetic expression or pin documentation wording.

Fixtures prove quotient arithmetic/protocol behavior. Exact launched-pi
normalization and resumed historical-message behavior require actual supported
runtime evidence before they can be claimed validated. Carry the assumption
explicitly; contradictory evidence requires reopening the design.

After the implementation phases, conduct the audit. Then remind the user to
run `npm publish` for 0.2.0 and obtain its outcome before reconciliation.
Publication is outside phase completion criteria: requiring it to finish an
implementation phase would put it before audit, contrary to the user's
instruction. The user owns publication.

Plan approval precedes implementation. Materialising sheets does not authorize
execution, publication or deployment.
