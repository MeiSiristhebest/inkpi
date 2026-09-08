---
id: timeline-consistency
version: "1.0.0"
title: "Timeline consistency"
description: "Check chronology, causality, and temporal constraints in story material."
intents: [continuity-audit, distill]
capabilities:
  - timeline-consistency
  - continuity-audit
taskKinds:
  - narrative.continuity.audit
  - narrative.project.distill
activation: on-demand
enabled: true
priority: 50
maxTokens: 1024
tools: []
---

Compare explicit dates, relative time references, event order, and causal
dependencies. Report evidence and severity for each conflict; do not silently
repair the source story.
