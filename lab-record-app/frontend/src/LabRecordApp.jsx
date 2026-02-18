import { useState, useRef } from "react";

// ── Load external script helper ──────────────────────────────────
function loadScript(src, check) {
  return new Promise((resolve, reject) => {
    if (check && check()) { resolve(); return; }
    const s = document.createElement("script");
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error("Failed to load: " + src));
    document.head.appendChild(s);
  });
}

// ── PDF.js loader ────────────────────────────────────────────────
function loadPdfJs() {
  return new Promise((resolve, reject) => {
    if (window.pdfjsLib) { resolve(window.pdfjsLib); return; }
    const s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
    s.onload = () => {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc =
        "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
      resolve(window.pdfjsLib);
    };
    s.onerror = () => reject(new Error("Failed to load PDF.js"));
    document.head.appendChild(s);
  });
}

// ── Load html2canvas + jsPDF for download ───────────────────────
async function loadDownloadLibs() {
  await loadScript(
    "https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js",
    () => window.html2canvas
  );
  await loadScript(
    "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js",
    () => window.jspdf
  );
}

// ── PDF text extraction ──────────────────────────────────────────
async function extractTextFromPDF(file) {
  const pdfjsLib = await loadPdfJs();
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  let fullText = "";
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    let lastY = null;
    for (const item of content.items) {
      if (lastY !== null && Math.abs(item.transform[5] - lastY) > 5) fullText += "\n";
      fullText += item.str;
      lastY = item.transform[5];
    }
    fullText += "\n";
  }
  fullText = fullText.replace(/(\d{9,})\1+/g, "");
  fullText = fullText.replace(/\d{14,}/g, "");
  fullText = fullText.replace(/[ \t]{3,}/g, " ");
  fullText = fullText.replace(/\n{4,}/g, "\n\n");
  return fullText;
}

// ── PSG iTech Parser ─────────────────────────────────────────────
function parsePSGLabPDF(rawText) {
  const lines = rawText.split("\n").map(l => l.trim()).filter(Boolean);

  const get = (label) => {
    const idx = lines.findIndex(l => l.toLowerCase().startsWith(label.toLowerCase()));
    if (idx === -1) return "";
    const same = lines[idx].replace(new RegExp(label + "\\s*:?\\s*", "i"), "").trim();
    return same || lines[idx + 1] || "";
  };

  const studentInfo = {
    name:       get("Name:") || get("Name"),
    rollNo:     get("Roll no:") || get("Roll no") || get("Roll Number"),
    email:      get("Email:") || get("Email"),
    phone:      get("Phone:") || get("Phone"),
    branch:     get("Branch:") || get("Branch"),
    department: get("Department:") || get("Department"),
    batch:      get("Batch:") || get("Batch"),
    degree:     get("Degree:") || get("Degree"),
  };

  let text = rawText;
  if (studentInfo.rollNo) {
    const rn = studentInfo.rollNo.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    text = text.replace(new RegExp(`(${rn}){2,}`, "g"), "");
    text = text.replace(new RegExp(rn, "g"), "");
  }
  const cleanLines = text.split("\n").map(l => l.trim()).filter(Boolean);

  const instLine = cleanLines.find(l =>
    l.toLowerCase().includes("psg institute") ||
    (l.toLowerCase().includes("psg") && l.toLowerCase().includes("tech"))
  );
  const institution = instLine || "PSG Institute of Technology and Applied Research";

  const labLine = cleanLines.find(l => /lab/i.test(l) && l.length > 20 && l.includes("_"));
  let labName = "";
  if (labLine) {
    const parts = labLine.split("_");
    labName = (parts.find(p => /lab/i.test(p)) || parts[parts.length - 1]).trim();
  }

  const weekLine = cleanLines.find(l => /week\s*\d+/i.test(l));
  let weekNo = "", experimentTitle = "";
  if (weekLine) {
    const wm = weekLine.match(/week\s*(\d+)/i);
    if (wm) weekNo = `Week ${wm[1]}`;
    const parts = weekLine.split("_");
    const wi = parts.findIndex(p => /week/i.test(p));
    if (wi !== -1 && parts[wi + 1]) experimentTitle = parts[wi + 1].trim();
  }

  const totalLine = cleanLines.find(l => /total\s*mark\s*:/i.test(l));
  const totalMarks = totalLine ? (totalLine.match(/:\s*(\d+)/) || [])[1] || "" : "";
  const labInfo = { institution, labName, weekNo, experimentTitle, totalMarks, date: "" };

  const questions = [];

  const isQuestionStart = (line, nextLine, lookaheadLines) => {
    if (!line) return false;
    if (/^question\s*\d+/i.test(line)) return true;
    const m = line.match(/^(\d{1,2})\.(.*)$/);
    if (!m) return false;

    const rest = (m[2] || "").trim();
    if (/^(?:problem\s*statement)?$/i.test(rest)) return true;
    if (/^problem\s*statement\b/i.test(rest)) return true;

    const nl = (nextLine || "").trim();
    if (/^problem\s*statement\b/i.test(nl)) return true;

    const ahead = (lookaheadLines || []).slice(0, 6).join("\n");
    if (/\bproblem\s*statement\b/i.test(ahead)) return true;
    if (/\binput\s*format\b/i.test(ahead)) return true;
    if (/\boutput\s*format\b/i.test(ahead)) return true;
    if (/\bsample\s*test\s*case\b/i.test(ahead)) return true;
    if (/^status\s*:/gmi.test(ahead)) return true;
    if (/^marks\s*:/gmi.test(ahead)) return true;
    return false;
  };

  const startIdxs = [];
  for (let i = 0; i < cleanLines.length; i++) {
    if (isQuestionStart(cleanLines[i], cleanLines[i + 1], cleanLines.slice(i + 1, i + 10))) startIdxs.push(i);
  }

  for (let i = 0; i < startIdxs.length; i++) {
    const start = startIdxs[i];
    const end = i + 1 < startIdxs.length ? startIdxs[i + 1] : cleanLines.length;
    const cl = cleanLines.slice(start, end).map(l => l.trim()).filter(Boolean);

    const dropTrailingMeta = (arr) => {
      let j = arr.length;
      while (j > 0 && (/^status\s*:/i.test(arr[j - 1]) || /^marks\s*:/i.test(arr[j - 1]))) j--;
      return arr.slice(0, j);
    };

    const psStart = cl.findIndex(l => /^problem\s*statement\b/i.test(l));
    const stcStart = cl.findIndex(l => /^sample\s*test\s*case\b/i.test(l));
    const ansStart = cl.findIndex(l => /^answer\b/i.test(l));

    const statusLine = cl.find(l => /^status\s*:/i.test(l));
    const marksLine  = cl.find(l => /marks/i.test(l) && /\d+\s*\/\s*\d+/.test(l));
    const status = statusLine ? (statusLine.match(/status\s*:\s*(\w+)/i) || [])[1] || "" : "";
    let marksObt = "", maxMk = 10;
    const parseMarks = (s) => {
      if (!s) return null;
      const mm = s.match(/marks\s*:?\s*(\d+)\s*\/\s*(\d+)/i) || s.match(/(\d+)\s*\/\s*(\d+)/);
      if (!mm) return null;
      return { obtained: mm[1], max: parseInt(mm[2], 10) };
    };
    const marksParsed = parseMarks(marksLine) || parseMarks(cl.slice().reverse().find(l => /\d+\s*\/\s*\d+/.test(l)));
    if (marksParsed) {
      marksObt = marksParsed.obtained;
      maxMk = Number.isFinite(marksParsed.max) ? marksParsed.max : maxMk;
    }

    const bodyStart = psStart !== -1 ? psStart + 1 : 1;
    const bodyEnd = stcStart !== -1 ? stcStart : cl.length;
    const problemStatement = dropTrailingMeta(cl.slice(bodyStart, bodyEnd)).join("\n").trim();
    const testCase = stcStart !== -1
      ? dropTrailingMeta(cl.slice(stcStart + 1, ansStart !== -1 ? ansStart : cl.length)).join("\n").trim()
      : "";

    if (problemStatement) {
      questions.push({ problemStatement, testCase, status, maxMarks: maxMk, marksObtained: marksObt });
    }
  }

  return { studentInfo, labInfo, questions };
}

