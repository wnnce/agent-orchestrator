# Daily Summary Example Task

## Target
Perform daily automated inspection on open issues and pull requests, generating structured summaries to send via notification.

## Parameters
- **cron**: `0 10 * * 1-5` (Mon-Fri 10:00 AM)
- **timeout**: 300s

## Execution Steps
1. Call GitHub MCP tool to query open issues and PRs for the repository.
2. Filter items with High or Critical priority.
3. Organize into a Markdown daily digest.
4. Call `send_notification` to dispatch alerts to configured channels (Telegram / Feishu / WeCom).
