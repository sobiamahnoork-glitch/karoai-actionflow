import express from "express";
import cors from "cors";
import { GoogleGenAI, Type } from "@google/genai";

const app = express();
const port = process.env.PORT || 8080;
const model = process.env.GEMINI_MODEL || "gemini-3.8-flash";
app.use(cors());
app.use(express.json({ limit: "8mb" }));
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const agents = [
  { id: "intake", name: "Intake Agent", instruction: "Understand the user task, goal, constraints, dates, people, and requested outcome. Do not invent facts." },
  { id: "document", name: "Document Agent", instruction: "Extract only task-relevant information from supplied documents. Preserve document names and page or section references when supplied. Never invent missing text." },
  { id: "requirement", name: "Requirement Agent", instruction: "Determine requirements implied by the task and explicit requirements found in evidence. Separate documented requirements from reasonable workflow suggestions." },
  { id: "gap", name: "Gap Agent", instruction: "Compare requirements against extracted evidence. Identify missing documents, missing information, unresolved items, and satisfied items." },
  { id: "verification", name: "Verification Agent", instruction: "Cross-check important claims against supplied evidence. Mark claims verified, contradicted, or unverified and cite the originating source where possible." },
  { id: "draft", name: "Draft Agent", instruction: "Prepare a useful draft or structured output using only verified information. Clearly mark placeholders for missing information." },
  { id: "workflow", name: "Workflow Agent", instruction: "Turn the current state into an ordered action plan with priorities, owners where known, dependencies, and deadlines only when supported by evidence." }
];

const schema = {
  type: Type.OBJECT,
  properties: {
    summary: { type: Type.STRING },
    findings: { type: Type.ARRAY, items: { type: Type.STRING } },
    missing: { type: Type.ARRAY, items: { type: Type.STRING } },
    evidence: { type: Type.ARRAY, items: { type: Type.OBJECT, properties: { claim: { type: Type.STRING }, status: { type: Type.STRING }, source: { type: Type.STRING } }, required: ["claim", "status", "source"] } },
    output: { type: Type.STRING },
    nextSteps: { type: Type.ARRAY, items: { type: Type.STRING } }
  },
  required: ["summary", "findings", "missing", "evidence", "output", "nextSteps"]
};

async function runAgent(agent, task, documents, state) {
  const prompt = [
    "You are the " + agent.name + " in KaroAI ActionFlow.",
    "ROLE: " + agent.instruction,
    "USER TASK:\n" + task,
    "SUPPLIED DOCUMENTS:\n" + (documents || "No documents supplied."),
    "PREVIOUS WORKFLOW STATE:\n" + JSON.stringify(state, null, 2),
    "Rules: Work only from the task and supplied evidence. Never fabricate names, dates, requirements, citations, or document contents. If something cannot be established, say unknown or unverified. Keep the result practical and concise. Return valid JSON matching the schema."
  ].join("\n\n");

  const response = await ai.models.generateContent({
    model,
    contents: prompt,
    config: { responseMimeType: "application/json", responseSchema: schema, temperature: 0.2 }
  });
  return JSON.parse(response.text);
}

app.get("/api/health", (_req, res) => res.json({ ok: true, service: "KaroAI ActionFlow", model }));

app.post("/api/run-workflow", async (req, res) => {
  try {
    const { task, documents = "" } = req.body || {};
    if (!task || typeof task !== "string") return res.status(400).json({ error: "A task is required." });
    if (!process.env.GEMINI_API_KEY) return res.status(500).json({ error: "GEMINI_API_KEY is not configured." });
    let state = {};
    const results = [];
    for (const agent of agents) {
      const result = await runAgent(agent, task, documents, state);
      state = { ...state, [agent.id]: result };
      results.push({ id: agent.id, name: agent.name, status: "done", result });
    }
    res.json({ ok: true, workflow: { task, model, agents: results, final: state.workflow } });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Workflow execution failed.", detail: error instanceof Error ? error.message : "Unknown error" });
  }
});

app.listen(port, () => console.log("KaroAI API listening on port " + port));
