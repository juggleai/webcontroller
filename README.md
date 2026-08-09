# JuggleWork Webcontroller

A zero-dependency, locally hosted web console for diagnosing and validating the
JuggleWork remote-control path. It can be used to verify:

- Connectivity to `https://work.juggle.im` and CORS behavior;
- Cloud account sign-in and organization selection;
- Desktop remote-control feature gates;
- Online and offline presence, heartbeat generations, and capability
  advertisements for registered Desktop devices;
- Incremental session updates through stable, scoped control sessions,
  durable commands, and resumable SSE streams;
- Remaining gaps and hardening opportunities in the end-to-end control path.

## Getting started

```bash
cd webcontroller
npm start
```

Then open the following URL in a browser:

```text
http://127.0.0.1:4177
```

To use a different port, set `WEBCONTROLLER_PORT` before starting the server:

```bash
WEBCONTROLLER_PORT=4180 npm start
```

## Security considerations

- Passwords are used only for the sign-in request and are never stored.
- The Cloud session token is kept only in the page's JavaScript memory.
- Control-session renewal reuses the current authenticated bearer as proof. It
  does not store the password or ask for it again.
- Refreshing or closing the page clears the token.
- Credentials are never stored in `localStorage` or `sessionStorage`.
- **Copy report** omits session tokens and passwords.
- Browser notifications are sent only after the user clicks **Enable secure
  notifications** and grants explicit permission. Titles and bodies use fixed,
  semantic text and do not include prompts, transcripts, paths, payloads,
  errors, or identifiers.

## Current capabilities and limitations

The current Server and Desktop implementations provide:

- Device registration, proof-of-possession (PoP) authentication, outbound WSS,
  presence, heartbeats, and capability publication;
- Read-only control sessions across the discovery, workspace, and session
  layers;
- Durable commands, generation-fenced WSS delivery, resumable SSE, and bounded
  polling fallback;
- Desktop handlers for `workspace.list`, `session.list`, and
  `session.snapshot`;
- Bounded session snapshots with minimized content.

The webcontroller can read the local workspace, sessions, and snapshots, and
apply normalized incremental `transcript`, `todo`, `interaction`, and `status`
events. When the device advertises the capability and policy allows it, the
console also supports `session.prompt` and guarded `session.abort` operations.
It can surface secure notifications for interaction waits, terminal run states,
closed or disconnected control connections, and revoked or unavailable
devices.

Control sessions can be explicitly renewed before they expire. If a write
operation returns `control_session_reauthentication_required`, the console
renews the session and asks the user to retry; it never replays the operation
automatically. Expired or closed sessions are rebuilt from a fresh snapshot.
Historical transcript pagination is not implemented yet.
