# Tool recovery

Tools default to `replay: 'never'`. Set `replay: 'safe'` only when repeating an
interrupted invocation is safe, and declare `implementationVersion`. Registered
skill tools can use the registration's explicit `skillVersion` as their
implementation identity. Advance that version when execution semantics change.

Before execution, the journal records an independent operation id, reserved
result id, provider tool-call id, schema, implementation version, registration
source, skill version, and capabilities. Provider tool-call ids can repeat across
turns without overwriting operation history.

The first `Agent.prompt()` or `Agent.continue()` recovers active-path operations
before making a provider request. Hosts can call `recoverInterruptedTools()`
after registering current tools to perform recovery separately. Recovery checks
both declarations, versioned contracts, arguments, and current hooks. A changed
or unavailable tool produces an error result that says its effect is unknown;
it does not repeat the effect. Legacy records without contract evidence also
produce that result.

Recovery reuses the reserved result identity and commits settlement plus result
atomically. Existing results prevent another execution, including old results
whose separate settlement record is missing. An uncertain commit stops the
current Agent; reconstruct it from storage before continuing. Cancellation waits
for recovery execution and result consumers before the Agent becomes idle.
