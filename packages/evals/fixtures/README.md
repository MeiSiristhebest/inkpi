# Evaluation fixtures

Fixtures are grouped by semantic-content, retrieval, continuity, character-voice, timeline, foreshadowing, hook, distillation, long-context, and mutation. They are deterministic inputs for objective checks and can be paired with human-labelled scores for subjective checks.

Objective fixture files describe both the clean structure and the deterministic failure shape. The evaluator reports a failure when an entity/status, state transition, source-map range, context budget, checkpoint, or mutation invariant is violated.

The checked-in subjective fixtures are deterministic reference contracts. They are not evidence of human preference or real-provider quality. A human-labelled dataset must carry a provenance envelope and per-case annotation records; validate it with `validateSubjectiveHumanGoldSet` before using it as a gold set. Pairwise human evaluation must also set `requireExplicitObservedPreference: true` so preferences are never derived from candidate scores.
