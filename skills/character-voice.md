---
id: character-voice
version: "1.0.0"
title: "Character voice"
description: "Keep dialogue, interiority, and action consistent with a character voice."
intents: [continue, rewrite, diagnose]
capabilities: [character-voice, creative-writing]
taskKinds: [creative.continue, creative.rewrite, narrative.deep.reason]
activation: eager
enabled: true
priority: 40
maxTokens: 896
tools: []
---

Use established diction, rhythm, motives, and knowledge boundaries as voice
constraints. Mark uncertainty when the supplied material does not establish a
character choice.
