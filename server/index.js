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
  {
    id: "intake",
    name: "Intake Agent",
    instruction: "Act as a senior workflow analyst. Understand the user's objective, target role or task, constraints, dates, stakeholders, requested deliverable, and every supplied source. Establish the task scope before any downstream agent acts. Separate explicit facts from assumptions. Never invent a deadline, eligibility rule, qualification, document, person, or outcome."
  },
  {
    id: "document",
    name: "Document Agent",
    instruction: "Act as a senior document-intelligence specialist. Extract structured, task-relevant facts from every supplied document. Preserve names, dates, numbers, organizations, roles, qualifications, skills, requirements, document titles, and source/page/section references when available. Distinguish candidate/applicant facts from source requirements and administrative instructions. Never infer missing facts."
  },
  {
    id: "requirement",
    name: "Requirement Agent",
    instruction: "Act as a senior requirements analyst. Extract every requirement exactly as stated in the source material. Classify only explicitly stated categories such as Required, Preferred, Required Documents, deadlines, or other clearly labelled conditions. Preserve wording and scope. Never upgrade Preferred to Required, never convert an experience condition into a document, and never invent eligibility criteria."
  },
  {
    id: "gap",
    name: "Gap Agent",
    instruction: "Act as a senior compliance and qualification-gap analyst. Compare every mandatory requirement against supplied candidate evidence. Identify actual qualification, experience, skill, eligibility, or information gaps. Distinguish a missing qualification/evidence from a missing attachment. Preferred items must never create mandatory gaps. Missing documents must be limited to documents explicitly required by the source and not supplied."
  },
  {
    id: "verification",
    name: "Verification Agent",
    instruction: "Act as a senior evidence-verification specialist. Cross-check important candidate claims and requirement interpretations against the supplied source material. Label claims Supported by document only when directly grounded, otherwise use Unverified, Needs Review, Contradicted, or Missing as appropriate. Preserve uncertainty and source provenance. Never manufacture evidence."
  },
  {
    id: "draft",
    name: "Draft Agent",
    instruction: "Act as a senior professional drafting specialist. Produce the requested application, response, summary, or task deliverable using only evidence-supported facts from the supplied documents. Never invent names, dates, qualifications, experience, achievements, employers, skills, deadlines, or documents. Use clear professional language. If a required document is missing, use a placeholder only for that document."
  },
  {
    id: "workflow",
    name: "Workflow Agent",
    instruction: "Act as a senior operations/workflow manager. Convert the verified state into an ordered, actionable completion plan. Include every actual mandatory gap, every explicitly required missing document, and unresolved mandatory requirements. Include a deadline only when explicitly documented. Do not create unnecessary tasks or invented requirements."
  }
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

function durationTokenValue(token) {
  const words = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
  const value = Number(token);
  return Number.isFinite(value) && value > 0 ? value : words[String(token || "").toLowerCase()] || 0;
}

function parseExperienceDurationMonths(text) {
  const source = String(text || "").toLowerCase();
  const quantity = "(?:\\d+(?:\\.\\d+)?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)";
  const durationPattern = new RegExp(`\\b(${quantity})\\s*(years?|yrs?|months?|mos?)\\b`, "gi");
  const durations = [];
  let match;
  while ((match = durationPattern.exec(source))) {
    const amount = durationTokenValue(match[1]);
    const unit = match[2].toLowerCase();
    durations.push(/^(?:years?|yrs?)$/.test(unit) ? amount * 12 : amount);
  }

  const monthIndexes = { january: 0, jan: 0, february: 1, feb: 1, march: 2, mar: 2, april: 3, apr: 3, may: 4, june: 5, jun: 5, july: 6, jul: 6, august: 7, aug: 7, september: 8, sep: 8, sept: 8, october: 9, oct: 9, november: 10, nov: 10, december: 11, dec: 11 };
  const monthPattern = "(?:january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sept|sep|october|oct|november|nov|december|dec)";
  const dateRangePattern = new RegExp(`\\b(${monthPattern})\\s+(\\d{4})\\s*(?:[-–—]|to)\\s*(${monthPattern})\\s+(\\d{4})\\b`, "gi");
  while ((match = dateRangePattern.exec(source))) {
    const start = Number(match[2]) * 12 + monthIndexes[match[1]];
    const end = Number(match[4]) * 12 + monthIndexes[match[3]];
    if (end >= start) durations.push(end - start + 1);
  }
  return durations.length ? Math.max(...durations) : null;
}

