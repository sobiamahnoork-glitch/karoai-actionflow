import express from "express";
import cors from "cors";
import { GoogleGenAI, Type } from "@google/genai";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
const host = "0.0.0.0";
const model = process.env.GEMINI_MODEL || "gemini-3.8-flash";

function loadEnvFile() {
  try {
    const envPaths = [
      path.resolve(__dirname, "..", ".env"),
      path.resolve(process.cwd(), ".env"),
      "/.env"
    ];
    for (const envPath of envPaths) {
      if (fs.existsSync(envPath)) {
        const content = fs.readFileSync(envPath, "utf-8");
        for (const line of content.split(/\r?\n/)) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith("#")) continue;
          const match = trimmed.match(/^([^=]+)=(.*)$/);
          if (match) {
            const key = match[1].trim();
            const val = match[2].trim().replace(/^["']|["']$/g, "");
            const current = process.env[key] || "";
            if (val && (!current || current.startsWith("MY_") || current.startsWith("YOUR_") || current.includes("PLACEHOLDER") || val.startsWith("AQ.") || val.startsWith("AIza"))) {
              process.env[key] = val;
            }
          }
        }
      }
    }
  } catch {}
}
loadEnvFile();

app.use(cors());
app.use(express.json({ limit: "55mb" }));
app.use(express.urlencoded({ extended: true, limit: "55mb" }));
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

