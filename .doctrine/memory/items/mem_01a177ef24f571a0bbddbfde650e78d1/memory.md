`doctrine slice verify-vt <id>` attributes a VT's `test_file` to the slice through the slice's phase-delta registry, not through commit messages. A phase implemented in the main worktree and committed by hand (e.g. pi-orchestrated, no dispatch import) shows `≈ UNATTRIBUTABLE … not modified by this slice` for every VT, even with a `feat(SL-NNN): PHASE-NN` subject.

Fix: `doctrine slice record-delta <id> <PHASE> --commit <sha>` (the phase's single commit). Observed SL-004 PHASE-01, 2026-10-26: after recording, all five VTs passed.
