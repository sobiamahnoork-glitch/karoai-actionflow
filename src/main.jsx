import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import {
  CheckCircle2, FileText, Clock3, ShieldCheck, Sparkles, ArrowRight,
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

function App() {
  const [started, setStarted] = useState(false);
  const [task, setTask] = useState("");
  const [documents, setDocuments] = useState("");
  const [files, setFiles] = useState([]);
  const [extracting, setExtracting] = useState(false);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");

  const handleFiles = async (event) => {
    const selected = Array.from(event.target.files || []);
    if (!selected.length) return;
    setExtracting(true);
    setError("");
    try {
      const extracted = [];
      for (const file of selected.slice(0, 5)) {
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
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || `Could not process ${file.name}.`);
        extracted.push({ name: file.name, text: result.text || "" });
      }
      setFiles(extracted);
      setDocuments(extracted.map(d => `DOCUMENT: ${d.name}\n${d.text}`).join("\n\n"));
    } catch (err) {
      setError(err.message || "Document upload failed.");
    } finally {
      setExtracting(false);
      event.target.value = "";
    }
  };

  const runWorkflow = async () => {
    if (!task.trim()) return;
    setStarted(true);
    setRunning(true);
    setError("");
    setResult(null);
    try {
      const response = await fetch("/api/run-workflow", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task, documents })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Workflow failed.");
      setResult(data.workflow);
    } catch (err) {
      setError(err.message || "Could not run the workflow.");
    } finally {
      setRunning(false);
    }
  };

  const agentState = (id) => {
    if (!running && result?.agents?.some(a => a.id === id)) return "done";
    if (running) return "active";
    return "queued";
  };

  return (
    <div className="app">
      <header>
        <div className="brand">
          <div className="logo">K</div>
          <div><b>KaroAI</b><span>ActionFlow</span></div>
        </div>
        <nav><a className="selected">Dashboard</a><a>My Tasks</a><a>Documents</a><a>Activity</a></nav>
        <button className="profile">SM</button>
      </header>

      <main>
        {!started ? (
          <section className="hero">
            <div className="eyebrow"><Sparkles size={15}/> AI-POWERED ACTION WORKFLOW</div>
            <h1>Don’t just ask AI.<br/><em>Give it a task.</em></h1>
            <p>Turn a real-world task into a clear, verified action plan. KaroAI understands your documents, finds what’s missing, checks evidence, and prepares the next steps.</p>

            <div className="taskbox">
              <label>What do you need KaroAI to do?</label>
              <textarea value={task} onChange={e => setTask(e.target.value)} placeholder="Example: Help me prepare my scholarship application and tell me what documents are missing." />
              <label className="doclabel">Upload documents</label>
              <div className="uploadbox">
                <input id="documents" type="file" accept=".pdf,.txt,.md,.json,.html,application/pdf,text/plain,text/markdown,application/json,text/html" multiple onChange={handleFiles} />
                <label htmlFor="documents" className="uploadlabel"><Upload size={18}/><span>{extracting ? "Reading documents with Gemini..." : "Choose PDF or text documents"}</span></label>
                {files.length > 0 && <div className="filelist">{files.map(file => <span key={file.name}><FileText size={14}/>{file.name}</span>)}</div>}
              </div>
              <label className="doclabel">Or paste document text / notes (optional)</label>
              <textarea className="smallarea" value={documents} onChange={e => setDocuments(e.target.value)} placeholder="Paste relevant text here, or upload documents above." />
              <button className="primary" onClick={runWorkflow} disabled={!task.trim() || extracting}>
                Start AI workflow <ArrowRight size={18}/>
              </button>
            </div>

            <div className="trust">
              <span><ShieldCheck size={16}/> Evidence-backed</span>
              <span><ClipboardCheck size={16}/> Multi-agent workflow</span>
              <span><CheckCircle2 size={16}/> Action-ready</span>
            </div>
          </section>
        ) : (
          <section className="workspace">
            <div className="topline">
              <div>
                <div className="eyebrow">ACTIVE WORKFLOW</div>
                <h2>{result?.final?.summary || "KaroAI Task"}</h2>
                <p>{task}</p>
              </div>
              <div className="progress">
                <b>{running ? "..." : "100%"}</b><span>workflow status</span>
              </div>
            </div>

            <div className="grid">
              <div className="panel">
                <div className="panelhead"><div><h3>Agent activity</h3><small>{running ? "Agents are processing your task" : "Workflow completed"}</small></div><Activity size={19}/></div>
                {agentOrder.map(([id, name, desc]) => {
                  const state = agentState(id);
                  return <div className="agent" key={id}>
                    <div className={"agenticon " + state}>{state === "done" ? <CheckCircle2 size={17}/> : state === "active" ? <Loader2 className="spin" size={17}/> : <Clock3 size={17}/>}</div>
                    <div className="agenttext"><b>{name}</b><span>{desc}</span></div>
                    <span className={"state " + state}>{state}</span>
                  </div>;
                })}
              </div>

              <div className="panel">
                <div className="panelhead"><div><h3>Requirements & gaps</h3><small>Generated from your task and evidence</small></div><FileText size={19}/></div>
                {result?.final?.missing?.length ? result.final.missing.map((item, i) =>
                  <div className="task" key={i}><div><b>Missing item</b><span>{item}</span></div><span className="badge missing">Missing</span></div>
                ) : running ? <div className="empty">Waiting for the agents to finish their analysis...</div> :
                  <div className="empty">No missing items were reported.</div>}

                {error && <div className="notice error"><AlertCircle size={18}/><div><b>Workflow error</b><span>{error}</span></div></div>}

                {!running && result?.final?.nextSteps?.length ? (
                  <div className="resultbox"><b>Next steps</b>{result.final.nextSteps.map((step, i) => <span key={i}>{i + 1}. {step}</span>)}</div>
                ) : null}

                <button className="secondary full" onClick={() => {setStarted(false); setResult(null); setError("");}}>
                  <X size={16}/> New task
                </button>
              </div>
            </div>

            {!running && result?.final?.output && (
              <div className="panel outputpanel"><div className="panelhead"><div><h3>AI-prepared result</h3><small>Based on the verified workflow state</small></div><ClipboardCheck size={19}/></div><p>{result.final.output}</p></div>
            )}
          </section>
        )}
      </main>
      <footer><span>© 2026 KaroAI</span><span>Private by design · Your documents stay yours</span></footer>
    </div>
  );
}

createRoot(document.getElementById("root")).render(<App />);
