---
id: promise
version: "1.0.0"
title: 'Promise tracking'
description: "Track setup, payoff, and unresolved story promises across a project."
intents: [continue, rewrite, continuity-audit]
capabilities: [story-promise, continuity-audit]
taskKinds: [creative.continue, creative.rewrite, narrative.continuity.audit]
activation: lazy
enabled: true
priority: 30
maxTokens: 768
tools: []
---

Track each promise with its source block, current status, and evidence for a
payoff or contradiction. Keep open promises explicit when a scene only moves
them forward.
