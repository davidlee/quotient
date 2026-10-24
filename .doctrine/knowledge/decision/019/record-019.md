# DEC-019: Form families take env and secretEnv; secrets fail closed and travel over a launch-allocated descriptor; network on by default

<!-- Knowledge record body — context, detail, links. The structured, queried
     fields live in the sister `record-NNN.toml`; this prose is free-form and is
     never structurally parsed (the storage rule). -->

Amended 2026-10-24 (operator) after the pi review (.doctrine/slice/003/research/raw/review-decs-014-022.md) F-8: the reserved FD 22 is replaced by a bash-allocated descriptor, as jail.nix's own closure binds do (bind-nix-store-runtime-closure.nix:73-74), so no caller --args can collide with it.