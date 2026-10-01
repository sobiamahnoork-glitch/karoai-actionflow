import React, { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  CheckCircle2, FileText, Clock3, ShieldCheck, Sparkles, ArrowRight, Copy,
  Upload, Activity, ClipboardCheck, AlertCircle, Loader2, X
} from "lucide-react";
import "./styles.css";

const agentOrder = [
  ["intake", "Intake Agent", "Understanding your task"],
  ["document", "Document Agent", "Extracting relevant information"],
  ["requirement", "Requirement Agent", "Building requirements"],
  ["gap", "Gap Agent", "Checking missing items"],
  ["verification", "Verification Agent", "Cross-checking evidence"],
  ["draft", "Draft Agent", "Preparing output"],
  ["workflow", "Workflow Agent", "Creating action plan"]
];

const iconFor = {
  intake: Sparkles,
  document: FileText,
  requirement: ClipboardCheck,
  gap: AlertCircle,
  verification: ShieldCheck,
  draft: FileText,
  workflow: ArrowRight
};

function App() {
  const [started, setStarted] = useState(false);
  const [task, setTask] = useState("");
  const [documents, setDocuments] = useState("");
  const [files, setFiles] = useState([]);
  const [extracting, setExtracting] = useState(false);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const [copyNotice, setCopyNotice] = useState("");
  const [activeAgent, setActiveAgent] = useState(null);
  const [liveAgents, setLiveAgents] = useState({});
  const [history, setHistory] = useState(() => {
    try { return JSON.parse(localStorage.getItem("karoai_history") || "[]"); } catch { return []; }
  });
  const [historyOpen, setHistoryOpen] = useState(false);
  const [completionAnswers, setCompletionAnswers] = useState({});
  const [completing, setCompleting] = useState(false);

  const progress = useMemo(() => {
    const done = agentOrder.filter(([id]) => liveAgents[id] === "done").length;
    return result ? 100 : Math.round((done / agentOrder.length) * 100);
  }, [liveAgents, result]);

  const saveHistory = (workflow) => {
    const item = { id: Date.now(), task: workflow.task, documents, files, workflow, createdAt: new Date().toISOString() };
    setHistory(prev => {
      const next = [item, ...prev].slice(0, 20);
      localStorage.setItem("karoai_history", JSON.stringify(next));
      return next;
    });
  };

  const handleFiles = async (event) => {
    const selected = Array.from(event.target.files || []);
    if (!selected.length) return;
    if (selected.length > 5) setError("Only the first 5 selected documents will be processed.");
    setExtracting(true);
    setError("");
    try {
      const extracted = [];
      const existingNames = new Set(files.map(file => file.name.toLowerCase()));
      for (const file of selected.slice(0, 5)) {
        if (existingNames.has(file.name.toLowerCase())) continue;
        if (file.size > 50 * 1024 * 1024) throw new Error(`${file.name} is larger than 50 MB.`);
        const data = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
          reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
          reader.readAsDataURL(file);
        });
        const response = await fetch("/api/extract-document", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: file.name, mimeType: file.type || "application/pdf", data })
        });
        const extractedResult = await response.json();
        if (!response.ok) throw new Error(extractedResult.error || `Could not process ${file.name}.`);
        extracted.push({ name: file.name, text: extractedResult.text || "" });
      }
      setFiles(prev => [...prev, ...extracted].slice(0, 5));
      setDocuments(prev => {
        const added = extracted.map(d => `DOCUMENT: ${d.name}\n${d.text}`).join("\n\n");
        return prev ? `${prev}${prev.endsWith("\n") ? "" : "\n\n"}${added}` : added;
      });
    } catch (err) {
      setError(err.message || "Document upload failed.");
    } finally {
      setExtracting(false);
      event.target.value = "";
    }
  };

  const runWorkflow = async () => {
    if (!task.trim() || running || extracting) return;
    setStarted(true); setRunning(true); setError(""); setResult(null); setLiveAgents({});
    try {
      const response = await fetch("/api/run-workflow-stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task: task.trim(), documents })
      });
      if (!response.ok || !response.body) throw new Error("Could not start the workflow.");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const event = JSON.parse(line);
          if (event.type === "agent:start") {
            setActiveAgent(event.id);
            setLiveAgents(prev => ({ ...prev, [event.id]: "active" }));
          } else if (event.type === "agent:complete") {
            setLiveAgents(prev => ({ ...prev, [event.id]: "done" }));
          } else if (event.type === "complete") {
            setResult(event.workflow);
            setActiveAgent(null);
            saveHistory(event.workflow);
          } else if (event.type === "error") {
            throw new Error(event.error);
          }
        }
      }
    } catch (err) {
      setError(err.message || "Could not run the workflow.");
    } finally {
      setRunning(false);
      setActiveAgent(null);
    }
  };

  const copyText = async (text, successMessage = "") => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setError("");
      setCopyNotice("Result copied to clipboard.");
      setCopyNotice(successMessage);
    } catch {
      setError("Could not copy the text. Please select and copy it manually.");
    }
  };

  const completeDraft = async () => {
    if (!result || completing) return;
    const answered = Object.fromEntries(Object.entries(completionAnswers).map(([key, value]) => [key, String(value || "").trim()]).filter(([, value]) => value));
    if (!Object.keys(answered).length) {
      setError("Please complete at least one missing item first.");
      return;
    }
    setCompleting(true);
    setError("");
    try {
      const response = await fetch("/api/complete-draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task, documents, workflow: result, answers: answered })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not prepare the revised draft.");
      const nextWorkflow = {
        ...result,
        agents: (result.agents || []).map(agent => agent.id === "draft"
          ? { ...agent, result: data.draft }
          : agent),
        final: data.draft
      };
      setResult(nextWorkflow);
      saveHistory(nextWorkflow);
      setCompletionAnswers({});
      setCopyNotice("Draft updated using the information you provided. It is not externally verified unless supported by the source documents.");
    } catch (err) {
      setError(err.message || "Could not prepare the revised draft.");
    } finally {
      setCompleting(false);
    }
  };

  const copyFinalResult = async () => {
    const text = result?.final?.output || draftResult?.output || "";
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setError("");
      setCopyNotice("Result copied to clipboard.");
    } catch {
      setError("Could not copy the result. Please select and copy the text manually.");
    }
  };

  const newTask = () => {
    setStarted(false); setTask(""); setDocuments(""); setFiles([]); setResult(null);
    setError(""); setCopyNotice(""); setLiveAgents({}); setActiveAgent(null); setHistoryOpen(false); setCompletionAnswers({});
  };

  const restore = (item) => {
    setTask(item.task || item.workflow?.task || "");
    setDocuments(item.documents || "");
    setFiles(item.files || []);
    setResult(item.workflow || null);
    setStarted(true); setRunning(false); setError(""); setCopyNotice(""); setHistoryOpen(false);
    setLiveAgents(Object.fromEntries(agentOrder.map(([id]) => [id, "done"]))); setCompletionAnswers({});
  };

  const agentState = (id) => liveAgents[id] || "queued";
  const workflowAgents = result?.agents || [];
  const requirementResult = workflowAgents.find(a => a.id === "requirement")?.result;
  const gapResult = workflowAgents.find(a => a.id === "gap")?.result;
  const verificationResult = workflowAgents.find(a => a.id === "verification")?.result;
  const draftResult = workflowAgents.find(a => a.id === "draft")?.result;
  const workflowResult = workflowAgents.find(a => a.id === "workflow")?.result;

  const draftPlaceholders = Array.from(new Set(((draftResult?.output || "").match(/\[MISSING:\s*[^\]]+\]/gi) || []).map(item => item.trim()))).slice(0, 12);
  const missingItems = draftPlaceholders.map(item => item.replace(/^\[MISSING:\s*/i, "").replace(/\]$/, "").trim()).filter(Boolean);
  const needsReviewItems = Array.from(new Set((verificationResult?.findings || []).map(item => String(item).trim()).filter(Boolean))).slice(0, 8);
  const draftReady = Boolean(draftResult?.output) && draftPlaceholders.length === 0;

  const hasSupportingEvidence = Boolean(documents.trim());
  const requirements = [
    ...(requirementResult?.findings || []).map(text => ({ text, status: hasSupportingEvidence ? "Found in provided material" : "Suggested" })),
    ...missingItems.map(text => ({ text, status: "Missing" })),
    ...(verificationResult?.findings || []).map(text => ({ text, status: "Needs Review" }))
  ].slice(0, 10);

  const evidence = [];
  const evidenceStatus = (status) => {
    const value = String(status || "Unverified").toLowerCase();
    if (value.includes("contradict")) return "Contradicted";
    if (value.includes("verif")) return "Verified";
    if (value.includes("missing")) return "Missing";
    return "Unverified";
  };
  for (const agent of workflowAgents) {
    for (const item of agent.result?.evidence || []) {
      if (!item?.claim) continue;
      if (!evidence.some(e => e.claim === item.claim)) evidence.push(item);
    }
  }

  return (
    <div className="app">
      <header>
        <div className="brand">
          <div className="logo">K</div>
          <div><b>KaroAI</b><span>ActionFlow</span></div>
        </div>
        <nav>
          <a className={!started ? "selected" : ""} onClick={() => setStarted(false)}>Dashboard</a>
          <a className={historyOpen ? "selected" : ""} onClick={() => setHistoryOpen(true)}>My Tasks</a>
          <a onClick={() => started && document.querySelector(".workspace")?.scrollIntoView({ behavior: "smooth" })}>Documents</a>
          <a onClick={() => started && document.querySelector(".agentpanel")?.scrollIntoView({ behavior: "smooth" })}>Activity</a>
        </nav>
        <button className="profile" aria-label="Profile">KA</button>
      </header>

      {!started ? (
        <main className="hero">
          <div className="eyebrow"><Sparkles size={14}/> AI-POWERED TASK EXECUTION</div>
          <h1>Don’t just ask AI.<br/><em>Give it a task.</em></h1>
          <p>KaroAI turns real-world requests and documents into a verified, step-by-step action flow using specialized AI agents.</p>

          <section className="taskbox">
            <label>What do you need to get done?</label>
            <textarea value={task} onChange={e => setTask(e.target.value)} placeholder="Example: Help me prepare my application and tell me what is missing." />
            <label className="doclabel">Supporting documents</label>
            <div className="uploadbox">
              <input id="docs" type="file" multiple onChange={handleFiles} accept=".pdf,.txt,.png,.jpg,.jpeg,.webp"/>
              <label className="uploadlabel" htmlFor="docs">
                {extracting ? <Loader2 className="spin" size={18}/> : <Upload size={18}/>}
                {extracting ? "Reading documents…" : "Upload up to 5 documents"}
              </label>
              <small className="uploadhint">PDF, TXT, PNG, JPG or WEBP · up to 50 MB each</small>
              {files.length > 0 && <div className="filelist">{files.map(file => <span key={file.name}><FileText size={12}/>{file.name}</span>)}</div>}
            </div>
            <label>Or paste supporting text</label>
            <textarea className="smallarea" value={documents} onChange={e => setDocuments(e.target.value)} placeholder="Paste relevant requirements, notes, or document text here." />
            <button className="primary" disabled={!task.trim() || extracting} onClick={runWorkflow}>
              Start AI workflow <ArrowRight size={16}/>
            </button>
            {error && <div className="notice error"><AlertCircle size={17}/><div><b>Something went wrong</b><span>{error}</span></div></div>}
          </section>

          <div className="trust">
            <span><ShieldCheck size={14}/> Evidence-aware</span>
            <span><Activity size={14}/> Multi-agent workflow</span>
            <span><CheckCircle2 size={14}/> Structured action plan</span>
          </div>
        </main>
      ) : (
        <main className="workspace">
          <div className="topline">
            <div>
              <div className="eyebrow"><Activity size={14}/> ACTIVE WORKFLOW</div>
              <h2>{running ? "KaroAI is working…" : result ? "Workflow complete" : "Preparing workflow"}</h2>
              <p>{task}</p>
            </div>
            <div className="progress"><b>{progress}%</b><span>{running ? `${agentOrder.findIndex(([id]) => id === activeAgent) + 1 || 0} of ${agentOrder.length} agents` : result ? "Completed" : "Ready"}</span></div>
          </div>

          {result && <div className="metricrow">
            <div className="metric"><b>{requirements.filter(x => x.status === "Found in provided material").length}</b><span>Evidence-backed requirements</span></div>
            <div className="metric"><b>{requirements.filter(x => x.status === "Missing").length}</b><span>Missing items</span></div>
            <div className="metric"><b>{evidence.filter(x => evidenceStatus(x.status) === "Verified").length}</b><span>Verified claims</span></div>
            <div className="metric"><b>{(workflowResult?.nextSteps || result?.final?.nextSteps || []).length}</b><span>Action steps</span></div>
          </div>}

          {files.length > 0 && <section className="panel sourcepanel">
            <div className="panelhead">
              <div><h3>Source documents</h3><small>Evidence available to the workflow</small></div>
              <FileText size={18}/>
            </div>
            <div className="sourceintro">KaroAI extracted these documents before running the agents. Claims can only be treated as verified when supported by the supplied material.</div>
            <div className="sourcegrid">
              {files.map((file, i) => (
                <details className="sourcecard" key={file.name}>
                  <summary><span><FileText size={15}/><b>{file.name}</b></span><small>Source {i + 1}</small></summary>
                  <div className="sourcebody">{file.text || "No readable text was extracted from this document."}</div>
                </details>
              ))}
            </div>
          </section>}

          <div className="grid">
            <section className="panel agentpanel">
              <div className="panelhead"><div><h3>Agent activity</h3><small>Live execution across specialized agents</small></div><Activity size={18}/></div>
              {agentOrder.map(([id, name, desc]) => {
                const Icon = iconFor[id] || Activity;
                const state = agentState(id);
                return <div className="agent" key={id}>
                  <div className={`agenticon ${state}`}>{state === "active" ? <Loader2 className="spin" size={16}/> : state === "done" ? <CheckCircle2 size={16}/> : <Icon size={16}/>}</div>
                  <div className="agenttext"><b>{name}</b><span>{state === "active" ? desc : state === "done" ? "Completed" : "Queued"}</span></div>
                  <span className={`state ${state}`}>{state}</span>
                </div>;
              })}
            </section>

            <section className="panel">
              <div className="panelhead"><div><h3>Requirements & gaps</h3><small>What the workflow found so far</small></div><ClipboardCheck size={18}/></div>
              {!requirements.length ? <div className="empty">{running ? "Requirements will appear as agents complete their analysis." : "No requirements were returned."}</div> :
                requirements.map((item, i) => <div className="task" key={i}><div><b>{item.text}</b><span>Requirement check</span></div><span className={`badge ${item.status === "Missing" ? "missing" : item.status === "Suggested" || item.status === "Needs Review" ? "review" : "verified"}`}>{item.status}</span></div>)}
            </section>

            <section className="panel checklistpanel">
              <div className="panelhead"><div><h3>Missing information checklist</h3><small>Complete these before treating the application as ready</small></div><ClipboardCheck size={18}/></div>
              <div className={"readiness " + (draftReady ? "ready" : "needswork")}>
                <div><span className="readinessdot"></span><b>{draftReady ? "No unresolved draft placeholders" : "More information needed"}</b></div>
                <small>{draftReady ? "The current draft has no unresolved [MISSING: …] placeholders. Review evidence status before submission." : `${missingItems.length} unresolved draft item${missingItems.length === 1 ? "" : "s"}${needsReviewItems.length ? ` and ${needsReviewItems.length} verification item${needsReviewItems.length === 1 ? "" : "s"} needing review` : ""}.`}</small>
              </div>
              {!missingItems.length ? <div className="empty">{draftReady ? "No unresolved information remains in the current draft." : "No missing information was identified by the Gap Agent."}</div> :
                <div className="checklist">{missingItems.map((item, i) =>
                  <div className="checkitem" key={i}><span className="checkmark"><AlertCircle size={14}/></span><div><b>{item}</b><small>Missing / unresolved</small></div></div>
                )}</div>}
              {needsReviewItems.length > 0 && <div className="reviewlist">
                <b>Needs review</b>
                {needsReviewItems.map((item, i) => <div key={i}><ShieldCheck size={13}/><span>{item}</span></div>)}
              </div>}
            </section>

            <section className="panel">
              <div className="panelhead"><div><h3>Evidence & verification</h3><small>Important claims and their source status</small></div><ShieldCheck size={18}/></div>
              {!evidence.length ? <div className="empty">{running ? "Verification evidence will appear here." : "No evidence items were returned."}</div> :
                <div className="evidence">{evidence.slice(0, 12).map((item, i) => {
                  const status = String(item.status || "unverified").toLowerCase();
                  const verified = status.includes("verif");
                  return <div className="evidenceitem" key={i}><div><b>{item.claim}</b><span>{item.source || "Source not specified"}</span></div><span className={`badge ${verified ? "verified" : "review"}`}>{item.status || "Unverified"}</span></div>;
                })}</div>}
            </section>

            <section className="panel">
              <div className="panelhead"><div><h3>Action plan</h3><small>Ordered next steps for completing the task</small></div><ArrowRight size={18}/></div>
              {(workflowResult?.nextSteps || result?.final?.nextSteps || []).length ? (workflowResult?.nextSteps || result?.final?.nextSteps).map((step, i) =>
                <div className="task" key={i}><div><b>{i + 1}. {step}</b><span>{i === 0 ? "Start here" : "Next step"}</span></div><span className="badge pending">{i === 0 ? "Priority" : "Planned"}</span></div>
              ) : <div className="empty">{running ? "The Workflow Agent will prepare your action plan." : "No action steps were returned."}</div>}
            </section>
          </div>

          {result && missingItems.length > 0 && <section className="panel completionpanel missingcompletion">
            <div className="panelhead"><div><h3>Complete missing information</h3><small>Fill in what you know. KaroAI will update the draft without rerunning the full workflow.</small></div><ClipboardCheck size={18}/></div>
            <div className="completionfields">
              {missingItems.map((item, i) => <label className="completionfield" key={item + i}>
                <span>{item}</span>
                <textarea value={completionAnswers[item] || ""} onChange={e => setCompletionAnswers(prev => ({ ...prev, [item]: e.target.value }))} placeholder="Enter the missing information…" />
              </label>)}
            </div>
            <button className="primary" onClick={completeDraft} disabled={completing || !Object.values(completionAnswers).some(value => String(value || "").trim())}>
              {completing ? <><Loader2 className="spin" size={16}/> Updating draft…</> : <>Prepare updated draft <ArrowRight size={16}/></>}
            </button>
          </section>}

          {draftResult?.output && <section className="panel outputpanel"><div className="panelhead"><div><h3>AI-prepared draft</h3><small>Uses evidence-supported facts; unresolved inputs stay as placeholders</small></div><button className="iconbtn" onClick={() => copyText(draftResult.output, "Draft copied to clipboard.")} title="Copy draft" aria-label="Copy draft"><Copy size={16}/></button></div><div className="drafttext">{draftResult.output}</div>
            {draftPlaceholders.length > 0 && <div className="placeholderbox"><b>Placeholders to complete</b>{draftPlaceholders.map((item, i) => <span key={i}>{item}</span>)}</div>}
          </section>}

          {copyNotice && <div className="notice copyNotice"><CheckCircle2 size={17}/><div><b>Update</b><span>{copyNotice}</span></div></div>}

          {result?.final?.output && <section className="panel outputpanel"><div className="panelhead"><div><h3>AI-prepared result</h3><small>Final workflow output</small></div><button className="iconbtn" onClick={copyFinalResult} title="Copy result" aria-label="Copy result"><Copy size={16}/></button></div><div className="drafttext">{result.final.output}</div></section>}

          {result && <section className="panel completionpanel">
            <div className="completionicon"><CheckCircle2 size={22}/></div>
            <div>
              <h3>Workflow completed</h3>
              <p>{result.final?.summary || "KaroAI completed the workflow and prepared the next actions from the available information."}</p>
              <small>Review the evidence and action plan above before using the prepared output.</small>
            </div>
          </section>}

          {error && <div className="notice error"><AlertCircle size={17}/><div><b>Workflow error</b><span>{error}</span></div></div>}

          <div className="actions" style={{display:"flex",gap:10,marginTop:22}}>
            <button className="secondary" onClick={newTask}>Start new task</button>
            {history.length > 0 && <button className="secondary" onClick={() => setHistoryOpen(true)}><Clock3 size={15}/> View saved tasks</button>}
          </div>
        </main>
      )}

      <footer><span>KaroAI ActionFlow</span><span>Understand → Verify → Prepare → Act</span></footer>

      {historyOpen && <div className="historyoverlay" onClick={() => setHistoryOpen(false)}>
        <aside className="historymodal" onClick={e => e.stopPropagation()}>
          <div className="panelhead"><div><h3>My Tasks</h3><small>Your recent workflows on this browser</small></div><button className="iconbtn" onClick={() => setHistoryOpen(false)}><X size={16}/></button></div>
          {!history.length ? <div className="empty">No saved workflows yet.</div> : history.map(item =>
            <button className="historyitem" key={item.id} onClick={() => restore(item)}>
              <div><b>{item.task}</b><span>{item.workflow?.final?.summary || "Workflow completed"}</span></div><small>{new Date(item.createdAt).toLocaleDateString()}</small>
            </button>
          )}
        </aside>
      </div>}
    </div>
  );
}

createRoot(document.getElementById("root")).render(<App />);
