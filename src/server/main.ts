// The entry point `bin/pi-mcp` execs. It wires the process's own streams and
// environment to the server and nothing else: the launch environment IS the
// configuration (no argv, no config discovery), and stdin EOF ends the process
// cleanly because `serve` resolves with nothing left to wait on.
import { serve } from './server.ts';

await serve(process.stdin, process.stdout, process.env);
