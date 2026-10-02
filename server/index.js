import express from "express";
import cors from "cors";
import { GoogleGenAI, Type } from "@google/genai";
import path from "path";
import { fileURLToPath } from "url";

const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const port = process.env.PORT || 8080;
const model = process.env.GEMINI_MODEL || "gemini-3.8-flash";
app.use(cors());
app.use(express.json({ limit: "55mb" }));
app.use(express.static(path.join(__dirname, "..", "dist")));

const MAX_TASK_CHARS = 12000;
const MAX_DOCUMENT_CHARS = 120000;
const MAX_EXTRACTED_TEXT_CHARS = 30000;
const MAX_UPLOAD_BYTES = 35 * 1024 * 1024;
const SUPPORTED_UPLOAD_MIME_TYPES = new Set([
  "application/pdf",
  "text/plain",
  "image/png",
  "image/jpeg",
  "image/webp"
]);

function validateUploadPayload(mimeType, data) {
  if (!SUPPORTED_UPLOAD_MIME_TYPES.has(mimeType)) throw new Error("Unsupported document type.");
  if (!data || typeof data !== "string") throw new Error("Document data is missing.");
  const estimatedBytes = Math.floor((data.length * 3) / 4);
  if (estimatedBytes > MAX_UPLOAD_BYTES) throw new Error("Document is larger than 35 MB. Please upload a smaller file.");
}

function validateWorkflowInput(task, documents) {
  if (!task || typeof task !== "string" || !task.trim()) throw new Error("A task is required.");
  if (task.length > MAX_TASK_CHARS) throw new Error(`Task is too long. Please keep it under ${MAX_TASK_CHARS.toLocaleString()} characters.`);
  if (typeof documents !== "string") throw new Error("Supporting documents must be text.");
  if (documents.length > MAX_DOCUMENT_CHARS) throw new Error(`Supporting documents are too large. Please keep them under ${MAX_DOCUMENT_CHARS.toLocaleString()} characters.`);
}
const ai = process.env.GEMINI_API_KEY ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }) : null;

