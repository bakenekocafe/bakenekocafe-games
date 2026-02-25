# ARCHITECTURE GUARDRAILS (FINAL VERSION)

This project operates under a strict stability-first architecture model.
All development must follow this document.

---

# 0. Core Principle

Stability > Idempotency > Security > Observability > UX > Features.

No feature work may break stability or telemetry guarantees.

---

# 1. Execution Control Model (ACCEPT-BASED)

## Default Rule
Cursor MUST NOT (unless 1b applies):

Execute terminal commands automatically
Run npm / wrangler / curl / powershell
Trigger background processes
Auto-deploy


## 1a. Allowed Only If Explicitly Approved (when Auto-Run is OFF)

When the user has **not** enabled Cursor Auto-Run, execution is permitted ONLY when:

The response clearly contains:
   "RUN REQUIRED: 1 time"
The command block is consolidated into a single copy-paste block
The user explicitly replies with:
   "ACCEPT RUN"

Without "ACCEPT RUN", execution is prohibited.


## 1b. Auto-Run Exception (RUN/ACCEPT を省く)

When the user has enabled **Cursor Auto-Run** in settings:
- `cursor.agent.autoRun: true` and `cursor.terminal.autoRun: true` in `%APPDATA%\Cursor\User\settings.json`
- and optionally Allowlist / `~/.cursor/sandbox.json` / `~/.cursor/cli-config.json` で許可済み

then:
- **Explicit "ACCEPT RUN" is NOT required.** The agent MAY execute approved command blocks without requesting acceptance.
- **"RUN REQUIRED: 1 time"** may be omitted when the agent runs a single consolidated command (e.g. `.\run-full-verify.ps1`) with appropriate permissions.
- All other safety rules (single command when possible, no auto-deploy, no Cloudflare/DNS automation) still apply.

---

# 2. File Modification Rules


All code changes must be deterministic.
Public API signatures must not change without explicit request.
Backward compatibility must be preserved.
Idempotency logic must never be weakened.
Rate limit logic must never be bypassed.


Docs must be updated when behavior changes.

---

# 3. External Systems Policy

Operations involving:

Cloudflare Dashboard
DNS
Ad Network dashboards
KV namespace creation
Secrets management


Must always be labeled:

[USER ACTION REQUIRED]

No automation attempts allowed.

---

# 4. Telemetry & Analytics Requirements

Every critical flow must guarantee:


Single-send telemetry (no duplicates)
Non-blocking UX
Timeout guarantee
Explicit error classification


Telemetry events must be backward compatible.

---

# 5. Rewarded Flow Safety Rules

Mandatory guarantees:


Nonce is consumed only on successful verification
Token replay protection enforced
Verification timeout bounded
Idempotency enforced server-side
Client never stores ad tokens


No shortcut implementations allowed.

---

# 6. Cost Explosion Prevention

Must never:


Introduce unbounded loops
Create unbounded retry storms
Remove backoff protection
Remove queue caps


Any change affecting request volume must document expected RPS impact.

---

# 7. Change Format Requirement

All implementation responses must follow:


Purpose
Changes
Files Modified
Risk Impact
USER ACTION (if needed)
RUN REQUIRED (only if absolutely necessary)


---

# 8. Emergency Override

If an urgent fix requires bypassing these rules,
the response must clearly state:

"GUARDRAIL OVERRIDE REQUIRED"

and explain why.

Override requires explicit user approval.

---

End of Guardrails.
