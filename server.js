import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import { GoogleGenAI, Type } from "@google/genai";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = parseInt(process.env.PORT || "3000", 10);
const host = "0.0.0.0";
const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";

app.use(cors());
app.use(express.json({ limit: "8mb" }));

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
    evidence: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          claim: { type: Type.STRING },
          status: { type: Type.STRING },
          source: { type: Type.STRING }
        },
        required: ["claim", "status", "source"]
      }
    },
    output: { type: Type.STRING },
    nextSteps: { type: Type.ARRAY, items: { type: Type.STRING } }
  },
  required: ["summary", "findings", "missing", "evidence", "output", "nextSteps"]
};

function getMockResult(agent, task, documents, state) {
  switch (agent.id) {
    case "intake":
      return {
        summary: `Understood task: ${task || "Masters scholarship application"}. Identified goal, constraints, and scope.`,
        findings: ["Goal: Submit verified application packet for Masters scholarship.", "Required items must be backed by original documentation."],
        missing: ["Explicit verification of all attached credentials."],
        evidence: [{ claim: "Task received and parsed", status: "Verified", source: "User Task Prompt" }],
        output: "Task intake completed. Structured evaluation initiated across remaining 6 agents.",
        nextSteps: ["Extract relevant evidence from supplied documentation", "Build formal requirement inventory"]
      };
    case "document":
      return {
        summary: documents ? "Extracted evidence from supplied documents." : "Evaluated baseline task evidence records.",
        findings: ["Found official passport identification", "Found undergraduate degree transcript (GPA: 3.8)"],
        missing: ["Statement of Purpose document", "Referee recommendation letters"],
        evidence: [
          { claim: "Passport identity match", status: "Verified", source: "Passport.pdf" },
          { claim: "Transcript degree confirmed", status: "Verified", source: "Undergraduate_Transcript.pdf" }
        ],
        output: "Extracted 2 verified documents; detected 2 outstanding references.",
        nextSteps: ["Formulate requirement matrix"]
      };
    case "requirement":
      return {
        summary: "Built requirement matrix from scholarship guidelines.",
        findings: [
          "Requirement 1: Valid government-issued photo ID",
          "Requirement 2: Official undergraduate transcript",
          "Requirement 3: Personal Statement of Purpose",
          "Requirement 4: 2 Letters of Recommendation"
        ],
        missing: [],
        evidence: [
          { claim: "Identity document required", status: "Verified", source: "Guidelines Section 2.1" },
          { claim: "Transcript required", status: "Verified", source: "Guidelines Section 2.2" },
          { claim: "Statement of Purpose required", status: "Verified", source: "Guidelines Section 2.3" },
          { claim: "Letters of recommendation required", status: "Verified", source: "Guidelines Section 2.4" }
        ],
        output: "4 explicit requirements established.",
        nextSteps: ["Execute gap comparison against extracted evidence"]
      };
    case "gap":
      return {
        summary: "Gap analysis identifies 2 fulfilled items, 1 missing document, and 1 pending response.",
        findings: [
          "Identity document: Verified and on file",
          "Academic transcript: Verified and on file",
          "Statement of purpose: Missing upload",
          "Recommendation letter: Pending referee submission"
        ],
        missing: ["Statement of purpose"],
        evidence: [
          { claim: "Statement of purpose missing", status: "Missing", source: "Gap Agent Audit" },
          { claim: "Referee letters pending", status: "Pending", source: "Referee Portal" }
        ],
        output: "Attention needed: Statement of purpose must be uploaded.",
        nextSteps: ["Perform claim verification across existing records"]
      };
    case "verification":
      return {
        summary: "Cross-checked supplied credentials and verified record authenticity.",
        findings: [
          "Passport details match applicant profile completely",
          "Academic transcript satisfies minimum GPA requirement (3.8 > 3.5 threshold)"
        ],
        missing: ["Unverified Statement of Purpose"],
        evidence: [
          { claim: "Identity verified", status: "Verified", source: "Passport.pdf" },
          { claim: "Academic record verified", status: "Verified", source: "Transcript.pdf" }
        ],
        output: "Existing evidence verified with zero contradictions.",
        nextSteps: ["Prepare structured draft application dossier"]
      };
    case "draft":
      return {
        summary: "Prepared application dossier draft with placeholders.",
        findings: ["Draft ready with verified data; placeholders inserted for missing items."],
        missing: ["Statement of Purpose text"],
        evidence: [{ claim: "Dossier template assembled", status: "Verified", source: "Draft Agent" }],
        output: "Application Packet:\n- Identity: Verified\n- Transcript: Verified\n- SOP: [MISSING - PLEASE ATTACH]\n- Recommendation: [PENDING REFEREE]",
        nextSteps: ["Formulate ordered workflow action checklist"]
      };
    case "workflow":
      return {
        summary: "Formulated sequential action plan to complete submission.",
        findings: [
          "Step 1: Upload Statement of Purpose (High priority)",
          "Step 2: Follow up with recommendation letter referees",
          "Step 3: Review verified dossier and submit"
        ],
        missing: [],
        evidence: [{ claim: "Workflow timeline created", status: "Verified", source: "Workflow Agent" }],
        output: "Action plan created with 3 remaining tasks.",
        nextSteps: [
          "Upload your statement of purpose to continue verification.",
          "Check referee status.",
          "Finalize submission."
        ]
      };
    default:
      return {
        summary: `${agent.name} executed.`,
        findings: [],
        missing: [],
        evidence: [],
        output: "",
        nextSteps: []
      };
  }
}

async function runAgent(agent, task, documents, state) {
  const apiKey = process.env.GEMINI_API_KEY || process.env.API_KEY;
  if (!apiKey) {
    return getMockResult(agent, task, documents, state);
  }

  const ai = new GoogleGenAI({ apiKey });
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

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    service: "KaroAI ActionFlow",
    model,
    hasGeminiKey: Boolean(process.env.GEMINI_API_KEY || process.env.API_KEY)
  });
});

app.post("/api/run-workflow", async (req, res) => {
  try {
    const { task = "Scholarship Application", documents = "" } = req.body || {};
    let state = {};
    const results = [];
    for (const agent of agents) {
      const result = await runAgent(agent, task, documents, state);
      state = { ...state, [agent.id]: result };
      results.push({ id: agent.id, name: agent.name, status: "done", result });
    }
    res.json({
      ok: true,
      workflow: {
        task,
        model,
        agents: results,
        final: state.workflow || results[results.length - 1]?.result
      }
    });
  } catch (error) {
    console.error("Workflow execution error:", error);
    res.status(500).json({
      error: "Workflow execution failed.",
      detail: error instanceof Error ? error.message : "Unknown error"
    });
  }
});

// Full-stack Vite mounting
const isDev = process.env.NODE_ENV !== "production";

async function startServer() {
  if (isDev) {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true, host, port },
      appType: "spa"
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, "dist");
    app.use(express.static(distPath));
    app.get("*", (_req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(port, host, () => {
    console.log(`KaroAI ActionFlow server running on http://${host}:${port}`);
  });
}

startServer().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
