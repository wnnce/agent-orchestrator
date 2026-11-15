# In-Session Dynamic Scheduling Specification (Conversational Scheduling)

In interactive conversations, users frequently request delayed reminders or asynchronous monitoring, such as:
- *"Check the CI build status for me in half an hour"*
- *"Remind me to merge this PR tomorrow at 10 AM"*
- *"Never mind about that build check, cancel it"*

This document specifies how the Agent utilizes **native ToolCalls** to create, query, and cancel dynamic in-session jobs.

---

## 1. Core Action Tools

The host system injects the following Action tools directly into conversational turns (no MCP overhead, dispatched via native ToolCall callbacks):

| Tool Name | Purpose | Key Parameters |
| :--- | :--- | :--- |
| **`schedule_job`** | Register a delayed or recurring job | `delay_seconds`, `run_at`, `cron`, `name`, `prompt` |
| **`cancel_job`** | Cancel a specific job | `name` or `job_id` |
| **`list_jobs`** | Query active scheduled jobs in current session | None |

---

## 2. Standard Interaction Examples

### Scenario 1: User Requests a Delayed Check

#### 1. User Input
> "I just pushed code to origin/feat-login. The build takes about 20 minutes; check the build status in 20 minutes and report back to me."

#### 2. Agent Thinking & ToolCall Invocation
The Agent strictly **avoids `sleep 1200`** and instead calls `schedule_job`:

```json
{
  "tool": "schedule_job",
  "arguments": {
    "name": "check_login_build",
    "delay_seconds": 1200,
    "prompt": "Scheduled timer triggered: inspect latest GitHub Actions build for branch feat-login. If successful, summarize artifacts; if failed, extract error logs and alert the user."
  }
}
```

#### 3. Host System Response
The system inserts a record with `status = 'pending'` into `scheduled_jobs` and returns:
```json
{
  "success": true,
  "job_id": "job_9f81a7b2",
  "name": "check_login_build",
  "trigger_at": "2026-11-15T10:20:00.000Z"
}
```

#### 4. Agent Confirmation to User
> "Scheduled reminder created. I will check the CI build for `feat-login` in 20 minutes (around 10:20) and notify you."

---

### Scenario 2: User Cancels a Scheduled Job

#### 1. User Input
> "Cancel the build check I just scheduled."

#### 2. Agent Calls `cancel_job`
```json
{
  "tool": "cancel_job",
  "arguments": {
    "name": "check_login_build"
  }
}
```

#### 3. System Response & Confirmation
The system marks `status = 'cancelled'` and returns:
```json
{
  "success": true,
  "cancelled_jobs": ["job_9f81a7b2"]
}
```
Agent responds:
> "The scheduled task `check_login_build` has been cancelled."

---

### Scenario 3: Timer Trigger & Session Liveness Guard
When `trigger_at` arrives, the system verifies the target session:
1. If the session is `active`, it loads the prompt and launches a new conversational turn.
2. If the session has been closed or archived, the job is marked `abandoned` and safely discarded without creating zombie processes.
