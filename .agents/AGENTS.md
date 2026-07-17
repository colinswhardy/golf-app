# CaddyShot AI Agent Orchestration Rules

This workspace uses a split-role multi-agent workflow:
1. **Antigravity (Planner)**: Responsible for code analysis, architecture design, and creating specifications.
2. **Claude Code (Executor)**: Responsible for code modification, building, terminal executions, and validation.

---

## 📋 The Shared Protocol

To coordinate work:
* All architecture specifications and implementation designs are written to `.agents/implementation_plan.md`.
* All active checklist items are tracked in `.agents/task.md`.

---

## 🤖 Instructions for Claude Code (Executor)

When executing tasks:
1. **Read the plan**: Before writing code, read the full contents of `.agents/implementation_plan.md` to understand the goal, context, and code files to modify.
2. **Follow the checklist**: Open `.agents/task.md` and work through the list step-by-step.
3. **Keep checklists in sync**: As you complete each sub-task, update the checkboxes in `.agents/task.md` by changing `[ ]` to `[x]`.
4. **Verify**: Run build/test commands as specified in the plan's verification section before reporting back.
