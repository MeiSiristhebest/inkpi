---
id: hook
version: "1.0.0"
title: "Hook design"
description: "Shape a clear narrative hook while preserving the supplied scene facts."
intents: [continue, rewrite, outline]
capabilities:
  - narrative-hook
  - creative-writing
taskKinds:
  - creative.continue
  - creative.rewrite
activation: on-demand
enabled: true
priority: 20
maxTokens: 640
tools: []
---

Use the scene goal and the existing semantic blocks to identify the strongest
unresolved pressure. Prefer concrete conflict, a specific question, or a
changed expectation. Do not invent facts that are absent from the task input.
