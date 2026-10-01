# KaroAI Agent Contract

KaroAI uses a sequential multi-agent workflow. Each agent has one responsibility and receives the task, supplied evidence, and structured state produced by earlier agents.

## Agent order
1. Intake — understand the task and constraints.
2. Document — extract relevant evidence.
3. Requirement — identify requirements.
4. Gap — compare requirements with evidence.
5. Verification — cross-check important claims.
6. Draft — prepare the requested draft or output.
7. Workflow — produce the ordered action plan.

The agents currently use the same Gemini model with different role instructions. They are orchestrated independently so each stage has a bounded responsibility and structured output.

## Evidence rule
Agents must never invent facts. When evidence is absent or unclear, the result must say unknown or unverified, or identify the missing item.

## Next implementation step
Connect the React workspace to /api/run-workflow, then add document upload and extraction and render each agent result in the activity panel.