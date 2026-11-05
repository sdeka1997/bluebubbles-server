# Find My live tracking — evidence and architecture

This document records the reusable, privacy-safe findings behind the private Find My integration. It intentionally excludes account identifiers, contact names, location coordinates, credentials, decrypted records, and raw diagnostic logs.

## Proven behavior

On the target Sequoia Mac:

1. A temporary ad-hoc-signed library can be loaded into Find My at launch. A no-op constructor loaded successfully without changing Find My data.
2. Code running inside Find My can locate the app's single live `FMFCore.FMFManager` and enumerate its current `FMFFriend` values through Swift's runtime.
3. `FMFCore` exports typed dispatch thunks for:
   - `FMFManager.startLiveLocation(for:clientApp:)`
   - `FMFManager.stopLiveLocation(for:)`
   - the manager's friends and selected-friend accessors
4. A controlled call to `startLiveLocation` for one friend produced Apple's own `addHandlesToLocationStream` call with priority `.live`; `findmylocateagent` opened a `.live` subscription.
5. That friend's exact encrypted-store record received a newer fix during the live session. The same store is the source BlueBubbles already decrypts and publishes.
6. Calling `stopLiveLocation` removed the `.live` subscription cleanly.

Therefore selected-person tracking does not require Accessibility, Screen Recording, synthetic clicks, a second location source, or writes to Apple's databases.

## Product behavior

- Opening the Find My screen starts or joins the existing all-friends collection round.
- Selecting a friend starts one Apple live-location session for that friend.
- The accepted location stream continues through the existing decrypt/cache/socket pipeline and moves the marker as new fixes arrive.
- Selecting another friend replaces the previous selected session.
- Re-selecting the same friend explicitly restarts its initial locate request.
- Deselecting, leaving the screen, losing the owning lease, or an explicit cancel stops the selected session.
- One selected session is active server-wide. No arbitrary duration ends it while the selection remains active.
- The initial locating spinner and the continuing selected live session are distinct states. A successful fresh fix clears the initial spinner while the selected live session remains active.
- A device that does not answer retains its last known location; the client never invents a fix.

## Required architecture

### `FindMyCoordinator`

The coordinator is the sole owner of Find My process and session state. All transitions are serialized and generation-scoped.

It owns:

- process state (`stopped`, `starting`, `ready`, `stopping`, `faulted`);
- viewer leases identified by socket and surface/lease ID;
- at most one global collection round;
- at most one selected-friend live session;
- file publication generation and accepted-location events;
- capability checks and bridge readiness.

A process remains demanded while any viewer-required round or selected session is active. A forced global refresh must not silently kill an active selected session.

### Dedicated injected host

Do not add Find My to the existing generic `DylibPlugin` host. That host restarts applications after ordinary exits, while Find My is intentionally quit at the end of demand.

The Find My host must provide:

- on-demand launch only;
- an IPC-ready handshake before the process is considered usable;
- explicit deliberate-stop recognition;
- bounded retry/backoff and a crash circuit breaker;
- no automatic restart after a coordinator-requested quit;
- cleanup of its private local endpoint on exit.

### Local IPC

The bridge listens only on a private Unix-domain socket created for that launch.

- Parent directory mode: owner-only.
- Per-launch random authentication token.
- Same-user peer validation where supported.
- Versioned messages with request IDs.
- Allow-listed commands only: status, start one validated friend, stop the current friend.
- No network listener and no direct access from a phone client.

The BlueBubbles HTTP/socket layer remains the authenticated remote boundary. Incoming friend identity is validated against the current Apple roster and mapped by a stable Apple handle/roster identity, never by display name.

### One ingestion path

Global and selected fixes use the same path:

`Find My store write -> decrypt/map -> cache -> client event -> session accounting`

There is no targeted-location cache and no new polling loop. Locations are accepted by stable friend identity and timestamp, not by location-status ordering.

### Explicit session identity

Every global round and selected session has an opaque monotonically unique ID. Events carry:

- session ID and mode;
- target stable ID for selected mode;
- start time;
- current state;
- terminal reason (`complete`, `quiet`, `cancelled`, `replaced`, `failed`).

Delayed events may mutate only their matching session.

## Cleanup prerequisites

Before selected live tracking is added:

1. Reset global quiet time on every accepted fresh friend update, not only when the count of distinct updated friends increases.
2. Serialize process start/stop; cancel obsolete transition timers and publication generations.
3. Make viewer open/close idempotent and lease-based.
4. Put key, OS, and bridge capability checks in the coordinator so all triggers use the same gate.
5. Merge client location updates strictly by friend identity and newest timestamp.
6. Replace marker-string selection with a typed selection identity.
7. Separate source loading, command-pending state, global collection state, and selected tracking state.
8. Remove obsolete cooldown terminology. The former two-minute cooldown no longer exists.

## Failure and recovery

- A bridge failure must not stop BlueBubbles or Messages.
- A Find My crash disables selected tracking through the circuit breaker and leaves the ordinary cached map available.
- Starting Find My normally, without injection, is always the recovery path.
- Disconnect releases the owning viewer leases and selected session according to explicit coordinator policy.
- No component writes Apple's Find My databases or settings.

## Verification requirements

Tests must cover at least:

- repeated updates from an already-seen friend resetting global quiet time;
- duplicate viewer-open messages;
- start while an old stop is completing;
- force refresh during a selected session;
- delayed events from replaced sessions;
- selected-person switch, re-select, deselect, disconnect, and reconnect;
- a non-answering target;
- intentional quit versus crash restart/backoff;
- newer coordinates replacing older ones regardless of shallow/live status;
- full server and app regression suites before staged deployment.