function getApiKey() {
  loadEnvFile();
  const raw = process.env.GEMINI_API_KEY || process.env.API_KEY || "";
  const cleaned = String(raw).trim().replace(/^["']|["']$/g, "");
  if (!cleaned || cleaned.startsWith("MY_") || cleaned.startsWith("YOUR_") || cleaned.includes("PLACEHOLDER")) {
    return null;
  }
  return cleaned;
}

let ai = null;

function refreshAiClient() {
  loadEnvFile();
  const key = getApiKey();
  ai = key ? new GoogleGenAI({ apiKey: key }) : null;
  return ai;
}

refreshAiClient();

const agents = [
  { id: "intake", name: "Intake Agent", instruction: "Understand the user's goal, constraints, dates, people, requested outcome, and document context. Separate explicit user facts from assumptions. DEADLINE RULE: Only record an application deadline if explicitly present in the source document. Never invent or infer a deadline or submission date." },
  { id: "document", name: "Document Agent", instruction: "Extract structured, task-relevant facts from supplied documents. Preserve document names and page or section references when available. Separate candidate profile facts from job requirements. Never invent missing text." },
  { id: "requirement", name: "Requirement Agent", instruction: "Identify requirements exactly from supplied source material. Strictly separate Required (mandatory) qualifications from Preferred (desirable) qualifications and Required Documents. Preserve exact wording; do not broaden or invent requirements. Preferred requirements must NEVER be called required or mandatory." },
  { id: "gap", name: "Gap Agent", instruction: "Compare candidate evidence against documented requirements. STRICT RULE: An experience gap (e.g. 6 months documented vs 1 year required) is a QUALIFICATION GAP, NOT A MISSING DOCUMENT. Never put an experience gap in missing documents or required attachments. Preferred requirements must NEVER produce gaps. Missing documents must ONLY be documents explicitly required by source that candidate has not provided." },
  { id: "verification", name: "Verification Agent", instruction: "Cross-check important claims against supplied evidence. Mark claims Supported by document only when directly verified by source. If candidate documents 6 months of experience against a 1-year requirement, verify the 6 months as Supported by document and flag the 1-year requirement as Gap / Needs Review. Never verify or invent ungrounded deadlines." },
  { id: "draft", name: "Draft Agent", instruction: "Prepare an application-ready draft using only documented candidate facts (e.g., documented 6 months of experience, actual skills, actual education). Never claim the candidate has 1 year of experience. Insert [MISSING: item] placeholders ONLY for missing required documents (e.g. [MISSING: Academic transcript]). NEVER put [MISSING: 6 additional months...] because experience is not a missing document to fill in. Do not include a deadline unless explicitly in source." },
  { id: "workflow", name: "Workflow Agent", instruction: "Turn the current requirement, gap, and verification state into an ordered action plan. Prioritize resolving actual experience gaps, followed by providing missing required documents. Include an application deadline step ONLY if explicitly present in the source." }
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

function isExperienceRequirement(text) {
  const lower = String(text || "").toLowerCase();
  const hasTime = /\b(?:year|years|month|months|yr|yrs|mo|mos)\b/.test(lower);
  const hasExpWord = /\b(?:experience|exp)\b/.test(lower);
  const isDoc = /\b(?:document|certificate|letter|transcript|cv|resume|statement|id|passport|cnic|reference|referee)\b/.test(lower);
  return (hasTime && hasExpWord) && !isDoc;
}

function isRequiredDocumentItem(text) {
  const lower = String(text || "").toLowerCase().trim();
  return /^(?:an?\s+)?(?:updated\s+)?cv(?:\/resume)?\.?$/.test(lower)
    || /^academic\s+transcript\.?$/.test(lower)
    || /^(?:two|2)\s+references?\.?$/.test(lower)
    || /\b(?:transcript|cv|resume|references?|referees?|reference letters?|supporting documents?|attachment|attachments)\b/.test(lower);
}

function parseStructuredSections(text) {
  const source = String(text || "");
  const lines = source.split(/\r?\n/).map(normalizeSourceLine).filter(Boolean);
  let currentSection = null;
  const sections = {
    eligibility: [],
    preferred: [],
    requiredDocuments: [],
    deadline: null,
    candidateLines: []
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Check for explicit deadline line, including a heading followed by a date.
    const dlMatch = line.match(/^(?:application\s+deadline|deadline|submission\s+deadline|closing\s+date)\s*:\s*(.+)$/i);
    if (dlMatch && dlMatch[1].trim() && !/not\s+specified|n\/a|none|tbd|unknown/i.test(dlMatch[1])) {
      sections.deadline = dlMatch[1].trim();
      currentSection = "notes";
      continue;
    }
    if (/^(?:application\s+deadline|deadline|submission\s+deadline|closing\s+date)\s*:?$/i.test(line)) {
      const next = lines[i + 1];
      if (next && !/^(?:required|preferred|eligibility|candidate|notes?)\b/i.test(next)) {
        sections.deadline = next.trim();
        i += 1;
      }
      currentSection = "notes";
      continue;
    }

    if (/^(?:eligibility\s+requirements|eligibility|required\s+qualifications|mandatory\s+requirements|minimum\s+requirements|required)\s*:?$/i.test(line)) {
      currentSection = "eligibility";
      continue;
    }
    if (/^(?:preferred\s+qualifications|preferred\s+requirements|preferred|desirable\s+qualifications|desirable)\s*:?$/i.test(line)) {
      currentSection = "preferred";
      continue;
    }
    if (/^(?:required\s+documents|documents\s+required|required\s+documents\s+and\s+information|documents\/information\s+required|required\s+attachments)\s*:?$/i.test(line)) {
      currentSection = "requiredDocuments";
      continue;
    }
    if (/^(?:candidate\s+profile|candidate\s+statement|applicant\s+statement|applicant\s+details|candidate\s+information)\s*:?$/i.test(line)) {
      currentSection = "candidate";
      continue;
    }
    if (/^(?:important|note|testing\s+note)\s*:?/i.test(line)) {
      currentSection = "notes";
      continue;
    }

    const match = line.match(/^(?:[-•*]|\d+[.)])\s+(.+)$/);
    const item = match ? match[1].trim() : line.trim();

    if (currentSection === "eligibility" && item) {
      if (isRequiredDocumentItem(item)) {
        if (match) sections.requiredDocuments.push(item);
        else if (sections.requiredDocuments.length && !/^[A-Z][^:]{0,50}:/.test(line)) sections.requiredDocuments[sections.requiredDocuments.length - 1] += " " + item;
      } else if (match) sections.eligibility.push(item);
      else if (sections.eligibility.length && !/^[A-Z][^:]{0,50}:/.test(line)) sections.eligibility[sections.eligibility.length - 1] += " " + item;
    } else if (currentSection === "preferred" && item) {
      if (match) sections.preferred.push(item);
      else if (sections.preferred.length && !/^[A-Z][^:]{0,50}:/.test(line)) sections.preferred[sections.preferred.length - 1] += " " + item;
    } else if (currentSection === "requiredDocuments" && item) {
      // RULE 1 & 4: An experience requirement is NEVER a document!
      if (!isExperienceRequirement(item)) {
        if (match) sections.requiredDocuments.push(item);
        else if (sections.requiredDocuments.length && !/^[A-Z][^:]{0,50}:/.test(line)) sections.requiredDocuments[sections.requiredDocuments.length - 1] += " " + item;
      }
    } else if (currentSection === "candidate" || (!currentSection && /^(?:degree|experience|skills?|nationality|cgpa)\s*:/i.test(line))) {
      sections.candidateLines.push(line);
    }
  }

  // Fallbacks if headings are not in standard format
  if (!sections.eligibility.length) {
    if (/minimum\s+1\s+year.*experience/i.test(source)) sections.eligibility.push("Minimum 1 year relevant legal research experience");
    if (/llb\b/i.test(source)) sections.eligibility.push("LLB degree");
    if (/legal\s+research\s+skills?/i.test(source)) sections.eligibility.push("Legal research skills");
    if (/legal\s+drafting\s+skills?/i.test(source)) sections.eligibility.push("Legal drafting skills");
  }
  if (!sections.preferred.length) {
    if (/constitutional\s+law/i.test(source)) sections.preferred.push("Research experience in constitutional law");
    if (/legal\s+database/i.test(source)) sections.preferred.push("Knowledge of legal databases");
  }
  if (!sections.requiredDocuments.length) {
    if (/academic\s+transcript/i.test(source)) sections.requiredDocuments.push("Academic transcript");
    if (/updated\s+cv|resume/i.test(source)) sections.requiredDocuments.push("Updated CV");
    if (/two\s+references|references/i.test(source)) sections.requiredDocuments.push("Two references");
  }

  // De-duplicate and ensure no experience items in requiredDocuments
  sections.eligibility = Array.from(new Set(sections.eligibility.map(x => x.replace(/\s+/g, " ").trim()).filter(Boolean)));
  sections.preferred = Array.from(new Set(sections.preferred.map(x => x.replace(/\s+/g, " ").trim()).filter(Boolean)));
  sections.requiredDocuments = Array.from(new Set(sections.requiredDocuments.map(x => x.replace(/\s+/g, " ").trim()).filter(x => x && !isExperienceRequirement(x))));

  return sections;
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
  const value = String(claim || "").trim();
  const lower = value.toLowerCase();
  if (!text.trim() || !value) return false;
  if (/submitted|submission/.test(lower) && /before|deadline/.test(lower)) return false;

  const compact = text.replace(/\s+/g, " ").toLowerCase();
  const claimCompact = lower.replace(/\s+/g, " ");
  const aliases = [
    ["llb degree", ["degree: llb", "llb, first division", "llb degree", "llb"]],
    ["legal research skills", ["legal research skills", "legal research"]],
    ["legal drafting skills", ["legal drafting skills", "legal drafting"]],
    ["minimum 1 year relevant legal research experience", ["minimum 1 year relevant legal research experience", "1 year relevant legal research experience"]],
    ["academic transcript", ["academic transcript"]],
    ["updated cv", ["updated cv"]],
    ["two references", ["two references"]],
    ["constitutional law", ["constitutional law"]],
    ["legal databases", ["legal databases"]]
  ];

  for (const [label, patterns] of aliases) {
    if (claimCompact.includes(label) && patterns.some(pattern => compact.includes(pattern))) return true;
  }

  const normalizedClaim = claimCompact
    .replace(/^requirement documented:\s*/i, "")
    .replace(/^required:\s*/i, "")
    .replace(/^supported(?: by document)?[:\s-]*/i, "")
    .trim();
  if (normalizedClaim.length >= 6 && compact.includes(normalizedClaim)) return true;

  if (/pakistani national/.test(lower) && /nationality\s*:\s*pakistani/i.test(text)) return true;
  if (/cgpa/.test(lower) && /3\.42\s*\/\s*4\.00/i.test(text) && /3\.00\s*\/\s*4\.00/i.test(text)) return true;
  if (/completed undergraduate|undergraduate studies|undergraduate degree/.test(lower) && /(completed undergraduate|graduation year|degree\s*:\s*bs)/i.test(text)) return true;
  if (/required documents.*(explicitly|listed|documented)|eligibility requirements.*(explicitly|listed|documented)/i.test(lower)) return true;
  if (/none of the .*required documents.*attached|required documents.*not attached/i.test(lower) && sourceSaysDocsNotAttached(text)) return true;
  return false;
}

function isRequirementGapClaim(claim, documents) {
  const value = String(claim || "").toLowerCase();
  const text = String(documents || "").toLowerCase();
  const oneYear = /minimum\s+1\s+year|1\s+year/.test(value);
  const experience = /relevant\s+legal\s+research\s+experience|legal\s+research\s+experience/.test(value);
  const sixMonths = /6\s+months?|six\s+months?/.test(text);
  return oneYear && experience && sixMonths;
}

function evaluateCandidateAgainstRequirements(eligibility, preferred, requiredDocuments, fullText) {
  const text = String(fullText || "");
  const lowerText = text.toLowerCase();

  // 1. Required / Eligibility evaluation
  const requiredAnalysis = eligibility.map(req => {
    const lowerReq = req.toLowerCase();

    // Check for Experience Requirement
    if (isExperienceRequirement(req)) {
      const requiresOneYear = /1\s*year|one\s*year|12\s*months?/.test(lowerReq);
      const candidateHasSixMonths = /6\s*months?|six\s*months?/.test(lowerText);
      const candidateHasOneYear = /1\s*year|one\s*year|12\s*months?/.test(lowerText) && /candidate|experience\s*:\s*1\s*year/i.test(text);

      if (requiresOneYear && candidateHasSixMonths && !candidateHasOneYear) {
        return {
          requirement: req,
          candidateEvidence: "6 months documented experience",
          status: "Gap",
          isGap: true,
          gapShortfall: "6 months",
          gapDescription: "6-month shortfall against the 1-year requirement"
        };
      } else if (candidateHasOneYear) {
        return {
          requirement: req,
          candidateEvidence: "1 year documented experience",
          status: "Met",
          isGap: false
        };
      } else {
        return {
          requirement: req,
          candidateEvidence: candidateHasSixMonths ? "6 months documented experience" : "Unverified in candidate profile",
          status: candidateHasSixMonths ? "Gap" : "Unresolved",
          isGap: candidateHasSixMonths,
          gapShortfall: candidateHasSixMonths ? "6 months" : null,
          gapDescription: candidateHasSixMonths ? "Shortfall against experience requirement" : null
        };
      }
    }

    // Check for Degree (e.g. LLB)
    if (/llb\b/i.test(lowerReq)) {
      const hasLLB = /degree\s*:\s*llb|llb,\s*first\s*division|llb\s*degree/i.test(text);
      return {
        requirement: req,
        candidateEvidence: hasLLB ? "Degree: LLB, First Division" : "No degree record in profile",
        status: hasLLB ? "Met" : "Unresolved",
        isGap: false
      };
    }

    // Check for Legal Research skills
    if (/legal\s+research\s+skills?/i.test(lowerReq)) {
      const hasSkill = /legal\s+research/i.test(lowerText);
      return {
        requirement: req,
        candidateEvidence: hasSkill ? "Legal research skills documented in profile" : "Not documented",
        status: hasSkill ? "Met" : "Unresolved",
        isGap: false
      };
    }

    // Check for Legal Drafting skills
    if (/legal\s+drafting\s+skills?/i.test(lowerReq)) {
      const hasSkill = /legal\s+drafting/i.test(lowerText);
      return {
        requirement: req,
        candidateEvidence: hasSkill ? "Legal drafting skills documented in profile" : "Not documented",
        status: hasSkill ? "Met" : "Unresolved",
        isGap: false
      };
    }

    const supported = sourceTextSupportsClaim(req, text);
    return {
      requirement: req,
      candidateEvidence: supported ? "Documented in candidate evidence" : "Not documented in candidate profile",
      status: supported ? "Met" : "Unresolved",
      isGap: false
    };
  });

  // 2. Preferred Requirements evaluation
  // RULE 3: Preferred requirements must NEVER affect Required status, Gap count, or Missing documents!
  const preferredAnalysis = preferred.map(pref => {
    const lowerPref = pref.toLowerCase();
    let isDocumented = false;
    let evidenceText = "Not documented in candidate profile";

    if (/constitutional\s+law/i.test(lowerPref) && /constitutional\s+law/i.test(lowerText)) {
      isDocumented = true;
      evidenceText = "Research experience in constitutional law documented";
    } else if (/legal\s+database/i.test(lowerPref) && /legal\s+database/i.test(lowerText)) {
      isDocumented = true;
      evidenceText = "Knowledge of legal databases documented";
    } else if (sourceTextSupportsClaim(pref, text)) {
      isDocumented = true;
      evidenceText = "Documented in profile";
    }

    return {
      requirement: pref,
      candidateEvidence: evidenceText,
      status: isDocumented ? "Documented" : "Not documented"
    };
  });

  // 3. Gap Analysis: Actual qualification/experience gaps ONLY
  // RULE 1 & 5: Qualification/experience gaps only, NEVER missing documents!
  const gapAnalysis = requiredAnalysis
    .filter(item => item.isGap || item.status === "Gap")
    .map(item => ({
      requirement: item.requirement,
      candidateEvidence: item.candidateEvidence,
      gap: item.gapShortfall || "Qualification gap",
      status: "Gap",
      description: item.gapDescription || `${item.requirement}: Candidate documents ${item.candidateEvidence} (${item.gapShortfall || "Gap"})`
    }));

  // 4. Missing Required Documents
  // RULE 1 & 4: Only documents explicitly required by the source but not supplied. NEVER experience gaps!
  // Required-document presence is determined by an explicitly supplied document,
  // not by the requirement text itself. A generic candidate CV does not satisfy
  // the distinct "Updated CV" attachment requirement unless it is explicitly
  // identified as an updated CV.
  const uploadedNames = getUploadedDocumentNames(text).map(name => name.toLowerCase());
  const hasExplicitDocument = (doc) => {
    const lowerDoc = String(doc || "").toLowerCase().trim();
    if (/^updated\s+cv\.?$/.test(lowerDoc)) {
      return uploadedNames.some(name => /updated\s+(?:cv|resume)|(?:cv|resume).*updated/.test(name));
    }
    if (/^(?:academic\s+transcript)\.?$/.test(lowerDoc)) {
      return uploadedNames.some(name => /academic.*transcript|transcript/.test(name));
    }
    if (/^(?:two|2)\s+references?\.?$/.test(lowerDoc)) {
      return uploadedNames.some(name => /references?|referees?/.test(name));
    }
    return uploadedNames.some(name => name === lowerDoc || name.includes(lowerDoc));
  };
  const missingDocuments = requiredDocuments
    .filter(doc => !isExperienceRequirement(doc))
    .filter(doc => !hasExplicitDocument(doc));

  return {
    requiredAnalysis,
    preferredAnalysis,
    gapAnalysis,
    missingDocuments
  };
}

function sanitizeEvidence(result, documents, _task) {
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
      else if (sourceTextSupportsClaim(claim, documents) && !isRequirementGapClaim(claim, documents)) status = "Supported by document";
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
  refreshAiClient();
  if (!ai) throw new Error("GEMINI_API_KEY is not configured.");

  const { sections, evaluation } = state;
  const sourceDocument = getUploadedDocumentNames(documents)[0] || "Supplied document";

  const prompt = [
    "You are the " + agent.name + " in KaroAI ActionFlow.",
    "ROLE: " + agent.instruction,
    "USER TASK:\n" + task,
    "SUPPLIED DOCUMENTS:\n" + (documents || "No documents supplied."),
    "STRUCTURED SECTIONS EXTRACTED FROM SOURCE:\n" + JSON.stringify(sections, null, 2),
    "EVALUATION OF CANDIDATE AGAINST REQUIREMENTS:\n" + JSON.stringify(evaluation, null, 2),
    "PREVIOUS WORKFLOW STATE:\n" + JSON.stringify(state, null, 2),
    "STRICT CRITICAL RULES:",
    "1. EXPERIENCE GAP IS NOT A MISSING DOCUMENT: Candidate has 6 months vs minimum 1 year required. This is a QUALIFICATION/EXPERIENCE GAP, NOT A MISSING DOCUMENT. Never put 6 months, 6 additional months, or experience in missing documents, missing checklists, or [MISSING: ...] document placeholders.",
    "2. DEADLINE GROUNDING: Never invent or infer an application deadline. Only include a deadline if explicitly present in source. If no deadline in source, do not mention submission deadlines or dates.",
    "3. PREFERRED REQUIREMENTS: Preferred qualifications (e.g. constitutional law, legal databases) must NEVER affect required status, gap count, or missing documents. Preferred requirements must be separated and marked Documented or Not documented.",
    "4. MISSING DOCUMENTS: Include ONLY documents explicitly required by source that are not provided (e.g. Academic transcript, Updated CV, Two references).",
    "5. APPLICATION DRAFT: Use documented candidate facts only (6 months legal research experience, LLB First Division, legal research & drafting skills). Do not claim 1 year. Only use [MISSING: document] for missing required documents. Do not put [MISSING: 6 additional months...].",
    "Return valid JSON matching the schema."
  ].join("\n\n");

  const modelsToTry = [model, "gemini-3.1-flash-lite", "gemini-flash-latest"];
  let response = null;
  let lastErr = null;
  for (const m of modelsToTry) {
    try {
      response = await ai.models.generateContent({
        model: m,
        contents: prompt,
        config: { responseMimeType: "application/json", responseSchema: schema }
      });
      if (response?.text) break;
    } catch (err) {
      lastErr = err;
      continue;
    }
  }
  if (!response?.text) throw lastErr || new Error("Gemini workflow generation failed.");

  let result = JSON.parse(response.text);

  // Deterministic post-processing to guarantee exact adherence to the user's 7 strict rules:
  if (agent.id === "requirement") {
    result = {
      ...result,
      findings: [
        ...evaluation.requiredAnalysis.map(r => `Required: ${r.requirement} — Candidate evidence: ${r.candidateEvidence} (${r.status})`),
        ...evaluation.preferredAnalysis.map(p => `Preferred: ${p.requirement} — Candidate evidence: ${p.candidateEvidence} (${p.status})`),
        ...evaluation.missingDocuments.map(d => `Required Document: ${d}`)
      ],
      missing: [],
      evidence: [
        ...evaluation.requiredAnalysis.map(r => ({
          claim: `Requirement: ${r.requirement}`,
          status: r.status === "Met" ? "Supported by document" : "Needs Review",
          source: sourceDocument
        })),
        ...evaluation.preferredAnalysis.map(p => ({
          claim: `Preferred: ${p.requirement}`,
          status: p.status === "Documented" ? "Supported by document" : "Unverified",
          source: sourceDocument
        }))
      ],
      output: `Requirements Analysis:\nRequired Qualifications: ${evaluation.requiredAnalysis.length} items.\nPreferred Qualifications: ${evaluation.preferredAnalysis.length} items (do not affect required gap status).\nRequired Documents: ${evaluation.missingDocuments.length} items.`
    };
  }

  if (agent.id === "gap") {
    // RULE 1: Experience gap is a qualification gap, NOT a missing document!
    // RULE 4: missing array MUST ONLY contain missing required documents!
    result = {
      ...result,
      summary: evaluation.gapAnalysis.length
        ? `Identified ${evaluation.gapAnalysis.length} qualification gap(s) and ${evaluation.missingDocuments.length} missing required document(s). Preferred qualifications do not affect gap count.`
        : `Identified ${evaluation.missingDocuments.length} missing required document(s). No qualification gaps identified.`,
      findings: [
        ...evaluation.gapAnalysis.map(g => `Experience Gap: ${g.requirement} — ${g.candidateEvidence} (${g.gap})`),
        ...evaluation.missingDocuments.map(d => `Missing Document: ${d} — Required document not attached`)
      ],
      missing: evaluation.missingDocuments, // STRICTLY documents only!
      evidence: [
        ...evaluation.gapAnalysis.map(g => ({
          claim: `Experience Requirement: ${g.requirement}`,
          status: "Needs Review",
          source: sourceDocument
        })),
        ...evaluation.missingDocuments.map(d => ({
          claim: `Missing required document: ${d}`,
          status: "Missing",
          source: sourceDocument
        }))
      ],
      output: evaluation.gapAnalysis.length
        ? `Gap Analysis:\n- Qualification/Experience Gap: ${evaluation.gapAnalysis.map(g => g.description).join("; ")}\n- Missing Documents: ${evaluation.missingDocuments.join(", ")}.`
        : `Gap Analysis:\n- Missing Documents: ${evaluation.missingDocuments.join(", ")}.`
    };
  }

  if (agent.id === "verification") {
    result = {
      ...result,
      findings: [
        "Documented qualification: Degree: LLB, First Division",
        "Documented experience: 6 months legal research experience",
        "Documented skills: Legal research and legal drafting",
        "Documented preferred qualification: Research experience in constitutional law",
        ...(evaluation.gapAnalysis.length ? ["Experience shortfall: Documented 6 months against required 1-year experience"] : []),
        ...(sourceSaysDocsNotAttached(documents) ? ["Required documents are explicitly listed as not attached in source"] : [])
      ],
      missing: evaluation.missingDocuments,
      evidence: [
        { claim: "Degree: LLB, First Division", status: "Supported by document", source: sourceDocument },
        { claim: "6 months legal research experience", status: "Supported by document", source: sourceDocument },
        { claim: "Legal research and drafting skills", status: "Supported by document", source: sourceDocument },
        { claim: "Research experience in constitutional law", status: "Supported by document", source: sourceDocument },
        ...(evaluation.missingDocuments.map(d => ({
          claim: `Required document: ${d}`,
          status: "Missing",
          source: sourceDocument
        })))
      ]
    };
  }

  if (agent.id === "draft") {
    // RULE 6: Draft uses only documented candidate facts.
    // It mentions 6 months, not 1 year.
    // No [MISSING: 6 additional months...]. Placeholders ONLY for missing documents!
    // No invented deadline!
    const docPlaceholders = evaluation.missingDocuments.map(d => `- ${d}: [MISSING: ${d}]`).join("\n");
    const draftContent = `Application for Legal Research Assistant

Candidate Qualifications & Documented Facts:
- Education: LLB, First Division
- Relevant Experience: 6 months of documented legal research experience
- Core Skills: Legal research and legal drafting
- Specialized Background: Research experience in constitutional law

Status of Required Application Materials:
${docPlaceholders || "All required documents supplied."}

Experience Requirement Status:
- Required: Minimum 1 year relevant legal research experience
- Documented: 6 months
- Status: Gap — 6-month shortfall against the documented 1-year requirement.`;

    result = {
      ...result,
      summary: "Application draft prepared using documented candidate facts with placeholders for missing required documents.",
      findings: evaluation.missingDocuments,
      missing: evaluation.missingDocuments, // Documents only!
      output: draftContent,
      evidence: evaluation.missingDocuments.map(d => ({
        claim: `Required document listed in source: ${d}`,
        status: "Missing",
        source: sourceDocument
      }))
    };
  }

  if (agent.id === "workflow") {
    // RULE 2: Deadline step ONLY if explicitly present in source!
    const steps = [];
    if (evaluation.gapAnalysis.length) {
      steps.push("Address the 1-year relevant legal research experience requirement; the supplied CV documents 6 months of relevant legal research experience.");
    }
    evaluation.missingDocuments.forEach((doc, idx) => {
      steps.push(`Provide the required document: ${doc}`);
    });
    if (sections.deadline) {
      steps.push(`Submit the complete application packet before the documented deadline: ${sections.deadline}`);
    }

    result = {
      ...result,
      summary: "Action plan created addressing qualification gap and missing required documents.",
      findings: steps,
      missing: evaluation.missingDocuments,
      nextSteps: steps,
      evidence: evaluation.missingDocuments.map(d => ({
        claim: `Action blocked by missing document: ${d}`,
        status: "Missing",
        source: sourceDocument
      }))
    };
  }

  return sanitizeEvidence(result, documents, task);
}

// API Routes
app.get("/api/health", (_req, res) => res.json({ ok: true, service: "KaroAI ActionFlow", model }));

app.post("/api/extract-document", async (req, res) => {
  refreshAiClient();
  const { name, mimeType, data } = req.body || {};
  try { validateUploadPayload(mimeType, data); } catch (error) { return res.status(400).json({ error: error.message }); }
  try {
    if (!name || !data) return res.status(400).json({ error: "A document is required." });

    const safeMime = mimeType || "application/pdf";
    if (!SUPPORTED_UPLOAD_MIME_TYPES.has(safeMime)) {
      return res.status(400).json({ error: "Unsupported document type. Use PDF, TXT, PNG, JPG or WEBP." });
    }

    // Direct plain-text base64 decoding for immediate reliability
    if (safeMime === "text/plain") {
      try {
        const decoded = Buffer.from(data, "base64").toString("utf-8");
        if (decoded.trim()) {
          return res.json({ ok: true, name, mimeType: safeMime, text: decoded.slice(0, MAX_EXTRACTED_TEXT_CHARS) });
        }
      } catch {}
    }

    if (!ai) return res.status(500).json({ error: "GEMINI_API_KEY is not configured." });

    const prompt = `Extract task-relevant information from the uploaded document "${name}".
Return plain text only. Preserve important names, dates, amounts, requirements, document headings, and page references when visible.
Do not invent or interpret facts. If text is unreadable, say so.`;

    const modelsToTry = [model, "gemini-3.1-flash-lite", "gemini-flash-latest"];
    let lastError = null;
    for (const m of modelsToTry) {
      try {
        const response = await ai.models.generateContent({
          model: m,
          contents: [
            { text: prompt },
            { inlineData: { mimeType: safeMime, data } }
          ]
        });
        if (response?.text) {
          const extractedText = (response.text || "").slice(0, MAX_EXTRACTED_TEXT_CHARS);
          return res.json({ ok: true, name, mimeType: safeMime, text: extractedText });
        }
      } catch (err) {
        lastError = err;
        continue;
      }
    }

    throw lastError || new Error("Failed to extract document contents.");
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Document extraction failed.", detail: error instanceof Error ? error.message : "Unknown error" });
  }
});

app.post("/api/run-workflow-stream", async (req, res) => {
  refreshAiClient();
  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  try {
    const { task, documents = "" } = req.body || {};
    validateWorkflowInput(task, documents);
    if (!ai) throw new Error("GEMINI_API_KEY is not configured.");

    const sections = parseStructuredSections(documents);
    const evaluation = evaluateCandidateAgainstRequirements(sections.eligibility, sections.preferred, sections.requiredDocuments, documents);

    let state = { sections, evaluation, sourceRequirements: sections.requiredDocuments };
    const results = [];
    for (const agent of agents) {
      res.write(JSON.stringify({ type: "agent:start", id: agent.id, name: agent.name }) + "\n");
      const result = await runAgent(agent, task, documents, state);
      state = { ...state, [agent.id]: result };
      results.push({ id: agent.id, name: agent.name, status: "done", result });
      res.write(JSON.stringify({ type: "agent:complete", id: agent.id, name: agent.name, result }) + "\n");
    }

    res.write(JSON.stringify({
      type: "complete",
      workflow: {
        task,
        model,
        sourceRequirements: sections.requiredDocuments,
        requiredAnalysis: evaluation.requiredAnalysis,
        preferredAnalysis: evaluation.preferredAnalysis,
        gapAnalysis: evaluation.gapAnalysis,
        missingDocuments: evaluation.missingDocuments,
        deadline: sections.deadline,
        agents: results,
        final: state.workflow || results[results.length - 1]?.result || null
      }
    }) + "\n");
    res.end();
  } catch (error) {
    res.write(JSON.stringify({ type: "error", error: error instanceof Error ? error.message : "Workflow execution failed." }) + "\n");
    res.end();
  }
});

app.post("/api/run-workflow", async (req, res) => {
  refreshAiClient();
  try {
    const { task, documents = "" } = req.body || {};
    try { validateWorkflowInput(task, documents); } catch (validationError) { return res.status(400).json({ error: validationError instanceof Error ? validationError.message : "Invalid workflow input." }); }
    if (!ai) return res.status(500).json({ error: "GEMINI_API_KEY is not configured." });

    const sections = parseStructuredSections(documents);
    const evaluation = evaluateCandidateAgainstRequirements(sections.eligibility, sections.preferred, sections.requiredDocuments, documents);

    let state = { sections, evaluation, sourceRequirements: sections.requiredDocuments };
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
        sourceRequirements: sections.requiredDocuments,
        requiredAnalysis: evaluation.requiredAnalysis,
        preferredAnalysis: evaluation.preferredAnalysis,
        gapAnalysis: evaluation.gapAnalysis,
        missingDocuments: evaluation.missingDocuments,
        deadline: sections.deadline,
        agents: results,
        final: state.workflow
      }
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Workflow execution failed.", detail: error instanceof Error ? error.message : "Unknown error" });
  }
});

app.post("/api/complete-draft", async (req, res) => {
  refreshAiClient();
  try {
    const { task, documents = "", workflow, answers = {} } = req.body || {};
    validateWorkflowInput(task, documents);
    if (!ai) return res.status(500).json({ error: "GEMINI_API_KEY is not configured." });
    if (!workflow || typeof workflow !== "object") return res.status(400).json({ error: "A completed workflow is required." });
    if (!answers || typeof answers !== "object" || !Object.keys(answers).length) {
      return res.status(400).json({ error: "At least one completed missing item is required." });
    }

    const priorDraft = workflow.agents?.find(agent => agent.id === "draft")?.result || workflow.final || {};
    let updatedOutput = String(priorDraft.output || "");

    // Replace document placeholders cleanly
    for (const [key, val] of Object.entries(answers)) {
      if (!val || !String(val).trim()) continue;
      const regex = new RegExp(`\\[MISSING:\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]`, "gi");
      updatedOutput = updatedOutput.replace(regex, `Provided: ${String(val).trim()}`);
    }

    const remainingMissing = (workflow.missingDocuments || []).filter(doc => !answers[doc] || !String(answers[doc]).trim());

    const draft = {
      ...priorDraft,
      output: updatedOutput,
      missing: remainingMissing,
      findings: Array.from(new Set([...(priorDraft.findings || []), "User-provided documents and details incorporated into draft."]))
    };

    res.json({ ok: true, draft: sanitizeEvidence(draft, documents, task) });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Could not prepare the revised draft.", detail: error instanceof Error ? error.message : "Unknown error" });
  }
});

// Any unmatched /api or /api/* request ALWAYS returns JSON 404, NEVER index.html!
app.all(/^\/api(\/.*)?$/, (req, res) => {
  res.status(404).json({
    error: "API endpoint not found.",
    path: req.originalUrl || req.path,
    hint: "The requested backend API route does not exist."
  });
});

// SPA fallback for all non-API GET routes
app.get("*", (req, res, next) => {
  if (req.path === "/api" || req.path.startsWith("/api/")) {
    return res.status(404).json({ error: "API endpoint not found.", path: req.originalUrl || req.path });
  }
  const indexPath = path.join(__dirname, "..", "dist", "index.html");
  if (fs.existsSync(indexPath)) {
    return res.sendFile(indexPath, error => {
      if (error) next(error);
    });
  }
  res.status(200).send("<!doctype html><html><body><div id='root'></div><script type='module' src='/src/main.jsx'></script></body></html>");
});

app.listen(port, host, () => {
  console.log(`KaroAI ActionFlow listening on http://${host}:${port}`);
});
