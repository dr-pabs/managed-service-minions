# Agent Build Team Overview

> Date: 2026-06-06  
> Purpose: Explain how the Minions Agent Framework operates, how its harness works, and how to get the best results from working with the agent build team.

---

## 1. What this system is

This platform is not just a chatbot or a single assistant. It is a multi-agent delivery system built on top of Goose that combines:

- an orchestration layer that breaks complex work into tasks
- specialist minions that perform focused work such as code exploration, ticket analysis, PR creation, and security review
- a shared tool layer that enforces allowlists, logging, rate limits, and auditability
- Azure-hosted runtime, monitoring, and deployment controls

In short, the system is designed to help a team of agents collaborate on real engineering work rather than relying on one generic agent to do everything.

---

## 2. Core capabilities of the agent harness

The Goose harness provides the runtime foundations. The framework then builds on top of those primitives.

### 2.1 Runtime primitives we rely on

- delegate: spawns isolated sub-agents for specialist work
- load(taskId): collects async delegate results and status
- sessions: preserves conversation and workflow state
- extensions: packages tools, prompts, and behaviors into reusable units
- platform__manage_schedule: supports cron-driven recurring tasks
- apps__create_app: provides a path for dashboard and UI extension generation

These are the base building blocks. The framework adds the orchestration, governance, and integrations around them.

### 2.2 What the framework adds on top

The actual delivery system adds the following layers:

1. Intent classification and routing
   - Understands the user’s request and decides which minion path to use.

2. Task decomposition and DAG execution
   - Breaks complex requests into parallel and dependent steps.

3. Minion lifecycle management
   - Spawns, monitors, retries, and terminates delegates safely.

4. Tool governance
   - Enforces allowlists, rate limits, path scoping, and logging.

5. Human approval gates
   - Prevents destructive actions from being executed without explicit approval.

6. Observability and auditability
   - Captures tool traces, session history, status, and performance data.

7. Azure deployment and operations
   - Runs in Container Apps, uses Service Bus, Storage, Key Vault, AI Foundry, and Log Analytics.

---

## 3. How the agent build team works

The team is organized around focused roles, not one monolithic engineer role.

### 3.1 The key roles

- Goose / Agent Engineer
  - Builds the orchestrator, toolshed, and agent extensions
- MCP / Integration Engineer
  - Connects GitHub, Azure DevOps, ServiceNow, Jira, Slack, and Teams
- Azure / Infrastructure Engineer
  - Builds the hosting, networking, identity, and deployment layer
- Prompt / LLM Engineer
  - Refines prompts, schemas, and test quality for minions
- Frontend / Dashboard Engineer
  - Builds the agent dashboard and operator views
- Security Engineer
  - Reviews allowlists, RBAC, managed identity, and prompt safety
- QA / Test Engineer
  - Creates unit, integration, E2E, prompt-quality, and chaos tests
- DevOps / CI-CD Engineer
  - Owns build, deploy, canary, rollback, and release controls
- Product Owner
  - Defines priority, scope, and business outcome

This division of labor is important because the system is multi-layered. The runtime, the integrations, the prompts, the security model, and the deployment path all need specialized care.

### 3.2 Working model

The build team typically works in phases:

1. Foundation
   - Start with the runtime primitives and core extensions.

2. Minion framework
   - Build the specialist agents and their prompt contracts.

3. Ticket and review workflows
   - Connect ServiceNow, Azure DevOps, GitHub, and review flows.

4. Platform hardening
   - Add infra, dashboards, observability, and production controls.

This phased approach helps avoid building a fragile system all at once.

---

## 4. How the harness behaves in practice

A typical session follows this path:

1. A user sends a request through Slack or Teams.
2. The bot ingress layer receives the message.
3. The orchestrator classifies the request and builds a work plan.
4. Specialist minions are spawned as delegates.
5. Minions call the shared toolshed for approved actions.
6. Results are collected, validated, and summarized.
7. The user receives a structured answer, and the run is recorded for audit and debugging.

This means the framework can handle complex tasks by decomposing them into a small set of focused actions instead of asking one agent to reason across everything at once.

---

## 5. What makes the harness valuable

### 5.1 It separates reasoning from execution

The orchestrator coordinates the workflow, while specialist minions do the actual domain-specific thinking and tool use. This separation improves reliability and traceability.

### 5.2 It controls access and risk

Every tool call is filtered through the MCP toolshed. That gives the system a strong least-privilege model and makes security review much easier.

### 5.3 It supports parallel execution

Independent parts of a task can run concurrently. This is especially useful for ticket analysis, code review, and PR generation workflows.

### 5.4 It gives operators visibility

The dashboard, correlation tree, and logs let operators inspect what happened, where it failed, and how to retry or recover.

---

## 6. How to get the most out of working with the agent build team

The best outcomes come from treating the system as a delivery partner, not simply as an autocomplete tool.

### 6.1 Give clear problem statements

Be specific about:

- the user goal
- the source of work (Slack, Teams, ServiceNow, Azure DevOps, GitHub)
- what success looks like
- what is allowed and what is not

The clearer the task, the better the orchestration layer can choose the right path.

### 6.2 Provide real workflow context

The system performs best when you give it the operational context behind the work:

- ticket or work item references
- current branch or repo details
- review or approval rules
- expected output format
- known failure modes

### 6.3 Use the workflow in layers

Do not expect one prompt to solve every problem. The best outcomes come from combining:

- clear orchestration logic
- strong minion prompts
- tested tool access rules
- real integration points

### 6.4 Treat quality as an iterative discipline

Prompt quality, evaluation, and regression tests should be part of the normal delivery process. Prompt changes should be measured rather than guessed at.

### 6.5 Use human approval for sensitive actions

For destructive or high-impact actions, retain explicit human approval. This protects the system from overreach and improves trust.

### 6.6 Ask for traceability, not just answers

When working with the agent team, ask for:

- the reasoning path
- the tool calls used
- the resulting artifacts
- the failure and recovery path if the run fails

This is one of the biggest advantages of the framework.

---

## 7. What to expect from the build team

When you work with this system, expect the build team to:

- break down complex work into practical delivery tasks
- implement the runtime and integration layers needed for real use
- maintain security and audit controls throughout the workflow
- test behavior before deployment
- monitor quality after rollout
- use human approval for risky operations

The goal is not only to answer questions, but to create a reliable operating model for ongoing agent-driven delivery.

---

## 8. Recommended working style

To get the highest value from the platform:

1. Start with one concrete workflow, not a broad ambition.
2. Define success criteria before implementation.
3. Make the tool boundaries explicit.
4. Review the prompt and integration quality early.
5. Use the dashboard and observability views to debug and improve behavior.
6. Measure outcomes and iterate based on real evidence.

---

## 9. Summary

The agent harness gives you the runtime primitives for isolated, tool-enabled sub-agents. The build team gives you the operational discipline to turn those primitives into a trustworthy delivery platform.

The best way to work with it is to treat it as an engineering partner:

- define the task clearly
- provide the context and constraints
- let the orchestrator and minions do the decomposition
- validate the result through tests, observability, and human review

That is how you get the most value from the system.