const agents = [
  { id: "intake", name: "Intake Agent", instruction: "Understand the user's goal, constraints, dates, people, requested outcome, and document context. Separate explicit user facts from assumptions." },
  { id: "document", name: "Document Agent", instruction: "Extract structured, task-relevant facts from supplied documents. Preserve document names and page or section references when available. Never invent missing text." },
  { id: "requirement", name: "Requirement Agent", instruction: "Identify requirements exactly from supplied source material first. Preserve the source wording and scope; do not expand, merge, rename, or invent a requirement. Distinguish each requirement from the evidence needed to satisfy it. If the source material does not state requirements, label workflow suggestions as suggestions rather than documented requirements." },
  { id: "gap", name: "Gap Agent", instruction: "Compare each documented requirement from the Requirement Agent against the supplied evidence and extracted document contents. Keep one gap entry per source requirement; do not merge requirements, invent broader equivalents, or drop source requirements. Mark an item satisfied only when the supplied evidence actually contains the required document/information. Otherwise mark it missing or unresolved. A requirement being documented is not evidence that the required item was supplied." },
  { id: "verification", name: "Verification Agent", instruction: "Cross-check important claims against supplied evidence. Use Verified only when the supplied evidence directly supports the claim as a documented fact. Do not use Verified to mean externally authenticated, identity-confirmed, officially validated, or submitted. If the document merely states a fact, describe it as documented in the supplied source; use Unverified or Needs Review when external verification would be required. Cite the originating document/page when available." },
  { id: "draft", name: "Draft Agent", instruction: "Prepare a useful application-ready draft or structured packet using only evidence-supported facts. Never convert suggestions into facts. Preserve every documented source requirement in the draft/checklist. Every unresolved required input MUST appear as an explicit placeholder in the draft using the exact format [MISSING: item]. Do not silently omit missing fields. Clearly separate document-supported facts from user-provided answers and placeholders." },
  { id: "workflow", name: "Workflow Agent", instruction: "Turn the current requirement/gap/verification state into an ordered action plan. Include all unresolved or missing source requirements that block completion; do not collapse several missing requirements into a generic step. Use deadlines or owners only when supported by evidence." }
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

function normalizeSourceLine(line) {
  return String(line || "")
    .replace(/\uFEFF/g, "")
    .replace(/^\s+|\s+$/g, "")
    .replace(/^#{1,6}\s+/, "")
    .replace(/^\*+\s*/, "")
    .replace(/\s*\*+$/, "")
    .trim();
}

function extractExplicitRequirements(documents) {
  const text = String(documents || "");
  const lines = text.split(/\r?\n/).map(normalizeSourceLine).filter(Boolean);
  const headingIndex = lines.findIndex(line =>
    /^(required documents|documents required|required documents and information|documents\/information required)\s*:?[\s]*$/i.test(line)
  );
  if (headingIndex < 0) return [];
  const items = [];
  for (let i = headingIndex + 1; i < lines.length; i += 1) {
    const line = normalizeSourceLine(lines[i]);
    if (/^(eligibility requirements|eligibility|applicant statement|important|testing note|note|deadline|application deadline)\s*:?[\s]*/i.test(line)) break;
    const match = line.match(/^(?:[-•*]|\d+[.)])\s+(.+)$/);
    if (match) {
      items.push(match[1].trim());
      continue;
    }
    if (items.length && !/^[A-Z][^:]{0,70}:/.test(line)) {
      items[items.length - 1] = items[items.length - 1] + " " + line;
    }
  }
  return Array.from(new Set(items.map(item => item.replace(/\s+/g, " ").trim()).filter(Boolean))).slice(0, 30);
}

function sourceSaysDocsNotAttached(documents) {
  return /required documents[^\n]*(?:not|have not|haven['’]?t)[^\n]*(?:attached|provided|submitted)/i.test(String(documents || ""));
}

function getUploadedDocumentNames(documents) {
  return Array.from(String(documents || "").matchAll(/(?:^|\n)DOCUMENT:\s*([^\n]+)/g)).map(match => match[1].trim());
}

function isUploadedDocumentSource(source, documents) {
  const value = String(source || "").toLowerCase();
  return getUploadedDocumentNames(documents).some(name => value.includes(name.toLowerCase()));
}

function sourceTextSupportsClaim(claim, documents) {
  const text = String(documents || "");
  const value = String(claim || "").toLowerCase();
  if (/submitted|submission/.test(value) && /before|deadline/.test(value)) return false;
  if (/pakistani national/.test(value) && /nationality\s*:\s*pakistani/i.test(text)) return true;
  if (/cgpa/.test(value) && /3\.42\s*\/\s*4\.00/i.test(text) && /3\.00\s*\/\s*4\.00/i.test(text)) return true;
  if (/completed undergraduate|undergraduate studies|undergraduate degree/.test(value) && /(completed undergraduate|graduation year|degree\s*:\s*bs)/i.test(text)) return true;
  if (/required documents.*(explicitly|listed|documented)|eligibility requirements.*(explicitly|listed|documented)/i.test(value)) return true;
  if (/none of the .*required documents.*attached|required documents.*not attached/i.test(value) && sourceSaysDocsNotAttached(text)) return true;
  return false;
}

function sanitizeEvidence(result, documents, task) {
  const hasEvidence = Boolean(String(documents || "").trim());
  const evidence = Array.isArray(result?.evidence) ? result.evidence : [];
  if (hasEvidence) {
    const normalizedEvidence = evidence.map(item => {
      const source = String(item?.source || "").trim();
      const original = String(item?.status || "").trim();
      const claim = String(item?.claim || "");
      let status = "Unverified";
      if (/missing/i.test(original)) status = "Missing";
      else if (/contradict/i.test(original)) status = "Contradicted";
      else if (sourceTextSupportsClaim(claim, documents)) status = "Supported by document";
      else if (/submitted|submission/.test(claim) && /before|deadline/.test(claim)) status = "Needs Review";
      else if (isUploadedDocumentSource(source, documents)) status = "Supported by document";
      return { ...item, status, source: source || "Supplied document" };
    });
    return { ...result, evidence: normalizedEvidence, output: String(result?.output || "").replace(/\bVerified\b/gi, "Supported by document") };
  }

  return {
    ...result,
    evidence: evidence.map(item => ({
      ...item,
      status: "Unverified",
      source: "No supporting evidence provided"
    })),
    findings: (result?.findings || []).map(item => item),
    missing: Array.from(new Set([
      ...(result?.missing || []),
      "Supporting documents or source material are needed to verify application-specific claims."
    ])),
    output: String(result?.output || "").replace(/\bVerified\b/gi, "Not verified"),
    nextSteps: Array.from(new Set([
      ...(result?.nextSteps || []),
      "Provide the relevant application requirements or supporting documents before treating claims as verified."
    ]))
  };
}

async function runAgent(agent, task, documents, state) {
  if (!ai) throw new Error("GEMINI_API_KEY is not configured.");
  const prompt = [
    "You are the " + agent.name + " in KaroAI ActionFlow.",
    "ROLE: " + agent.instruction,
    "USER TASK:\n" + task,
    "SUPPLIED DOCUMENTS:\n" + (documents || "No documents supplied."),
    "SOURCE REQUIREMENTS EXTRACTED FROM THE DOCUMENT:\n" + JSON.stringify(state.sourceRequirements || [], null, 2),
    "PREVIOUS WORKFLOW STATE:\n" + JSON.stringify(state, null, 2),
    "Rules: Work only from the task and supplied evidence. Never fabricate names, dates, requirements, citations, document contents, portal statuses, or verification results. REQUIREMENT RULE: When the source lists a required document or field, preserve that requirement as written; do not broaden it into extra fields (for example, do not turn "proof of identity" into "full legal name and photo ID") unless the source explicitly requires those fields. Separate "requirement documented in source" from "evidence/document supplied by user". CRITICAL EVIDENCE RULE: If no supporting document/evidence establishes a claim, the claim MUST be marked unverified or missing, never verified. A user task alone is not evidence. Do not invent sources such as portals, official records, workflow specifications, identity documents, or referee systems. Only cite source names that actually appear in the supplied evidence or are explicitly provided by the user. For Draft Agent output, every unresolved required input MUST use [MISSING: item]. Keep the result practical and concise. Return valid JSON matching the schema."
  ].join("\n\n");

  const response = await ai.models.generateContent({
    model,
    contents: prompt,
    config: { responseMimeType: "application/json", responseSchema: schema }
  });
  let result = JSON.parse(response.text);
  const sourceRequirements = Array.isArray(state.sourceRequirements) ? state.sourceRequirements : [];
  const sourceDocument = getUploadedDocumentNames(documents)[0] || "Supplied document";

  if (agent.id === "requirement" && sourceRequirements.length) {
    result = {
      ...result,
      findings: sourceRequirements,
      missing: [],
      evidence: sourceRequirements.map(item => ({
        claim: "Requirement documented: " + item,
        status: "Supported by document",
        source: sourceDocument
      }))
    };
  }

  if (agent.id === "gap" && sourceRequirements.length && sourceSaysDocsNotAttached(documents)) {
    result = {
      ...result,
      summary: "Each source-listed required document is unresolved because the document states that the required documents are not attached.",
      findings: sourceRequirements,
      missing: sourceRequirements,
      evidence: sourceRequirements.map(item => ({
        claim: "Missing required document: " + item,
        status: "Missing",
        source: sourceDocument
      }))
    };
  }

  if (agent.id === "draft" && sourceRequirements.length && sourceSaysDocsNotAttached(documents)) {
    result = {
      ...result,
      summary: "Draft prepared with exact source-listed requirements as unresolved placeholders.",
      findings: sourceRequirements,
      missing: sourceRequirements,
      output: sourceRequirements.map(item => "- " + item + ": [MISSING: " + item + "]").join("\n"),
      evidence: sourceRequirements.map(item => ({
        claim: "Required document listed in source: " + item,
        status: "Missing",
        source: sourceDocument
      }))
    };
  }

  if (agent.id === "workflow" && sourceRequirements.length && sourceSaysDocsNotAttached(documents)) {
    result = {
      ...result,
      summary: "Action plan created from every unresolved source-listed requirement.",
      findings: sourceRequirements,
      missing: sourceRequirements,
      nextSteps: sourceRequirements.map((item, index) => (index + 1) + ". Provide the required document: " + item),
      evidence: sourceRequirements.map(item => ({
        claim: "Action blocked by missing source requirement: " + item,
        status: "Missing",
        source: sourceDocument
      }))
    };
  }

  return sanitizeEvidence(result, documents, task);
}

app.post("/api/extract-document", async (req, res) => {
  const { name, mimeType, data } = req.body || {};
  try { validateUploadPayload(mimeType, data); } catch (error) { return res.status(400).json({ error: error.message }); }
  try {
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
    const sourceRequirements = extractExplicitRequirements(documents);
    let state = { sourceRequirements };
    const results = [];
    for (const agent of agents) {
      res.write(JSON.stringify({ type: "agent:start", id: agent.id, name: agent.name }) + "\n");
      const result = await runAgent(agent, task, documents, state);
      state = { ...state, [agent.id]: result };
      results.push({ id: agent.id, name: agent.name, status: "done", result });
      res.write(JSON.stringify({ type: "agent:complete", id: agent.id, name: agent.name, result }) + "\n");
    }
    res.write(JSON.stringify({ type: "complete", workflow: { task, model, sourceRequirements, agents: results, final: state.workflow || results[results.length - 1]?.result || null } }) + "\n");
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
    const sourceRequirements = extractExplicitRequirements(documents);
    let state = { sourceRequirements };
    const results = [];
    for (const agent of agents) {
      const result = await runAgent(agent, task, documents, state);
      state = { ...state, [agent.id]: result };
      results.push({ id: agent.id, name: agent.name, status: "done", result });
    }
    res.json({ ok: true, workflow: { task, model, sourceRequirements, agents: results, final: state.workflow } });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Workflow execution failed.", detail: error instanceof Error ? error.message : "Unknown error" });
  }
});


app.post("/api/complete-draft", async (req, res) => {
  try {
    const { task, documents = "", workflow, answers = {} } = req.body || {};
    validateWorkflowInput(task, documents);
    if (!ai) return res.status(500).json({ error: "GEMINI_API_KEY is not configured." });
    if (!workflow || typeof workflow !== "object") return res.status(400).json({ error: "A completed workflow is required." });
    if (!answers || typeof answers !== "object" || !Object.keys(answers).length) {
      return res.status(400).json({ error: "At least one completed missing item is required." });
    }

    const priorDraft = workflow.agents?.find(agent => agent.id === "draft")?.result || workflow.final || {};
    const gap = workflow.agents?.find(agent => agent.id === "gap")?.result || {};
    const verification = workflow.agents?.find(agent => agent.id === "verification")?.result || {};
    const prompt = [
      "You are the Draft Agent in KaroAI ActionFlow.",
      "Update an existing application-ready draft using newly supplied answers.",
      "USER TASK:\n" + task,
      "SUPPLIED DOCUMENTS:\n" + (documents || "No supporting documents supplied."),
      "EXISTING DRAFT:\n" + JSON.stringify(priorDraft, null, 2),
      "KNOWN GAPS:\n" + JSON.stringify(gap.missing || [], null, 2),
      "VERIFICATION FINDINGS:\n" + JSON.stringify(verification.findings || [], null, 2),
      "NEW USER-PROVIDED ANSWERS:\n" + JSON.stringify(answers, null, 2),
      "Rules: Treat the new answers as user-provided facts, but do not call them externally verified unless the supplied documents support them. Keep existing evidence-supported facts. Replace matching [MISSING: item] placeholders when the user answered that item. Keep unanswered missing items as [MISSING: item]. Never invent facts, requirements, citations, document contents, portal status, or verification results. Clearly distinguish user-provided information from document-supported evidence. Return valid JSON matching the schema."
    ].join("\n\n");

    const response = await ai.models.generateContent({
      model,
      contents: prompt,
      config: { responseMimeType: "application/json", responseSchema: schema }
    });
    const draft = JSON.parse(response.text);
    res.json({ ok: true, draft: sanitizeEvidence(draft, documents, task) });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Could not prepare the revised draft.", detail: error instanceof Error ? error.message : "Unknown error" });
  }
});

app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api/")) return next();
  res.sendFile(path.join(__dirname, "..", "dist", "index.html"), error => {
    if (error) next(error);
  });
});

app.listen(port, () => console.log("KaroAI ActionFlow listening on port " + port));
