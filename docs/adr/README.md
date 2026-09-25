 # Architecture Decision Records (ADR)

 This directory contains durable, long-term Architecture Decision Records for ADS.

 ## Format and Structure
 Each ADR should follow the standard format:
 - **Title**: Short description of the decision (e.g., `0001-github-native-workflow.md`).
 - **Status**: Proposed, Accepted, Deprecated, or Superseded.
 - **Context**: What problem or architectural challenge is being addressed?
 - **Decision**: What architecture change or design choice was made?
 - **Consequences**: What are the trade-offs, positive benefits, and long-term implications?

 Ordinary scoped features and bugfixes should be tracked directly via **GitHub Issues** and **Pull Requests** rather than ephemeral local files.

 ## Index

<!-- ADS:ADR_INDEX_START -->
- 0001 - [ADR 0001: Retire Claude CLI Adapter and Obsolete Reviewer Model Settings in Favor of Unified Codex Engine](0001-retire-claude-cli-adapter-and-reviewer-model.md)
- 0002 - [ADR 0002: Retire Plan Checkbox Cards in Favor of Interleaved Turn Streaming Progress](0002-retire-plan-checkbox-cards.md)
- 0003 - [ADR 0003: Preserve Streaming Phase Boundaries Across Reconnects](0003-preserve-streaming-phase-boundaries.md)
- 0004 - [ADR 0004: 退役全局规则提示注入并固化机器安全拦截](0004-retire-global-rules-prompt-injection.md)
- 0005 - [ADR 0005: Reconnect Runtime Snapshots and Ordering Barriers](0005-reconnect-runtime-snapshot-barrier.md)
- 0006 - [ADR 0006: Decouple Telegram Channel Connector from ADS Core](0006-decouple-telegram-channel-connector.md)
- 0007 - [ADR 0007: 对齐 Codex 标准技能目录与存储发现机制](0007-align-skills-with-codex-standard.md)
- 0008 - [ADR 0008: Keep WebSocket Transport Alive Across Lane Resets](0008-in-band-websocket-session-reset.md)
- 0009 - [ADR 0009: Converge System Prompts on Versioned Web Lanes](0009-converge-lane-system-prompts-and-retire-soul.md)
- 0010 - [ADR 0010: Rename Planner Lane to Advisor with Legacy Compatibility](0010-rename-planner-lane-to-advisor.md)
- 0011 - [ADR 0011: Restore Cached Transcripts Before Auth and Resume by Cursor](0011-local-first-transcript-sync.md)
- 0012 - [ADR 0012: Encrypt User-Scoped Upstream Discovery Credentials](0012-encrypt-upstream-discovery-credentials.md)
- 0013 - [ADR 0013: Introduce the Opt-In Native Agent Runtime](0013-native-agent-runtime-phase-1.md)
- 0014 - [ADR 0014: Evolve Dual Lanes into Acopilot and Actions with In-Process Job Bus](0014-acopilot-and-actions-architecture.md)
- 0015 - [ADR 0015: Preserve Action Jobs Across Recoverable Failures](0015-actions-recoverable-rework-state-machine.md)
- 0016 - [ADR 0016: Bind Actions Events to Authenticated Project Lanes](0016-bind-actions-events-to-authenticated-project-lanes.md)
- 0017 - [ADR 0017: 退役 Live-Step 进度消息通道](0017-retire-live-step-progress.md)
- 0020 - [ADR 0020: Isolate Actions Reviewer Context and Persist Review Contracts](0020-isolated-actions-reviewer-contract.md)
- 0021 - [ADR 0021: Enforce Exclusive Runtime Backend and Session Lifecycle](0021-exclusive-runtime-backend-lifecycle.md)
- 0022 - [ADR 0022: 持久化 Native Runtime Transcript](0022-persist-native-runtime-transcripts.md)
- 0023 - [ADR 0023: 为 Native Runtime 引入 Token-aware Context Projection](0023-token-aware-native-context-projection.md)
- 0024 - [ADR 0024: Define Native Provider Capability Contracts](0024-native-provider-capability-contract.md)
- 0025 - [ADR 0025: Harden Native Retry, Cancellation, and Recovery](0025-native-bounded-retry-and-recovery.md)
- 0026 - [ADR 0026: Define the Native Runtime Lifecycle and Capability Contract](0026-native-runtime-lifecycle-and-capability-contract.md)
- 0027 - [ADR 0027: 建立 Canonical Lane 与 Actions Role 术语契约](0027-canonical-lane-and-actions-role-terminology.md)
<!-- ADS:ADR_INDEX_END -->
