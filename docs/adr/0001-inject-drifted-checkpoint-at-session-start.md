# Inject a drifted checkpoint at session start, under a warning

Drift appears after almost any edit made after a checkpoint, so refusing the
body at session start forced every new session into an extra
`resume --allow-stale` round trip, and that round trip ended with the agent
reading the body anyway. The session-start hook now injects the body under a
banner that names the drift fields and tells the agent to reconcile against
the diff before trusting recorded verification. `cairn resume` still refuses
a drifted checkpoint by default, because a person or script calling it
directly gets no banner.