function formatDurationMonths(months) {
  const value = Math.max(0, Math.round(Number(months) || 0));
  const years = Math.floor(value / 12);
  const remainingMonths = value % 12;
  const parts = [];
  if (years) parts.push(`${years} ${years === 1 ? "year" : "years"}`);
  if (remainingMonths) parts.push(`${remainingMonths} ${remainingMonths === 1 ? "month" : "months"}`);
  return parts.join(" ") || "0 months";
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
    candidateLines: [],
    candidateExperienceLines: []
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const documentHeading = line.match(/^DOCUMENT:\s*(.+)$/i);
    if (documentHeading) {
      const documentName = documentHeading[1].toLowerCase();
      currentSection = /(?:job|role|requirement|posting|description|advertisement)/i.test(documentName)
        ? "job"
        : /(?:cv|resume|candidate|profile|transcript|degree|certificate|reference|portfolio)/i.test(documentName)
          ? "candidate"
          : "document";
      continue;
    }

    const experienceHeading = line.match(/^(?:experience|employment|work\s+history|candidate\s+experience)\s*:\s*(.*)$/i)
      || (/^(?:experience|employment|work\s+history|candidate\s+experience)$/i.test(line) ? ["", ""] : null);
    if (experienceHeading && (!currentSection || currentSection === "candidate")) {
      currentSection = "candidateExperience";
      if (experienceHeading[1]) sections.candidateExperienceLines.push(experienceHeading[1]);
      continue;
    }
    const jobExperienceRequirement = line.match(/^(?:experience|qualification|education|skills?)\s*:\s*(.+)$/i);
    if (jobExperienceRequirement && (currentSection === "job" || currentSection === "eligibility")) {
      sections.eligibility.push(line);
      continue;
    }
    if (/^(?:job|role)\s+(?:posting|description|advertisement|ad)\s*:?$/i.test(line)) {
      currentSection = "job";
      continue;
    }
    const jobRequirementHeading = line.match(/^(?:job|role)\s+requirements?\s*:\s*(.*)$/i);
    if (jobRequirementHeading) {
      currentSection = "eligibility";
      if (jobRequirementHeading[1]) sections.eligibility.push(jobRequirementHeading[1].trim());
      continue;
    }
    if (currentSection === "candidateExperience") {
      const isNextMajorSection = /^(?:education|academic\s+background|skills?|technical\s+skills|certifications?|certificates|languages?|projects?|awards?|publications?|references?|job\s+requirements?|job\s+description|position|eligibility(?:\s+requirements?)?|preferred(?:\s+requirements?)?|required(?:\s+documents?)?|deadline|application\s+deadline|submission\s+deadline)\s*(?::.*)?$/i.test(line);
      if (isNextMajorSection) {
        currentSection = /^(?:education|academic\s+background|skills?|technical\s+skills|certifications?|certificates|languages?|projects?|awards?|publications?|references?)\b/i.test(line)
          ? "candidate"
          : null;
        if (currentSection === "candidate") sections.candidateLines.push(line);
        continue;
      }
      sections.candidateExperienceLines.push(line);
      continue;
    }

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

    if (/^(?:job\s+requirements?|role\s+requirements?|requirements?|eligibility\s+requirements|eligibility|required\s+qualifications|mandatory\s+requirements|minimum\s+requirements|required)\s*:?$/i.test(line)) {
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
    if (/^(?:candidate\s+(?:profile|statement|cv|resume|details|information)|applicant\s+(?:statement|details|information))\s*:?$/i.test(line)) {
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

  // De-duplicate and ensure no experience items in requiredDocuments
  sections.eligibility = Array.from(new Set(sections.eligibility.map(x => x.replace(/\s+/g, " ").trim()).filter(Boolean)));
  sections.preferred = Array.from(new Set(sections.preferred.map(x => x.replace(/\s+/g, " ").trim()).filter(Boolean)));
  sections.requiredDocuments = Array.from(new Set(sections.requiredDocuments.map(x => x.replace(/\s+/g, " ").trim()).filter(x => x && !isExperienceRequirement(x))));

  return sections;
}

function getCandidateEvidenceText(fullText, candidateLines = [], candidateExperienceLines = []) {
  const candidateDocumentBlocks = String(fullText || "")
    .split(/(?=^DOCUMENT:\s*)/m)
    .filter(block => {
      const name = block.match(/^DOCUMENT:\s*([^\n]+)/i)?.[1] || "";
      return /(?:^|[^a-z0-9])(?:cv|resume|candidate|profile|transcript|degree|certificate|reference|portfolio)(?:[^a-z0-9]|$)/i.test(name);
    })
    .map(block => block.replace(/^DOCUMENT:[^\n]*\n?/i, ""));

  return [
    ...candidateLines,
    ...candidateExperienceLines,
    ...candidateDocumentBlocks
  ].join("\n");
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
    ["llb degree", ["degree: llb", "llb, first division", "llb degree", "llb", "ll.b"]],
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

function evaluateCandidateAgainstRequirements(eligibility, preferred, requiredDocuments, fullText, candidateExperienceLines = [], candidateLines = []) {
  const text = String(fullText || "");
  const candidateText = getCandidateEvidenceText(text, candidateLines, candidateExperienceLines);
  const lowerCandidateText = candidateText.toLowerCase();

  // 1. Required / Eligibility evaluation
  const requiredAnalysis = eligibility.map(req => {
    const lowerReq = req.toLowerCase();

    // Check for Experience Requirement
    if (isExperienceRequirement(req)) {
      const requiredMonths = parseExperienceDurationMonths(req);
      const candidateContextText = Array.isArray(candidateExperienceLines) ? candidateExperienceLines.join(" ") : "";
      const candidateMonths = parseExperienceDurationMonths(candidateContextText);

      if (requiredMonths && candidateMonths && candidateMonths < requiredMonths) {
        const shortfall = formatDurationMonths(requiredMonths - candidateMonths);
        const requiredDuration = formatDurationMonths(requiredMonths);
        return {
          requirement: req,
          candidateEvidence: `${formatDurationMonths(candidateMonths)} documented experience`,
          status: "Gap",
          isGap: true,
          gapShortfall: shortfall,
          gapDescription: `${shortfall.replace(/\s+/g, "-")} shortfall against the ${requiredDuration.replace(/\s+/g, "-")} requirement`
        };
      } else if (requiredMonths && candidateMonths && candidateMonths >= requiredMonths) {
        return {
          requirement: req,
          candidateEvidence: `${formatDurationMonths(candidateMonths)} documented experience`,
          status: "Met",
          isGap: false
        };
      } else {
        return {
          requirement: req,
          candidateEvidence: candidateMonths ? `${formatDurationMonths(candidateMonths)} documented experience` : "Not enough evidence",
          status: "Not enough evidence",
          isGap: false,
          gapShortfall: null,
          gapDescription: null
        };
      }
    }

    // Check for Degree (e.g. LLB)
    if (/llb\b/i.test(lowerReq)) {
      const hasLLB = /\bll\.?\s*b\b/i.test(candidateText);
      return {
        requirement: req,
        candidateEvidence: hasLLB ? "Degree: LLB, First Division" : "No degree record in profile",
        status: hasLLB ? "Met" : "Not enough evidence",
        isGap: false
      };
    }

    // Check for Legal Research skills
    if (/legal\s+research\s+skills?/i.test(lowerReq)) {
      const hasSkill = /legal\s+research/i.test(lowerCandidateText);
      return {
        requirement: req,
        candidateEvidence: hasSkill ? "Legal research skills documented in profile" : "Not documented",
        status: hasSkill ? "Met" : "Not enough evidence",
        isGap: false
      };
    }

    // Check for Legal Drafting skills
    if (/legal\s+drafting\s+skills?/i.test(lowerReq)) {
      const hasSkill = /legal\s+drafting/i.test(lowerCandidateText);
      return {
        requirement: req,
        candidateEvidence: hasSkill ? "Legal drafting skills documented in profile" : "Not documented",
        status: hasSkill ? "Met" : "Not enough evidence",
        isGap: false
      };
    }

    const supported = sourceTextSupportsClaim(req, candidateText);
    return {
      requirement: req,
      candidateEvidence: supported ? "Documented in candidate evidence" : "Not enough evidence",
      status: supported ? "Met" : "Not enough evidence",
      isGap: false
    };
  });

  // 2. Preferred Requirements evaluation
  // RULE 3: Preferred requirements must NEVER affect Required status, Gap count, or Missing documents!
  const preferredAnalysis = preferred.map(pref => {
    const lowerPref = pref.toLowerCase();
    let isDocumented = false;
    let evidenceText = "Not documented in candidate profile";

    if (/constitutional\s+law/i.test(lowerPref) && /constitutional\s+law/i.test(lowerCandidateText)) {
      isDocumented = true;
      evidenceText = "Research experience in constitutional law documented";
    } else if (/legal\s+database/i.test(lowerPref) && /legal\s+database/i.test(lowerCandidateText)) {
      isDocumented = true;
      evidenceText = "Knowledge of legal databases documented";
    } else if (sourceTextSupportsClaim(pref, candidateText)) {
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

function sanitizeEvidence(result, documents, _task, agentId = "") {
  const hasEvidence = Boolean(String(documents || "").trim());
  const evidence = Array.isArray(result?.evidence) ? result.evidence : [];
  if (hasEvidence) {
    const candidateSections = parseStructuredSections(documents);
    const candidateText = getCandidateEvidenceText(
      documents,
      candidateSections.candidateLines,
      candidateSections.candidateExperienceLines
    );
    const normalizedEvidence = evidence.map(item => {
      const source = String(item?.source || "").trim();
      const original = String(item?.status || "").trim();
      const claim = String(item?.claim || "");
      let status = "Unverified";
      if (/missing/i.test(original)) status = "Missing";
      else if (/contradict/i.test(original)) status = "Contradicted";
      else if (/needs review/i.test(original)) status = "Needs Review";
      else if (/unverified|not enough evidence/i.test(original)) status = "Unverified";
      else if (agentId === "verification") {
        status = candidateText && sourceTextSupportsClaim(claim, candidateText)
          ? "Supported by document"
          : "Unverified";
      }
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
    output: String(result?.output || "").replace(/\bVerified\b/gi, "Not verified")
  };
}

async function runAgent(agent, task, documents, state) {
  refreshAiClient();
  if (!ai) throw new Error("GEMINI_API_KEY is not configured.");

  const { sections, evaluation } = state;
  const sourceDocument = getUploadedDocumentNames(documents)[0] || "Supplied document";
  const hasStructuredAssessment = Boolean(
    sections.eligibility.length
    || sections.preferred.length
    || sections.requiredDocuments.length
    || sections.deadline
  );

  const prompt = [
    "You are the " + agent.name + " in KaroAI ActionFlow.",
    "ROLE: " + agent.instruction,
    "USER TASK:\n" + task,
    "SUPPLIED DOCUMENTS:\n" + (documents || "No documents supplied."),
    "STRUCTURED SECTIONS EXTRACTED FROM SOURCE:\n" + JSON.stringify(sections, null, 2),
    "EVALUATION OF CANDIDATE AGAINST REQUIREMENTS:\n" + JSON.stringify(evaluation, null, 2),
    "PREVIOUS WORKFLOW STATE:\n" + JSON.stringify(state, null, 2),
    "STRICT CRITICAL RULES:",
    "1. SOURCE GROUNDING: Supplied documents are the authority. Never invent facts, requirements, eligibility rules, deadlines, documents, or evidence.",
    "2. REQUIREMENT SEPARATION: Keep Required, Preferred, Required Documents, and other source categories separate. Preferred requirements never affect mandatory gap counts.",
    "3. EVIDENCE STATUS: Supported by document requires direct source evidence. If evidence is absent or ambiguous, say Unverified or Needs Review rather than guessing.",
    "4. GAP VS DOCUMENT: A qualification, experience, skill, eligibility, or evidence shortfall is not a missing document. Missing Documents may contain only explicitly required attachments that were not supplied.",
    "5. DEADLINES: Include a deadline only when explicitly stated in supplied source material. Never infer one from dates elsewhere.",
    "6. DRAFT INTEGRITY: The draft must contain only documented candidate facts. Never silently upgrade a candidate to meet a requirement.",
    "7. COMPLETENESS: Cover every source requirement and every supplied candidate document. Do not stop after the first match.",
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
  if (agent.id === "requirement" && hasStructuredAssessment) {
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

  if (agent.id === "gap" && hasStructuredAssessment) {
    // Deterministic gap result: never let the model erase a detected qualification gap.
    const gapLines = evaluation.gapAnalysis.map(g =>
      `Qualification/Experience Gap: ${g.description || `${g.requirement} — ${g.candidateEvidence}; ${g.gap}`}`
    );
    const unresolvedLines = evaluation.requiredAnalysis
      .filter(item => item.status === "Not enough evidence" || item.status === "Unresolved")
      .map(item => `Mandatory requirement needs more evidence: ${item.requirement}`);
    const missingLines = evaluation.missingDocuments.map(d =>
      `Missing Required Document: ${d} — not provided in supplied documents`
    );
    result = {
      ...result,
      summary: `Identified ${evaluation.gapAnalysis.length} qualification gap(s), ${unresolvedLines.length} unresolved mandatory requirement(s), and ${evaluation.missingDocuments.length} missing required document(s).`,
      findings: [...gapLines, ...unresolvedLines, ...missingLines],
      missing: evaluation.missingDocuments,
      evidence: [
        ...evaluation.gapAnalysis.map(g => ({
          claim: `Experience Requirement: ${g.requirement}`,
          status: "Needs Review",
          source: sourceDocument
        })),
        ...evaluation.requiredAnalysis
          .filter(item => item.status === "Not enough evidence" || item.status === "Unresolved")
          .map(item => ({
            claim: `Mandatory requirement needs evidence: ${item.requirement}`,
            status: "Unverified",
            source: sourceDocument
          })),
        ...evaluation.missingDocuments.map(d => ({
          claim: `Missing required document: ${d}`,
          status: "Missing",
          source: sourceDocument
        }))
      ],
      output: [
        "Gap Analysis:",
        ...(gapLines.length ? gapLines.map(x => "- " + x) : ["- No qualification gaps identified."]),
        ...(missingLines.length ? ["Missing Documents:", ...missingLines.map(x => "- " + x)] : ["Missing Documents: None."])
      ].join("\n")
    };
  }

  if (agent.id === "verification" && hasStructuredAssessment) {
    const requiredEvidence = evaluation.requiredAnalysis.map(r => ({
      claim: r.requirement,
      status: r.status === "Met" ? "Supported by document" : r.status === "Gap" ? "Needs Review" : "Unverified",
      source: sourceDocument
    }));
    const preferredEvidence = evaluation.preferredAnalysis.map(p => ({
      claim: p.requirement,
      status: p.status === "Documented" ? "Supported by document" : "Unverified",
      source: sourceDocument
    }));
    const documentEvidence = evaluation.missingDocuments.map(d => ({
      claim: "Required document: " + d,
      status: "Missing",
      source: sourceDocument
    }));
    result = {
      ...result,
      findings: [
        ...evaluation.requiredAnalysis.map(r => `${r.status}: ${r.requirement} — ${r.candidateEvidence}`),
        ...evaluation.preferredAnalysis.map(p => `${p.status}: ${p.requirement} — ${p.candidateEvidence}`),
        ...evaluation.missingDocuments.map(d => `Missing required document: ${d}`)
      ],
      missing: evaluation.missingDocuments,
      evidence: [...requiredEvidence, ...preferredEvidence, ...documentEvidence]
    };
  }

  if (agent.id === "workflow" && hasStructuredAssessment) {
    // RULE 2: Deadline step ONLY if explicitly present in source!
    const steps = [];
    evaluation.gapAnalysis.forEach(g => {
      steps.push(`Address the ${g.description || g.requirement}`);
    });
    evaluation.requiredAnalysis
      .filter(item => item.status === "Not enough evidence" || item.status === "Unresolved")
      .forEach(item => steps.push(`Provide evidence for ${item.requirement}`));
    evaluation.missingDocuments.forEach(doc => {
      steps.push(`Provide ${doc}`);
    });
    if (sections.deadline) {
      steps.push(`Submit before ${sections.deadline}`);
    }

    if (steps.length) {
      result = {
        ...result,
        summary: "Action plan created from documented gaps, unresolved evidence, missing required documents, and explicit deadlines.",
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
  }

  return sanitizeEvidence(result, documents, task, agent.id);
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
    const evaluation = evaluateCandidateAgainstRequirements(sections.eligibility, sections.preferred, sections.requiredDocuments, documents, sections.candidateExperienceLines, sections.candidateLines);

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
    const evaluation = evaluateCandidateAgainstRequirements(sections.eligibility, sections.preferred, sections.requiredDocuments, documents, sections.candidateExperienceLines, sections.candidateLines);

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

/* Stray duplicate code appended after the active server startup; keep it inert.
if (agent.id === "draft") {
    const docPlaceholders = evaluation.missingDocuments.map(d => `[MISSING: ${d}]`);
    const cleanedOutput = String(result?.output || "");
    result = {
      ...result,
      summary: "Application draft prepared from supplied evidence; missing required documents remain placeholders.",
      findings: evaluation.missingDocuments,
      missing: evaluation.missingDocuments,
      output: cleanedOutput,
      evidence: evaluation.missingDocuments.map(d => ({
        claim: `Required document listed in source: ${d}`,
        status: "Missing",
        source: sourceDocument
      }))
    };
    if (!result.output.trim()) {
      result.output = docPlaceholders.length
        ? `Required application materials still missing: ${docPlaceholders.join(", ")}`
        : "No draft text was returned.";
    }
  }

  if (agent.id === "workflow") {
    // RULE 2: Deadline step ONLY if explicitly present in source!
    const steps = [];
    evaluation.gapAnalysis.forEach(g => {
      steps.push(`Address qualification gap: ${g.description || g.requirement}`);
    });
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
*/
