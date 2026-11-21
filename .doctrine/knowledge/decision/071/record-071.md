Evidence: the probe sections of IDE-008 (`doctrine show IDE-008`). Observed and inferred claims are separated there.


## Note: profiles depart from point 3 in flakes (2026-11-05)

flakes:SL-024 implements this decision with one departure, recorded as flakes:DEC-126. Point 3 says policy and profiles are generated into the store. There, `policy.json` is, but the profiles are not: `~/.config/quotient/profiles/*.md` are tracked in the home repo outside `flakes/`, so no flake can read them. The jail binds a read-only store directory at `~/.config/quotient`, and binds the host's `profiles` directory read-only onto it.

Point 3's purpose holds: nothing in the jail can write either, and a real jail's writes to `approvals.json`, `policy.json` and the profiles failed with `Read-only file system`. With a profiles directory empty or missing the server starts and a call is refused `profile-unknown`.
