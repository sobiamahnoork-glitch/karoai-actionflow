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
  const [activeAgent, setActiveAgent] = useState(null);
  const [liveAgents, setLiveAgents] = useState({});
  const [history, setHistory] = useState(() => { try { return JSON.parse(localStorage.getItem("karoai_history") || "[]"); } catch { return []; } });

  const handleFiles = async (event) => {
    const selected = Array.from(event.target.files || []);
    if (!selected.length) return;
    setExtracting(true);
    setError("");
    try {
      setActiveAgent("intake");
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
    setStarted(true); setRunning(true); setError(""); setResult(null);
    setLiveAgents({});
    try {
      const response = await fetch("/api/run-workflow-stream", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task, documents })
      });
      if (!response.ok || !response.body) throw new Error("Could not start the workflow.");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n"); buffer = lines.pop() || "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const event = JSON.parse(line);
          if (event.type === "agent:start") {
            setActiveAgent(event.id);
            setLiveAgents(prev => ({ ...prev, [event.id]: "active" }));
          } else if (event.type === "agent:complete") {
            setLiveAgents(prev => ({ ...prev, [event.id]: "done" }));
          } else if (event.type === "complete") {
            setResult(event.workflow); setActiveAgent(null);
          } else if (event.type === "error") {
            throw new Error(event.error);
          }
        }
      }
    } catch (err) {
      setError(err.message || "Could not run the workflow.");
    } finally { setRunning(false); setActiveAgent(null); }
  };
  const agentState = (id) => liveAgents[id] || "queued";
