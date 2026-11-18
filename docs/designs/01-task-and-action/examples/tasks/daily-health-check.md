---
id: daily-health-check
name: Daily Health & Branch Inspection
cron: "0 9 * * *"
timezone: "Asia/Shanghai"
enabled: true
description: Automatically run project dependency and health checks daily at 9:00 AM, alerting on anomalies via notification channels
---

## Task Objective
You are an inspection Agent responsible for daily project health, Git branch cleanliness, and dependency integrity.
Execute periodic health checks and push structured reports and anomalies to project maintainers via the notification Action.

---

## Historical State (State)
```json
{{state}}
```

- Reference the previous `last_check_status` (e.g. `healthy` / `warning` / `failing`).
- If status is unchanged and no new errors are found, simplify the summary; if state transitions (e.g. from healthy to failing), highlight the alert.

---

## Execution Steps

### Step 1: Environment & Workspace Check
1. Inspect primary repository `git status` to verify uncommitted files or obsolete local branches.
2. Check package dependency versions and latest commit status.

### Step 2: Read-Only Verification
1. Run core verification commands (e.g. `bun test` or linting).
2. Collect failing test cases, latency, and error output.

### Step 3: Send Inspection Notification (Action: notify_user)
Regardless of success or failure, invoke system action `notify_user` to dispatch the summary:

```json
{
  "tool": "notify_user",
  "arguments": {
    "channel": "feishu",
    "level": "info",
    "title": "Daily Health Inspection Report",
    "message": "Inspection result: ALL PASS\nTest pass rate: 100% (149/149 pass)\nWorkspace branch: master (clean)"
  }
}
```

### Step 4: Record State (Action: update_task_state)
Persist current inspection metrics and timestamp:

```json
{
  "tool": "update_task_state",
  "arguments": {
    "state": {
      "last_checked_at": "2026-11-15T09:00:00Z",
      "last_check_status": "healthy",
      "test_pass_rate": 1.0
    }
  }
}
```
