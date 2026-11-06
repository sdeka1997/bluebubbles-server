# Find My live-location bridge

This is an on-demand, Mac-local bridge to Find My's own live-location calls.
It is loaded only when a selected person is being tracked. It accepts exactly
`start` and `stop` over a Unix socket restricted to the logged-in user, and
every request must carry the fresh random token supplied when Find My launched.

The bridge matches the opaque Apple friend id, never a display name. Starting a
second friend stops the first. The server maps a client's Apple handle to that
opaque id using the existing Find My roster.

## Build

On a Mac with Xcode command-line tools:

```sh
bash build.sh
```

The checked-in dylibs target the Intel server Mac. `build.sh` recreates and
ad-hoc signs them, verifies their signatures and architecture, and refuses a
production binary containing the test-only manager setter.

## Test

```sh
bash test/run.sh
```

The test compiles a fake `FMFCore` framework with Apple-compatible library
evolution, links a fake manager into a host process, and exercises the real
bridge end to end: socket permissions, token rejection, fragmented and bounded
requests, an absolute deadline that defeats idle and slow-drip clients,
disconnect-before-reply safety, missing and duplicate ids, display-name
rejection, padded-id matching, main-thread roster/start/stop calls,
retained-manager lifetime, start, switch, idempotent stop, unsupported commands
and cleanup.
No Apple process or data is involved.

The production bridge finds Find My's one `FMFManager` in its process. It looks
every second from load until found (it appears about a second into Find My's
launch), and again when a command arrives, so live location can start within
seconds of Find My opening. That scan and Apple's typed start/stop calls were
separately proven in a reversible Find My injection test; the protocol test's
host supplies its manager through a symbol compiled only under `BBFM_TEST`,
and `test_scan.py` checks that the bridge finds a manager by itself.