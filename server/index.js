import express from "express";
import cors from "cors";
import { GoogleGenAI, Type } from "@google/genai";

const app = express();
const port = process.env.PORT || 8080;
const model = process.env.GEMINI_MODEL || "gemini-3.8-flash";
app.use(cors());
app.use(express.json({ limit: "55mb" }));

const MAX_TASK_CHARS = 12000;
const MAX_DOCUMENT_CHARS = 120000;
const MAX_EXTRACTED_TEXT_CHARS = 30000;
const SUPPORTED_UPLOAD_MIME_TYPES = new Set([
  "application/pdf",
  "text/plain",
  "image/png",
  "image/jpeg",
  "image/webp"
]);

function validateWorkflowInput(task, documents) {
  if (!task || typeof task !== "string" || !task.trim()) throw new Error("A task is required.");
  if (task.length > MAX_TASK_CHARS) throw new Error(`Task is too long. Please keep it under ${MAX_TASK_CHARS.toLocaleString()} characters.`);
  if (typeof documents !== "string") throw new Error("Supporting documents must be text.");
  if (documents.length > MAX_DOCUMENT_CHARS) throw new Error(`Supporting documents are too large. Please keep them under ${MAX_DOCUMENT_CHARS.toLocaleString()} characters.`);
}
const ai = process.env.GEMINI_API_KEY ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }) : null;

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
  if (!ai) throw new Error("GEMINI_API_KEY is not configured.");
  const prompt = [
    "You are the " + agent.name + " in KaroAI ActionFlow.",
    "ROLE: " + agent.instruction,
    "USER TASK:\n" + task,
    "SUPPLIED DOCUMENTS:\n" + (documents || "No documents supplied."),
    "PREVIOUS WORKFLOW STATE:\n" + JSON.stringify(state, null, 2),
    "Rules: Work only from the task and supplied evidence. Never fabricate names, dates, requirements, citations, document contents, portal statuses, or verification results. CRITICAL EVIDENCE RULE: If no supporting document/evidence establishes a claim, the claim MUST be marked unverified or missing, never verified. A user task alone is not evidence. Do not invent sources such as portals, official records, workflow specifications, identity documents, or referee systems. Only cite source names that actually appear in the supplied evidence or are explicitly provided by the user. Keep the result practical and concise. Return valid JSON matching the schema."
  ].join("\n\n");

  const response = await ai.models.generateContent({
    model,
    contents: prompt,
    config: { responseMimeType: "application/json", responseSchema: schema }
  });
  return JSON.parse(response.text);
}

app.post("/api/extract-document", async (req, res) => {
  try {
    const { name, mimeType, data } = req.body || {};
    if (!name || !data) return res.status(400).json({ error: "A document is required." });
    if (!process.env.GEMINI_API_KEY) return res.status(500).json({ error: "GEMINI_API_KEY is not configured." });

    const safeMime = mimeType || "application/pdf";
    if (!SUPPORTED_UPLOAD_MIME_TYPES.has(safeMime)) {
      return res.status(400).json({ error: "Unsupported document type. Use PDF, TXT, PNG, JPG or WEBP." });
    }
    const prompt = `Extract task-relevant information from the uploaded document "${name}".
Return plain text only. Preserve important names, dates, amounts, requirements, document headings, and page references when visible.
Do not invent or interpret facts. If text is unreadable, say so.`;

    const response = await ai.models.generateContent({
      model,
      contents: [
        { text: prompt },
        { inlineData: { mimeType: safeMime, data } }
      ]
    });

    const extractedText = (response.text || "").slice(0, MAX_EXTRACTED_TEXT_CHARS);
    res.json({ ok: true, name, mimeType: safeMime, text: extractedText });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Document extraction failed.", detail: error instanceof Error ? error.message : "Unknown error" });
  }
});

app.get("/api/health", (_req, res) => res.json({ ok: true, service: "KaroAI ActionFlow", model }));

app.post("/api/run-workflow-stream", async (req, res) => {
  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  try {
    const { task, documents = "" } = req.body || {};
    validateWorkflowInput(task, documents);
    if (!process.env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is not configured.");
    let state = {};
    const results = [];
    for (const agent of agents) {
      res.write(JSON.stringify({ type: "agent:start", id: agent.id, name: agent.name }) + "\n");
      const result = await runAgent(agent, task, documents, state);
      state = { ...state, [agent.id]: result };
      results.push({ id: agent.id, name: agent.name, status: "done", result });
      res.write(JSON.stringify({ type: "agent:complete", id: agent.id, name: agent.name, result }) + "\n");
    }
    res.write(JSON.stringify({ type: "complete", workflow: { task, model, agents: results, final: state.workflow || results[results.length - 1]?.result || null } }) + "\n");
    res.end();
  } catch (error) {
    res.write(JSON.stringify({ type: "error", error: error instanceof Error ? error.message : "Workflow execution failed." }) + "\n");
    res.end();
  }
});


app.post("/api/run-workflow", async (req, res) => {
  try {
    const { task, documents = "" } = req.body || {};
    try { validateWorkflowInput(task, documents); } catch (validationError) { return res.status(400).json({ error: validationError instanceof Error ? validationError.message : "Invalid workflow input." }); }
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
