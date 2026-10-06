# Assessment and scoring

Supported assessment types are resume screen, AI interview, human interview, coding test, and prompt assessment. The state machine is defined and tested in `packages/domain`.

Scores combine job requirements with a weight from 0–100. Every criterion result stores score, configured weight, rationale, and a concrete evidence excerpt or submission reference. A deterministic local evaluator will support repeatable tests. Production model output must be schema-validated and cannot issue a hiring decision.

Integrity events are stored independently from performance evidence and are advisory. They cannot trigger the rejected state.
