import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import {
  CheckCircle2,
  FileText,
  Clock3,
  ShieldCheck,
  Sparkles,
  ArrowRight,
  Upload,
  Activity,
  ClipboardCheck,
  AlertCircle
} from "lucide-react";
import "./styles.css";

const defaultAgents = [
  ["Intake Agent", "Understanding your task", "done"],
  ["Document Agent", "Extracting relevant information", "done"],
  ["Requirement Agent", "Building requirements", "done"],
  ["Gap Agent", "Checking missing items", "active"],
  ["Verification Agent", "Cross-checking evidence", "queued"],
  ["Draft Agent", "Preparing application", "queued"],
  ["Workflow Agent", "Creating action plan", "queued"]
];

const defaultTasks = [
  ["Identity document", "Required", "Verified"],
  ["Academic transcript", "Required", "Verified"],
  ["Statement of purpose", "Required", "Missing"],
  ["Recommendation letter", "Required", "Pending"]
];

function App() {
  const [started, setStarted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [workflowData, setWorkflowData] = useState(null);
  const [currentTab, setCurrentTab] = useState("Dashboard");

  const executeWorkflow = async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/run-workflow", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          task: "Masters scholarship application",
          documents:
            "Passport verified (Identity confirmed). Undergraduate transcript verified (GPA 3.8). Statement of purpose pending upload. Referee recommendations pending confirmation."
        })
      });
      const data = await response.json();
      if (data && data.workflow) {
        setWorkflowData(data.workflow);
      }
    } catch (err) {
      console.error("Failed to run workflow:", err);
    } finally {
      setLoading(false);
    }
  };

  const handleStart = () => {
    setStarted(true);
    executeWorkflow();
  };

  const displayedAgents = workflowData
    ? workflowData.agents.map((a) => [
        a.name,
        a.result?.summary || "Completed step",
        a.status || "done"
      ])
    : defaultAgents;

  const progressPercent = workflowData ? "100%" : "54%";

  return (
    <div className="app">
      <header>
        <div className="brand">
          <div className="logo">K</div>
          <div>
            <b>KaroAI</b>
            <span>ActionFlow</span>
          </div>
        </div>
        <nav>
          {["Dashboard", "My Tasks", "Documents", "Activity"].map((tab) => (
            <a
              key={tab}
              className={currentTab === tab ? "selected" : ""}
              onClick={() => setCurrentTab(tab)}
              style={{ cursor: "pointer" }}
            >
              {tab}
            </a>
          ))}
        </nav>
        <button className="profile">SM</button>
      </header>

      <main>
        {!started ? (
          <section className="hero">
            <div className="eyebrow">
              <Sparkles size={15} /> AI-POWERED ACTION WORKFLOW
            </div>
            <h1>
              Don’t just ask AI.<br />
              <em>Give it a task.</em>
            </h1>
            <p>
              Turn a real-world task into a clear, verified action plan. KaroAI understands
              your documents, finds what’s missing, checks evidence, and prepares the next steps.
            </p>
            <div className="actions">
              <button className="primary" onClick={handleStart} disabled={loading}>
                {loading ? "Starting..." : "Start a task"} <ArrowRight size={18} />
              </button>
              <button className="secondary" onClick={handleStart}>
                <Upload size={17} /> Upload documents
              </button>
            </div>
            <div className="trust">
              <span>
                <ShieldCheck size={16} /> Evidence-backed
              </span>
              <span>
                <ClipboardCheck size={16} /> Multi-agent workflow
              </span>
              <span>
                <CheckCircle2 size={16} /> Action-ready
              </span>
            </div>
          </section>
        ) : (
          <section className="workspace">
            <div className="topline">
              <div>
                <div className="eyebrow">ACTIVE WORKFLOW</div>
                <h2>Scholarship Application</h2>
                <p>Masters scholarship application · 7 agents working through your task</p>
              </div>
              <div className="progress">
                <b>{progressPercent}</b>
                <span>workflow complete</span>
              </div>
            </div>

            <div className="grid">
              <div className="panel">
                <div className="panelhead">
                  <div>
                    <h3>Agent activity</h3>
                    <small>
                      {loading ? "Running agent pipeline..." : "Live workflow status"}
                    </small>
                  </div>
                  <Activity size={19} />
                </div>
                {displayedAgents.map(([name, desc, status]) => (
                  <div className="agent" key={name}>
                    <div className={"agenticon " + status}>
                      {status === "done" ? (
                        <CheckCircle2 size={17} />
                      ) : status === "active" ? (
                        <Sparkles size={17} />
                      ) : (
                        <Clock3 size={17} />
                      )}
                    </div>
                    <div className="agenttext">
                      <b>{name}</b>
                      <span>{desc}</span>
                    </div>
                    <span className={"state " + status}>{status}</span>
                  </div>
                ))}
              </div>

              <div className="panel">
                <div className="panelhead">
                  <div>
                    <h3>Requirements & gaps</h3>
                    <small>Detected from your task and documents</small>
                  </div>
                  <FileText size={19} />
                </div>
                {defaultTasks.map(([name, req, state]) => (
                  <div className="task" key={name}>
                    <div>
                      <b>{name}</b>
                      <span>{req}</span>
                    </div>
                    <span className={"badge " + state.toLowerCase()}>{state}</span>
                  </div>
                ))}
                <div className="notice">
                  <AlertCircle size={18} />
                  <div>
                    <b>1 item needs your attention</b>
                    <span>Upload your statement of purpose to continue verification.</span>
                  </div>
                </div>
                <button
                  className="primary full"
                  onClick={executeWorkflow}
                  disabled={loading}
                >
                  {loading ? "Executing agents..." : "Continue workflow"}{" "}
                  <ArrowRight size={17} />
                </button>
              </div>
            </div>
          </section>
        )}
      </main>

      <footer>
        <span>© 2026 KaroAI</span>
        <span>Private by design · Your documents stay yours</span>
      </footer>
    </div>
  );
}

createRoot(document.getElementById("root")).render(<App />);
