---
name: code-review
description: Review code changes for correctness, security vulnerabilities, regressions, and maintainability.
compatibility: opencode
---

# Code Review

Review the real repository and current diff before giving findings. Prioritize exploitable security issues, correctness bugs, data loss, and regressions. Check validation, authentication/authorization, secret handling, error paths, resource use, test coverage, and compatibility. Do not change files during a review unless explicitly asked. Report only actionable findings with severity and file/path context; state when no issue was found and what was not checked. Never claim tests passed unless they were run.