// ── Rubric defaults ──────────────────────────────────────────────
const rubricDefaults = [
  { criteria: "Implementation",           maxMarks: 40, obtained: "" },
  { criteria: "Output",                   maxMarks: 20, obtained: "" },
  { criteria: "Viva & MCQ",               maxMarks: 30, obtained: "" },
  { criteria: "Observation & Record",     maxMarks: 10, obtained: "" },
];

const STEPS = ["Upload PDF", "Enter Marks", "Print Record"];

// ── Main App ─────────────────────────────────────────────────────
export default function LabRecordApp() {
  const [step, setStep]               = useState(0);
  const [pdfFile, setPdfFile]         = useState(null);
  const [logoFile, setLogoFile]       = useState(null);
  const [logoDataUrl, setLogoDataUrl] = useState(null);
  const [parsing, setParsing]         = useState(false);
  const [parseError, setParseError]   = useState("");
  const [downloading, setDownloading] = useState(false);

  const [parsedStudent, setParsedStudent] = useState(null);
  const [labInfo, setLabInfo]   = useState({ institution:"", labName:"", weekNo:"", experimentTitle:"", date:"", totalMarks:"" });
  const [qaList, setQaList]     = useState([]);
  const [rubric, setRubric]     = useState(rubricDefaults.map(r => ({ ...r })));
  const [includeTestCases, setIncludeTestCases] = useState(false);
  const [result, setResult]     = useState("");

  const fileInputRef = useRef();
  const logoInputRef = useRef();
  const dropRef      = useRef();
  const printAreaRef = useRef();

  const handleFile = (file) => {
    if (!file || file.type !== "application/pdf") return;
    setPdfFile(file); setParseError("");
  };

  const handleLogoUpload = (file) => {
    if (!file || !file.type.startsWith("image/")) return;
    setLogoFile(file);
    const reader = new FileReader();
    reader.onload = (e) => setLogoDataUrl(e.target.result);
    reader.readAsDataURL(file);
  };

  const handleExtract = async () => {
    if (!pdfFile) return;
    setParsing(true); setParseError("");
    try {
      const text = await extractTextFromPDF(pdfFile);
      const { studentInfo: si, labInfo: li, questions } = parsePSGLabPDF(text);
      setParsedStudent(si);
      setLabInfo(li);
      setQaList(questions.map((q, i) => ({ ...q, id: i })));
      // Auto-enable test cases if any question has test case content
      const hasTestCases = questions.some(q => q.testCase && q.testCase.trim());
      setIncludeTestCases(hasTestCases);
      setStep(1);
    } catch (err) {
      setParseError("Could not parse PDF: " + err.message);
    } finally {
      setParsing(false);
    }
  };

  const updateLab    = (k, v) => setLabInfo(l => ({ ...l, [k]: v }));
  const updateRubric = (idx, field, val) =>
    setRubric(r => r.map((row, i) => i === idx ? { ...row, [field]: val } : row));

  const si = parsedStudent || { name:"", rollNo:"", email:"", phone:"", branch:"", department:"", batch:"", degree:"" };
  const totalObtained  = qaList.reduce((s, q) => s + (parseFloat(q.marksObtained) || 0), 0);
  const totalMax       = qaList.reduce((s, q) => s + (parseFloat(q.maxMarks) || 0), 0);
  const rubricObtained = rubric.reduce((s, r) => s + (parseFloat(r.obtained) || 0), 0);
  const rubricMax      = rubric.reduce((s, r) => s + (parseFloat(r.maxMarks) || 0), 0);

  const resetAll = () => {
    setStep(0); setPdfFile(null); setQaList([]); setResult("");
    setParsedStudent(null);
    setRubric(rubricDefaults.map(r => ({ ...r })));
    setLabInfo({ institution:"", labName:"", weekNo:"", experimentTitle:"", date:"", totalMarks:"" });
    setIncludeTestCases(false);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const handleDownloadPDF = async () => {
    if (!printAreaRef.current) return;
    setDownloading(true);
    try {
      await loadDownloadLibs();
      const { jsPDF } = window.jspdf;
      const el = printAreaRef.current;
      const canvas = await window.html2canvas(el, {
        scale: 2, useCORS: true, backgroundColor: "#ffffff",
        logging: false, windowWidth: el.scrollWidth, width: el.scrollWidth,
      });
      const pageW = 210, pageH = 297, margin = 10;
      const usableW = pageW - margin * 2;
      const ratio   = usableW / (canvas.width / 2);
      const totalH  = (canvas.height / 2) * ratio;
      const usableH = pageH - margin * 2;
      const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
      let remainingH = totalH, srcY = 0;
      while (remainingH > 0) {
        const sliceH  = Math.min(usableH, remainingH);
        const slicePx = (sliceH / ratio) * 2;
        const slice   = document.createElement("canvas");
        slice.width = canvas.width;
        slice.height = Math.round(slicePx);
        const ctx = slice.getContext("2d");
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, slice.width, slice.height);
        ctx.drawImage(canvas, 0, Math.round(srcY), canvas.width, Math.round(slicePx), 0, 0, canvas.width, Math.round(slicePx));
        doc.addImage(slice.toDataURL("image/png"), "PNG", margin, margin, usableW, sliceH);
        srcY += slicePx; remainingH -= sliceH;
        if (remainingH > 0) doc.addPage();
      }
      const name = si.name ? si.name.replace(/\s+/g, "_") : "student";
      const week = labInfo.weekNo ? labInfo.weekNo.replace(/\s+/g, "_") : "lab";
      doc.save(`LabRecord_${name}_${week}.pdf`);
    } catch (err) {
      alert("Download failed: " + err.message);
    } finally {
      setDownloading(false);
    }
  };

  const today = new Date().toLocaleDateString("en-IN", { day:"2-digit", month:"long", year:"numeric" });

  return (
    <div style={{ fontFamily:"Calibri, 'Segoe UI', Arial, sans-serif", minHeight:"100vh", background:"#f4f1ec", color:"#1c1c1c" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Source+Serif+4:ital,wght@0,400;0,600;0,700;1,400&family=DM+Sans:wght@300;400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap');
        *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
        .wrap{max-width:900px;margin:0 auto;padding:32px 24px 80px}
        .app-header{display:flex;align-items:flex-end;justify-content:space-between;padding-bottom:20px;border-bottom:2.5px solid #1c1c1c;margin-bottom:30px}
        .app-header h1{font-family:'Source Serif 4',Georgia,serif;font-size:1.8rem;font-weight:700;letter-spacing:-.5px}
        .app-header .sub{font-size:.65rem;font-weight:600;letter-spacing:2.5px;text-transform:uppercase;color:#999;margin-top:4px}
        .badge-inst{background:#1c1c1c;color:#f4f1ec;padding:6px 16px;font-size:.62rem;font-weight:700;letter-spacing:2px;text-transform:uppercase}
        .steps{display:flex;margin-bottom:28px;border:1.5px solid #c5bfb4}
        .step-item{display:flex;align-items:center;justify-content:center;gap:8px;flex:1;padding:11px 0;font-size:.68rem;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;border-right:1.5px solid #c5bfb4;color:#aaa}
        .step-item:last-child{border-right:none}
        .step-item.active{background:#1c1c1c;color:#f4f1ec}
        .step-item.done{background:#444;color:#fff}
        .step-num{width:20px;height:20px;border-radius:50%;border:1.5px solid currentColor;display:flex;align-items:center;justify-content:center;font-size:.65rem;flex-shrink:0}
        .card{background:#fff;border:1.5px solid #ddd7ce;padding:26px 28px;margin-bottom:20px}
        .card-title{font-family:'Source Serif 4',Georgia,serif;font-size:1rem;font-weight:700;margin-bottom:20px;display:flex;align-items:center;gap:10px}
        .card-title::after{content:'';flex:1;height:1px;background:#e8e2d9}
        .upload-zone{border:2px dashed #c5bfb4;padding:52px 24px;text-align:center;cursor:pointer;background:#faf8f5;transition:border-color .2s,background .2s}
        .upload-zone:hover,.upload-zone.drag-over{border-color:#1c1c1c;background:#f0ede7}
        .upload-icon{font-size:3rem;margin-bottom:12px;display:block}
        .upload-title{font-family:'Source Serif 4',Georgia,serif;font-size:1.1rem;font-weight:600;margin-bottom:6px}
        .upload-hint{font-size:.78rem;color:#999;margin-top:6px}
        .file-pill{display:flex;align-items:center;gap:10px;background:#f0f0f0;border:1.5px solid #888;padding:11px 16px;margin-top:14px}
        .file-name{font-size:.86rem;color:#1c1c1c;font-weight:600;font-family:'IBM Plex Mono',monospace}
        .file-size{margin-left:auto;font-size:.72rem;color:#777}
        .error-box{background:#fdecea;border:1.5px solid #f5c6c2;padding:12px 16px;font-size:.82rem;color:#c0392b;margin-top:14px}
        .spin{display:inline-block;width:14px;height:14px;border:2px solid rgba(255,255,255,.3);border-top-color:#fff;border-radius:50%;animation:spin .7s linear infinite}
        @keyframes spin{to{transform:rotate(360deg)}}
        .inp-group{display:flex;flex-direction:column;gap:5px}
        .inp-group label{font-size:.62rem;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#888}
        .inp-group input,.inp-group textarea{border:1.5px solid #d4cec6;padding:9px 12px;font-size:.875rem;font-family:'DM Sans',sans-serif;background:#faf8f5;color:#1c1c1c;outline:none;width:100%;transition:border-color .15s}
        .inp-group input:focus,.inp-group textarea:focus{border-color:#1c1c1c;background:#fff}
        .inp-group textarea{resize:vertical;min-height:84px}
        .inp-group.result-textarea{width:100%;min-height:120px;border:1px solid #ccc;padding:12px 16px;font-size:1rem;font-family:'DM Sans',sans-serif;font-weight:400;line-height:1.6;resize:vertical;outline:none;border-radius:4px;box-sizing:border-box}
        .test-case-check{margin-top:14px}
        .test-case-check label{font-size:.875rem;font-family:'DM Sans',sans-serif;font-weight:400;color:#1c1c1c;cursor:pointer}
        .test-case-list{margin-top:10px}
        .test-case-item{font-size:.875rem;font-family:'DM Sans',sans-serif;color:#1c1c1c;padding:6px 0}
        .btn{padding:11px 26px;font-size:.72rem;font-family:'DM Sans',sans-serif;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;cursor:pointer;border:2px solid #1c1c1c;transition:all .15s;display:inline-flex;align-items:center;gap:8px;background:transparent;color:#1c1c1c}
        .btn:hover{background:#1c1c1c;color:#f4f1ec}
        .btn:disabled{opacity:.5;cursor:not-allowed}
        .btn-filled{background:#1c1c1c;color:#f4f1ec}
        .btn-filled:hover{background:#333}
        .btn-filled:disabled{background:#bbb;border-color:#bbb}
        .btn-row{display:flex;justify-content:space-between;align-items:center;margin-top:24px;gap:12px;flex-wrap:wrap}
        .qa-item{border:1.5px solid #ddd7ce;margin-bottom:14px;background:#fff}
        .qa-head{background:#f4f1ec;border-bottom:1px solid #ddd7ce;padding:11px 16px;display:flex;align-items:center;justify-content:space-between;gap:12px}
        .qa-num{font-family:'Source Serif 4',Georgia,serif;font-weight:700;font-size:.95rem}
        .qa-right{display:flex;align-items:center;gap:14px}
        .stag{font-size:.62rem;font-weight:700;letter-spacing:1px;text-transform:uppercase;padding:3px 9px;border:1px solid #888;color:#333}
        .marks-display{font-family:'IBM Plex Mono',monospace;font-size:.875rem;font-weight:600;background:#fff;border:1px solid #ccc;padding:4px 12px}
        .qa-ps{padding:14px 16px;font-size:.875rem;line-height:1.72;color:#2a2a2a;font-family:'Source Serif 4',Georgia,serif}
        .rtable{width:100%;border-collapse:collapse;font-size:.85rem;margin-top:8px}
        .rtable th{border:1.5px solid #000;padding:12px 14px;text-align:left;font-size:.62rem;letter-spacing:1.2px;text-transform:uppercase;font-weight:700;background:#fff;color:#000}
        .rtable td{border:1.5px solid #000;padding:11px 14px;color:#000}
        .rtable .total-r td{font-weight:700;font-family:Calibri, 'Segoe UI', Arial, sans-serif;background:#fff;border:1.5px solid #000;color:#000}
        .rtable input[type=number]{width:80px;border:1px solid #ccc;padding:6px 8px;font-size:.82rem;font-family:'DM Sans',sans-serif;background:#fff;text-align:center;outline:none}
        .rtable input[type=number]:focus{border-color:#1c1c1c;background:#fafafa}
        .pr-wrap{background:#fff;display:flex;flex-direction:column}
        .pr-pages-wrapper{display:flex;flex-direction:column;padding:0;background:#fff}
        .pr-page{background:#fff;width:210mm;min-height:297mm;height:auto;margin:0 auto;padding:18mm;box-sizing:border-box;position:relative;box-shadow:none;overflow:visible;border:none}
        .pr-page-inner{position:relative;height:auto;width:100%;display:flex;flex-direction:column}
        .print-page-border{position:fixed;top:10mm;left:10mm;right:10mm;bottom:10mm;border:1px solid #1c1c1c;z-index:1;pointer-events:none;display:none}
        .pr-content-wrapper{position:relative;z-index:2;flex:1;overflow:visible;font-size:12pt;line-height:1.5;font-family:Calibri, 'Segoe UI', Arial, sans-serif;color:#000}
        .pr-content-wrapper *{color:#000 !important;font-family:Calibri, 'Segoe UI', Arial, sans-serif !important;font-size:12pt}
        .pr-header{text-align:center;padding:20px 0 16px;border-bottom:2px solid #1c1c1c;margin-bottom:16px}
        .pr-inst{font-family:Calibri, 'Segoe UI', Arial, sans-serif;font-size:14pt;font-weight:700;letter-spacing:.2px;margin-bottom:6px}
        .pr-subtitle{font-size:.55rem;font-weight:700;letter-spacing:2.5px;text-transform:uppercase;color:#666;margin:8px 0 4px}
        .pr-lab{font-family:Calibri, 'Segoe UI', Arial, sans-serif;font-size:14pt;font-weight:700;font-style:normal;color:#333;margin-top:6px}
        .info-strip{display:grid;grid-template-columns:repeat(4,1fr);border-bottom:1px solid #bbb;margin-bottom:10px}
        .info-strip.row2{border-bottom:1px solid #bbb;margin-bottom:10px}
        .info-cell{padding:8px 10px;border-right:1px solid #bbb}
        .info-cell:last-child{border-right:none}
        .ic-label{font-size:.5rem;font-weight:700;letter-spacing:1.2px;text-transform:uppercase;color:#888;margin-bottom:2px}
        .ic-value{font-size:.82rem;color:#1c1c1c;font-weight:700;font-family:'Source Serif 4',Georgia,serif;word-break:break-all}
        .exp-strip{border-bottom:1px solid #bbb;padding:14px 24px;display:flex;justify-content:space-between;align-items:flex-start}
        .exp-meta-label{font-size:.55rem;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#999;margin-bottom:3px}
        .exp-meta-val{font-family:'Source Serif 4',Georgia,serif;font-size:.95rem;font-weight:700}
        .exp-prog-label{font-size:.55rem;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#999;margin-top:10px;margin-bottom:3px}
        .exp-prog-val{font-family:'Source Serif 4',Georgia,serif;font-size:.9rem;font-style:italic;color:#333}
        .exp-right-block{text-align:right;padding-left:24px;border-left:1px solid #bbb}
        .score-meta-label{font-size:.55rem;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#999;margin-bottom:4px}
        .score-num{font-family:'Source Serif 4',Georgia,serif;font-size:1.6rem;font-weight:700;line-height:1}
        .pr-content{padding:0;background:#fff;flex:1;overflow:visible;font-size:12pt;line-height:1.5}
        .pr-qa{border:none;margin:0 0 14px 0;padding:0;font-size:12pt;page-break-inside:avoid;break-inside:avoid}
        .pr-qa-head{background:transparent;border-bottom:1px solid #bbb;padding:8px 0;display:flex;align-items:flex-end;justify-content:space-between;font-weight:600;break-after:avoid;page-break-after:avoid}
        .pr-qnum{font-family:'Source Serif 4',Georgia,serif;font-weight:700;font-size:.95rem;color:#1c1c1c}
        .pr-qa-right{display:flex;align-items:center;gap:14px;font-size:.82rem}
        .pr-stag{font-size:.6rem;font-weight:700;letter-spacing:1px;text-transform:uppercase;padding:3px 10px;border:1px solid #888;color:#333;background:transparent}
        .pr-mk{font-family:'IBM Plex Mono',monospace;font-size:.82rem;font-weight:600}
        .pr-qa-body{padding:10px 0 0 0;break-inside:auto;page-break-inside:auto}
        .ps-label{font-size:.55rem;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#000;margin-bottom:8px;page-break-inside:avoid;break-inside:avoid}
        .ps-text{font-family:'IBM Plex Mono',monospace;font-size:12pt;line-height:1.6;color:#000;white-space:pre-wrap;background:transparent;margin:6px 0 0 0;padding:0;border:none;page-break-inside:avoid;break-inside:avoid}
        .pr-result{margin:18px 0;padding:0;page-break-inside:avoid;break-inside:avoid}
        .section-hd{font-size:.56rem;font-weight:700;letter-spacing:2.2px;text-transform:uppercase;color:#555;margin-bottom:10px}
        .pr-result-text{font-family:Calibri, 'Segoe UI', Arial, sans-serif;font-size:14pt;line-height:1.4;color:#000}
        .pr-result-write{min-height:90px;border:1px solid #1c1c1c;padding:10px 12px;white-space:pre-wrap;break-inside:avoid;page-break-inside:avoid}
        .pr-rubric{margin-bottom:0;page-break-inside:avoid;break-inside:avoid}
        .pr-rubric, .pr-rubric *{font-size:14pt}
        .pr-rubric table{page-break-inside:avoid;break-inside:avoid}

        @media print{
          *{-webkit-print-color-adjust:exact;print-color-adjust:exact}
          .pr-pages-wrapper{background:#fff;padding:0}
          .pr-page{box-shadow:none;margin:0;width:auto;min-height:auto;padding:12mm;border:none}
          .print-page-border{display:block}
          .pr-qa{break-inside:auto;page-break-inside:auto}
          .ps-text{orphans:3;widows:3}
        }
        .dl-sub{font-size:.78rem;color:#888}
        .page-nav{display:flex;justify-content:center;align-items:center;gap:12px;margin-top:20px;padding:20px;background:#f4f1ec;border:1px solid #ddd;border-radius:4px}
        .page-nav button{padding:8px 16px;font-size:.75rem;font-weight:600;border:1px solid #1c1c1c;background:transparent;color:#1c1c1c;cursor:pointer;transition:all .2s}
        .page-nav button:hover{background:#1c1c1c;color:#f4f1ec}
        .page-nav button:disabled{opacity:.5;cursor:not-allowed}
        .page-info{font-size:.8rem;color:#666;font-weight:600}
        .pr-page-visible{display:flex !important}
        .pr-page-hidden{display:none !important}
        .watermark-container{position:relative}
        .watermark-center{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);font-size:6rem;font-weight:700;opacity:0.5;color:#ccc;text-align:center;pointer-events:none;z-index:0;max-width:80%}
        .watermark-logo{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);opacity:0.5;pointer-events:none;z-index:0;max-width:40%;max-height:40%;object-fit:contain;filter:grayscale(100%)}
        .watermark-corner{position:absolute;font-size:1rem;font-weight:600;opacity:0.4;color:#999;pointer-events:none;font-family:'IBM Plex Mono',monospace;letter-spacing:2px}
        .watermark-tl{top:10px;left:10px}
        .watermark-tr{top:10px;right:10px}
        .watermark-bl{bottom:10px;left:10px}
        .watermark-br{bottom:10px;right:10px}
        @media print{.no-print{display:none!important}body{background:#fff!important}.wrap{padding:0!important;max-width:100%!important}*{-webkit-print-color-adjust:exact;print-color-adjust:exact}}
      `}</style>

      {downloading && (
        <div className="dl-overlay">
          <div className="dl-card">
            <div className="dl-spinner" />
            <div className="dl-msg">Generating PDF…</div>
            <div className="dl-sub">This may take a few seconds</div>
          </div>
        </div>
      )}

      <div className="wrap">
        <div className="app-header no-print">
          <div>
            <h1>Lab Record Generator</h1>
            <div className="sub">PSG Institute of Technology and Applied Research</div>
          </div>
          <div className="badge-inst">Client-Side · No API</div>
        </div>

        <div className="steps no-print">
          {STEPS.map((s, i) => (
            <div key={i} className={`step-item ${i===step?"active":i<step?"done":""}`}>
              <div className="step-num">{i < step ? "✓" : i+1}</div>{s}
            </div>
          ))}
        </div>

        {/* ══ STEP 0: UPLOAD ══ */}
        {step === 0 && (
          <div>
            <div className="card">
              <div className="card-title">Upload Lab Submission PDF</div>
              <div ref={dropRef} className="upload-zone"
                onClick={() => fileInputRef.current.click()}
                onDragOver={e => { e.preventDefault(); dropRef.current.classList.add("drag-over"); }}
                onDragLeave={() => dropRef.current.classList.remove("drag-over")}
                onDrop={e => { dropRef.current.classList.remove("drag-over"); handleFile(e.dataTransfer.files[0]); }}>
                <span className="upload-icon">📋</span>
                <div className="upload-title">Drop your PDF here or click to browse</div>
                <div className="upload-hint">PSG iTech lab submission format · Parsed entirely in your browser</div>
              </div>
              <input ref={fileInputRef} type="file" accept="application/pdf"
                style={{ display:"none" }} onChange={e => handleFile(e.target.files[0])} />
              {pdfFile && (
                <div className="file-pill">
                  <span>📎</span>
                  <span className="file-name">{pdfFile.name}</span>
                  <span className="file-size">{(pdfFile.size/1024).toFixed(1)} KB</span>
                </div>
              )}
              {parseError && <div className="error-box">⚠ {parseError}</div>}
            </div>

            <div className="card">
              <div className="card-title">Upload College Logo (Optional Watermark)</div>
              <div style={{display:"flex",gap:16,alignItems:"flex-start"}}>
                <div style={{flex:1}}>
                  <button className="btn" onClick={() => logoInputRef.current.click()} style={{marginBottom:12}}>
                    📸 Upload Logo
                  </button>
                  <input ref={logoInputRef} type="file" accept="image/*"
                    style={{ display:"none" }} onChange={e => handleLogoUpload(e.target.files[0])} />
                  {logoFile && (
                    <div className="file-pill">
                      <span>🖼</span>
                      <span className="file-name">{logoFile.name}</span>
                      <span className="file-size">{(logoFile.size/1024).toFixed(1)} KB</span>
                    </div>
                  )}
                  <p style={{fontSize:".75rem",color:"#999",marginTop:8,lineHeight:1.6}}>The logo will appear as a watermark centered in the PDF with 50% transparency. It will also appear in the four corners of each page.</p>
                </div>
                {logoDataUrl && (
                  <div style={{width:100,height:100,border:"1px solid #ddd",padding:8,display:"flex",alignItems:"center",justifyContent:"center",backgroundColor:"#f9f9f9",borderRadius:4}}>
                    <img src={logoDataUrl} alt="Logo preview" style={{maxWidth:"100%",maxHeight:"100%",objectFit:"contain"}} />
                  </div>
                )}
              </div>
            </div>
            <div className="btn-row">
              <span style={{ fontSize:".72rem", color:"#aaa", letterSpacing:"1px", textTransform:"uppercase", fontWeight:600 }}>No data leaves your browser</span>
              <button className="btn btn-filled" disabled={!pdfFile || parsing} onClick={handleExtract}>
                {parsing ? <><span className="spin" />Parsing…</> : "Parse & Continue →"}
              </button>
            </div>
          </div>
        )}

        {/* ══ STEP 1: ENTER MARKS ══ */}
        {step === 1 && (
          <div>
            <div className="card">
              <div className="card-title">Experiment Details</div>
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:16 }}>
                <div className="inp-group">
                  <label>Week (e.g. Week 1)</label>
                  <input type="text" value={labInfo.weekNo} onChange={e => updateLab("weekNo", e.target.value)} placeholder="Week 1" />
                </div>
                <div className="inp-group">
                  <label>Program / Experiment Name</label>
                  <input type="text" value={labInfo.experimentTitle} onChange={e => updateLab("experimentTitle", e.target.value)} placeholder="e.g. COD" />
                </div>
              </div>
            </div>

            <div className="card">
              <div className="card-title">Section A — Questions &amp; Marks</div>
              <p style={{ fontSize:".76rem", color:"#888", fontStyle:"italic", marginBottom:16 }}>Marks are extracted directly from the student's PDF and are not editable.</p>
              {qaList.length === 0 && <p style={{ fontSize:".85rem", color:"#999" }}>No questions detected.</p>}
              {qaList.map((qa, idx) => (
                <div className="qa-item" key={qa.id}>
                  <div className="qa-head">
                    <span className="qa-num">Question {idx + 1}</span>
                    <div className="qa-right">
                      {qa.status && <span className="stag">{qa.status}</span>}
                      <span className="marks-display">{qa.marksObtained !== "" ? qa.marksObtained : "0"} / {qa.maxMarks}</span>
                    </div>
                  </div>
                  <div className="qa-ps">{qa.problemStatement || <em style={{ color:"#aaa" }}>No problem statement extracted.</em>}</div>
                </div>
              ))}
              <div style={{ display:"flex", justifyContent:"flex-end", paddingTop:10, gap:8, alignItems:"center" }}>
                <span style={{ fontSize:".78rem", color:"#888" }}>Total marks from PDF:</span>
                <strong style={{ fontFamily:"'IBM Plex Mono',monospace", fontSize:"1rem" }}>{totalObtained} / {totalMax}</strong>
              </div>
            </div>

            <div className="card">
              <div className="card-title">Section B — Marks Rubric</div>
              <table className="rtable">
                <thead><tr><th>Criteria</th><th style={{ width:140, textAlign:"center" }}>Maximum Marks</th><th style={{ width:150, textAlign:"center" }}>Marks Obtained</th></tr></thead>
                <tbody>
                  {rubric.map((row, idx) => (
                    <tr key={idx}>
                      <td>{row.criteria}</td>
                      <td style={{ textAlign:"center" }}>{row.maxMarks}</td>
                      <td style={{ textAlign:"center" }}>
                        <input type="number" min="0" max={row.maxMarks} value={row.obtained} onChange={e => updateRubric(idx, "obtained", e.target.value)} placeholder="" />
                      </td>
                    </tr>
                  ))}
                  <tr className="total-r">
                    <td>Total</td>
                    <td style={{ textAlign:"center" }}>{rubricMax}</td>
                    <td style={{ textAlign:"center" }}>{rubricObtained > 0 ? rubricObtained : ""}</td>
                  </tr>
                </tbody>
              </table>
            </div>

            <div className="card">
              <div className="card-title">Section C — Result &amp; Remarks</div>
              <div className="inp-group">
                <label>Result</label>
                <textarea value={result} onChange={e => setResult(e.target.value)}
                  placeholder="e.g. The student has successfully completed all programs and demonstrated a clear understanding of the concepts."
                  style={{ minHeight:96 }} />
              </div>
            </div>

            <div className="card">
              <div className="card-title">Section D — Sample Test Cases (Auto-Extracted {qaList.some(q => q.testCase && q.testCase.trim()) ? "✓" : ""})</div>
              {qaList.some(q => q.testCase && q.testCase.trim()) ? (
                <div>
                  <label style={{display:"flex",alignItems:"center",gap:10,cursor:"pointer",fontSize:".875rem",fontWeight:500,marginBottom:12}}>
                    <input type="checkbox" checked={includeTestCases} onChange={e => setIncludeTestCases(e.target.checked)} 
                      style={{cursor:"pointer",width:18,height:18}} />
                    Include sample test cases in the record (extracted from PDF)
                  </label>
                  {includeTestCases && (
                    <div style={{background:"#f9f9f9",border:"1px solid #ddd",padding:12,borderRadius:4,marginTop:12}}>
                      <p style={{fontSize:".75rem",color:"#666",marginBottom:12}}>Test cases found for:</p>
                      <ul style={{fontSize:".85rem",color:"#333",marginLeft:20}}>
                        {qaList.map((qa, idx) => qa.testCase && qa.testCase.trim() && <li key={idx}>Question {idx + 1}</li>)}
                      </ul>
                    </div>
                  )}
                </div>
              ) : (
                <p style={{fontSize:".85rem",color:"#999"}}>No sample test cases were found in the uploaded PDF.</p>
              )}
            </div>

            <div className="btn-row">
              <button className="btn" onClick={() => setStep(0)}>← Re-upload</button>
              <button className="btn btn-filled" onClick={() => setStep(2)}>Preview &amp; Print →</button>
            </div>
          </div>
        )}

        {/* ══ STEP 2: PRINT / DOWNLOAD ══ */}
        {step === 2 && (
          <div>
            <div className="no-print" style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:20, gap:12, flexWrap:"wrap" }}>
              <button className="btn" onClick={() => setStep(1)}>← Edit Marks</button>
              <div style={{ display:"flex", gap:10 }}>
                <button className="btn" onClick={resetAll}>New Record</button>
                <button className="btn" onClick={() => window.print()}>🖨 Print</button>
                <button className="btn btn-filled" onClick={handleDownloadPDF} disabled={downloading}>
                  {downloading ? <><span className="spin" />Generating…</> : "⬇ Download PDF"}
                </button>
              </div>
            </div>

            <div ref={printAreaRef} className="pr-wrap">
              <div className="pr-pages-wrapper">
                <div className="print-page-border" />

                <div className="pr-page">
                  <div className="pr-page-inner">
                    <div className="pr-content-wrapper">
                      <div className="pr-header">
                        <div className="pr-inst">{labInfo.institution || "PSG Institute of Technology and Applied Research"}</div>
                        <div className="pr-subtitle">Laboratory Record</div>
                        <div className="pr-lab">{labInfo.labName || "Artificial Intelligence and Machine Learning Laboratory"}</div>
                      </div>

                      <div className="info-strip">
                        <div className="info-cell"><div className="ic-label">Student Name</div><div className="ic-value">{si.name || ""}</div></div>
                        <div className="info-cell"><div className="ic-label">Roll Number</div><div className="ic-value">{si.rollNo || ""}</div></div>
                        <div className="info-cell"><div className="ic-label">Department</div><div className="ic-value">{si.department || si.branch || ""}</div></div>
                        <div className="info-cell"><div className="ic-label">Date</div><div className="ic-value">{labInfo.date || today}</div></div>
                      </div>
                      <div className="info-strip row2">
                        <div className="info-cell"><div className="ic-label">Email</div><div className="ic-value">{si.email || ""}</div></div>
                        <div className="info-cell"><div className="ic-label">Phone</div><div className="ic-value">{si.phone || ""}</div></div>
                        <div className="info-cell"><div className="ic-label">Batch</div><div className="ic-value">{si.batch || ""}</div></div>
                        <div className="info-cell"><div className="ic-label">Degree</div><div className="ic-value">{si.degree || ""}</div></div>
                      </div>
                      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",padding:"8px 0",borderBottom:"1px solid #bbb",marginBottom:12}}>
                        <div style={{flex:1}}>
                          <div style={{fontSize:".5rem",fontWeight:700,letterSpacing:"1.2px",textTransform:"uppercase",color:"#888",marginBottom:2}}>Week</div>
                          <div style={{fontSize:".9rem",fontWeight:600,fontFamily:"'Source Serif 4'",color:"#1c1c1c"}}>{labInfo.weekNo || "Week 1"}</div>
                          {labInfo.experimentTitle && (
                            <>
                              <div style={{fontSize:".5rem",fontWeight:700,letterSpacing:"1.2px",textTransform:"uppercase",color:"#888",marginTop:6,marginBottom:2}}>Program</div>
                              <div style={{fontSize:".85rem",fontStyle:"italic",color:"#333"}}>{labInfo.experimentTitle}</div>
                            </>
                          )}
                        </div>
                        <div style={{textAlign:"right",paddingLeft:12,borderLeft:"1px solid #bbb"}}>
                          <div style={{fontSize:".5rem",fontWeight:700,letterSpacing:"1.2px",textTransform:"uppercase",color:"#888",marginBottom:4}}>Total Score</div>
                          <div style={{fontSize:"1.4rem",fontWeight:700,fontFamily:"'Source Serif 4'"}}>{totalObtained}<span style={{fontSize:".9rem",fontWeight:400,color:"#666"}}> / {totalMax}</span></div>
                        </div>
                      </div>

                      {qaList.map((qa, idx) => (
                        <div key={qa.id} className="pr-qa">
                          <div className="pr-qa-head">
                            <span className="pr-qnum">Question {idx + 1}</span>
                            <div className="pr-qa-right">
                              {qa.status && <span className="pr-stag">{qa.status}</span>}
                              <span className="pr-mk">Marks: {qa.marksObtained !== "" ? qa.marksObtained : "0"} / {qa.maxMarks}</span>
                            </div>
                          </div>
                          <div className="pr-qa-body">
                            <div className="ps-text">{qa.problemStatement || ""}</div>
                            {includeTestCases && qa.testCase && qa.testCase.trim() && (
                              <div className="ps-text" style={{marginTop:8}}>{qa.testCase}</div>
                            )}
                          </div>
                        </div>
                      ))}

                      <div className="pr-result">
                        <div className="section-hd">Result &amp; Remarks</div>
                        <div className="pr-result-write pr-result-text">{result || "\n\n\n"}</div>
                      </div>
                      <div className="pr-rubric">
                        <div className="section-hd">Marks Rubric</div>
                        <table className="rtable" style={{fontSize:".8rem"}}>
                          <thead><tr><th>Criteria</th><th style={{ width:120, textAlign:"center" }}>Max</th><th style={{ width:120, textAlign:"center" }}>Obtained</th></tr></thead>
                          <tbody>
                            {rubric.map((row, idx) => (
                              <tr key={idx}><td>{row.criteria}</td><td style={{ textAlign:"center" }}>{row.maxMarks}</td><td style={{ textAlign:"center" }}>{row.obtained}</td></tr>
                            ))}
                            <tr className="total-r"><td>Total</td><td style={{ textAlign:"center" }}>{rubricMax}</td><td style={{ textAlign:"center" }}>{rubricObtained > 0 ? rubricObtained : ""}</td></tr>
                          </tbody>
                        </table>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
