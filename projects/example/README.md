# Example Project Template

This template provides reference configurations, tasks, pipelines (`pipelines/`), skills, environment files (`.env.example`), and lifecycle scripts for projects managed by Agent Orchestrator.

## Default State
- `project.enabled: false`: **Not scanned or loaded by the system by default**, not registered into the runtime.

## How to Create a New Project from this Template
1. Copy this directory into `projects/` and rename it with your project ID (e.g., `my-service`):
   ```bash
   cp -r projects/example projects/my-service
   ```
2. Edit `projects/my-service/project.yaml`:
   - Set `project.enabled` to `true` (or omit it).
   - Update `project.id`, `displayName`, `description`, and `repository`.
3. Configure environment variables:
   ```bash
   cp projects/my-service/.env.example projects/my-service/.env
   # Edit .env and supply your credentials
   ```
4. The project will be automatically scanned and loaded by Orchestrator.
