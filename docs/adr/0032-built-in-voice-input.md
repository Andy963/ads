# ADR 0032: Make Voice Input a Built-in Service with Independent Correction

## Status

Accepted

## Context

Web dictation previously discovered executable skills, wrote temporary audio files,
and used host Codex credentials for optional correction. Mobile users could not
configure either stage independently. The skill's subprocess overhead has not
been established as the dominant latency source.

## Decision

- Keep the existing authenticated audio endpoint and its `ok`/`text` success
  contract. Implement Groq multipart transcription in process, behind a small
  provider function. Keep the existing global skills untouched.
- Store typed, account-level voice configuration separately from conversation
  models. Encrypt keys with the existing owner/profile-bound credential store.
  Saving settings never depends on model discovery or a health check.
- Resolve transcription and correction credentials synchronously in one database
  transaction before upstream work starts. Never use environment, Codex, role,
  or another account's credentials as a fallback.
- Configure correction directly with its own endpoint, encrypted key, model name,
  reasoning effort, and an editable system prompt. Persist the prompt per account,
  pin it with the connection snapshot, and use it only for correction. Missing
  legacy prompts receive the default; blank or oversized prompts are rejected.
  Do not select, create, mutate, or borrow a conversation
  model or role profile. Give ASR and correction separate credential profiles.
- Save each stage independently, preserving the other stage's latest settings.
  Preserve legacy ASR settings but require explicit correction setup when an
  older voice record references a conversation model; never copy its secrets.
- Run correction as one tool-free text request using a dedicated instruction,
  with independent request settings and the ADS default `high` reasoning effort.
  An unconfigured model, invalid connection, failed request, empty output, or deadline
  retains the raw transcript and reports a correction warning.
- Use per-stage and total deadlines without retries. Propagate client disconnects
  to both stages. Reject stale browser results after cancellation or scope changes.
- Provide three mutually exclusive, Chinese-language model configuration pages:
  conversation models, speech transcription, and text correction. Keep the
  navigation visible when mobile outer tabs are hidden. The role editor only
  renders in its own role/instruction section.
- Test uploads use saved settings only, never implicitly save a draft, and require
  explicit audio selection. Show transcription and correction outcomes separately.


## Consequences

Web voice input no longer depends on skill installation or routine temporary
files. Configuration, credential isolation, browser cancellation and stage-level
observability become ADS responsibilities. Existing installations must explicitly
configure each account; there is no automatic secret import. Only Groq is
implemented initially. OpenRouter, streaming recognition, Telegram audio, plugin
loading, deployment and release are outside this change.

Automated tests establish protocol, credential, cancellation and UI behavior.
Actual iOS Safari/PWA microphone and keyboard behavior and real upstream latency
comparisons require separately authorized device/audio testing; simulated tests
are not evidence of measured latency improvement.
