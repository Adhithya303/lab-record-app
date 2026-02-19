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
    rollNo:     get("Roll no:") || get("Roll no") || get("Roll Number") || get("Register Number") || get("Reg No"),
    email:      get("Email:") || get("Email"),
    phone:      get("Phone:") || get("Phone"),
    branch:     get("Branch:") || get("Branch"),
    department: get("Department:") || get("Department"),
    batch:      get("Batch:") || get("Batch"),
    degree:     get("Degree:") || get("Degree"),
  };

  // Clean up rollNo - remove if it contains phone/email patterns or invalid data
  if (studentInfo.rollNo) {
    const rollNoLower = studentInfo.rollNo.toLowerCase();
    // Filter out if it looks like phone, email, or other non-rollno data
    if (rollNoLower.includes('phone') || 
        rollNoLower.includes('email') || 
        rollNoLower.includes('@') ||
        rollNoLower.includes('name') ||
        rollNoLower.includes('branch') ||
        rollNoLower.includes('department') ||
        studentInfo.rollNo.length > 20) {
      studentInfo.rollNo = "";
    }
  }

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

const STEPS = ["Upload PDF", "Enter Marks & Download"];

// ── Main App ─────────────────────────────────────────────────────
export default function LabRecordApp() {
  const [step, setStep]               = useState(0);
  const [pdfFile, setPdfFile]         = useState(null);
  const [logoDataUrl, setLogoDataUrl] = useState(null);
  const [parsing, setParsing]         = useState(false);
  const [parseError, setParseError]   = useState("");
  const [downloading, setDownloading] = useState(false);

  const [parsedStudent, setParsedStudent] = useState(null);
  const [labInfo, setLabInfo]   = useState({ institution:"", labName:"", weekNo:"", experimentTitle:"", date:"", totalMarks:"" });
  const [qaList, setQaList]     = useState([]);
  const [selectedQuestions, setSelectedQuestions] = useState(new Set());
  const [rubric, setRubric]     = useState(rubricDefaults.map(r => ({ ...r })));
  const [includeTestCases, setIncludeTestCases] = useState(false);
  const [result, setResult]     = useState("");
  const [manualRollNo, setManualRollNo] = useState("");

  const fileInputRef = useRef();

  const dropRef      = useRef();
  const printAreaRef = useRef();

  const handleFile = (file) => {
    if (!file || file.type !== "application/pdf") return;
    setPdfFile(file); setParseError("");
  };



  const handleExtract = async () => {
    if (!pdfFile) return;
    setParsing(true); setParseError("");
    try {
      const text = await extractTextFromPDF(pdfFile);
      const { studentInfo: si, labInfo: li, questions } = parsePSGLabPDF(text);
      setParsedStudent(si);
      setLabInfo(li);
      setManualRollNo(si.rollNo || "");
      const questionsWithId = questions.map((q, i) => ({ ...q, id: i }));
      setQaList(questionsWithId);
      // Select all questions by default
      setSelectedQuestions(new Set(questionsWithId.map(q => q.id)));
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
  const effectiveRollNo = manualRollNo || si.rollNo || "";
  const totalObtained  = qaList.reduce((s, q) => s + (parseFloat(q.marksObtained) || 0), 0);
  const totalMax       = qaList.reduce((s, q) => s + (parseFloat(q.maxMarks) || 0), 0);
  const rubricObtained = rubric.reduce((s, r) => s + (parseFloat(r.obtained) || 0), 0);
  const rubricMax      = rubric.reduce((s, r) => s + (parseFloat(r.maxMarks) || 0), 0);

  const resetAll = () => {
    setStep(0); setPdfFile(null); setQaList([]); setResult("");
    setParsedStudent(null);
    setManualRollNo("");
    setRubric(rubricDefaults.map(r => ({ ...r })));
    setLabInfo({ institution:"", labName:"", weekNo:"", experimentTitle:"", date:"", totalMarks:"" });
    setIncludeTestCases(false);
    setSelectedQuestions(new Set());
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const handleDownloadPDF = async () => {
    if (!printAreaRef.current) return;
    setDownloading(true);
    try {
      await loadDownloadLibs();
      const { jsPDF } = window.jspdf;
      const el = printAreaRef.current;
      const findBreakY = (ctx, preferredY, minY, maxY) => {
        const w = ctx.canvas.width;
        const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
        const start = clamp(Math.floor(minY), 0, ctx.canvas.height - 1);
        const end = clamp(Math.floor(maxY), 0, ctx.canvas.height - 1);
        const pref = clamp(Math.floor(preferredY), start, end);

        const scoreRow = (y) => {
          const data = ctx.getImageData(0, y, w, 1).data;
          let sum = 0;
          let dark = 0;
          for (let i = 0; i < data.length; i += 4) {
            const r = data[i], g = data[i + 1], b = data[i + 2];
            const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
            sum += lum;
            if (lum < 245) dark++;
          }
          const avg = sum / (w || 1);
          return { avg, darkRatio: dark / (w || 1) };
        };

        let bestY = pref;
        let bestScore = Infinity;
        const windowPx = Math.min(120, end - start);
        for (let dy = 0; dy <= windowPx; dy++) {
          const y1 = pref + dy;
          const y2 = pref - dy;
          for (const y of [y1, y2]) {
            if (y < start || y > end) continue;
            const { avg, darkRatio } = scoreRow(y);
            const score = (255 - avg) + darkRatio * 255;
            if (score < bestScore) {
              bestScore = score;
              bestY = y;
            }
          }
        }
        return bestY;
      };

      const scaleFactor = 1.2;

      // Clone print area so we can render it without any visible flash
      const clone = el.cloneNode(true);
      clone.style.position = 'fixed';
      clone.style.left = '-10000px';
      clone.style.top = '0';
      clone.style.opacity = '1';
      clone.style.pointerEvents = 'none';
      clone.style.zIndex = '-9999';
      clone.classList.add('pdf-generating');

      // A4 proportions: 210 x 297 mm → render at exact pixel width for clean slicing
      const a4WidthPx = 794;  // 210mm at 96dpi
      clone.style.width = a4WidthPx + 'px';
      document.body.appendChild(clone);

      const canvas = await window.html2canvas(clone, {
        scale: 1.2, useCORS: true, backgroundColor: "#ffffff",
        logging: false, windowWidth: a4WidthPx, width: a4WidthPx,
      });

      // ── Build protected zones from clone before removing it ──
      const protectedZones = [];
      const keepEls = clone.querySelectorAll('[data-pdf-keep-together]');
      const cloneRect = clone.getBoundingClientRect();
      for (const ke of keepEls) {
        const r = ke.getBoundingClientRect();
        const topPx  = (r.top - cloneRect.top) * scaleFactor;
        const botPx  = (r.bottom - cloneRect.top) * scaleFactor;
        protectedZones.push({ top: topPx, bottom: botPx });
      }

      // Remove clone immediately
      document.body.removeChild(clone);

      const mainCtx = canvas.getContext("2d", { willReadFrequently: true });
      const pageW   = 210;
      const pageH   = 297;
      const margin  = 10;
      const usableW = pageW - margin * 2;
      const ratio   = usableW / (canvas.width / scaleFactor);
      const usableH = pageH - margin * 2;
      const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4", compress: true });

      // ── Load logo for watermark: prefer uploaded, fallback to college logo ──
      let logoImg = null;
      const loadImgAsDataUrl = (url) => new Promise((resolve) => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => {
          const c = document.createElement('canvas');
          c.width = img.naturalWidth; c.height = img.naturalHeight;
          const cx = c.getContext('2d');
          cx.drawImage(img, 0, 0);
          resolve(c.toDataURL('image/png'));
        };
        img.onerror = () => resolve(null);
        img.src = url;
      });
      if (logoDataUrl) {
        logoImg = logoDataUrl;
      } else {
        logoImg = await loadImgAsDataUrl('/Collegelogofinal.png');
      }

      // ── Helper: draw borders, watermarks & logo ON TOP of content (per page) ──
      const drawPageOverlays = () => {
        // Border
        doc.setDrawColor(28, 28, 28);
        doc.setLineWidth(0.5);
        doc.rect(5, 5, pageW - 10, pageH - 10);

        // Logo watermark — centered on each A4 page
        if (logoImg) {
          const logoWidth = 60;   // mm — narrower logo width
          const logoHeight = 75;  // mm — logo height
          const lx = (pageW - logoWidth) / 2;
          const ly = (pageH - logoHeight) / 2;
          doc.saveGraphicsState();
          doc.setGState(new doc.GState({ opacity: 0.2 }));
          doc.addImage(logoImg, 'PNG', lx, ly, logoWidth, logoHeight);
          doc.restoreGraphicsState();
        }

        // Corner register number watermarks
        const regNo = effectiveRollNo || '';
        if (regNo) {
          doc.saveGraphicsState();
          doc.setGState(new doc.GState({ opacity: 0.15 }));
          doc.setFontSize(9);
          doc.setTextColor(0, 0, 0);
          doc.text(regNo, 8, 9);
          doc.text(regNo, pageW - 8, 9, { align: 'right' });
          doc.text(regNo, 8, pageH - 6);
          doc.text(regNo, pageW - 8, pageH - 6, { align: 'right' });
          doc.restoreGraphicsState();
        }
      };

      let srcY = 0;
      const usableHPx = (usableH / ratio) * scaleFactor;
      while (srcY < canvas.height - 1) {
        const remainingPx = canvas.height - srcY;
        const desiredPx = Math.min(usableHPx, remainingPx);
        const preferredBreak = srcY + desiredPx;
        const searchMin = srcY + Math.max(80, desiredPx - 180);
        const searchMax = Math.min(canvas.height - 1, srcY + desiredPx + 120);
        let breakY = preferredBreak;
        if (mainCtx && remainingPx > 220) {
          breakY = findBreakY(mainCtx, preferredBreak, searchMin, searchMax);
        }
        breakY = Math.max(srcY + 120, Math.min(breakY, canvas.height));

        // ── Protect keep-together elements: if breakY falls inside one, move break before it ──
        for (const zone of protectedZones) {
          if (breakY > zone.top && breakY < zone.bottom) {
            // Only move break before the zone if the zone fits on a single page
            if ((zone.bottom - zone.top) <= usableHPx) {
              breakY = Math.max(srcY + 80, zone.top - 10);
            }
            break;
          }
        }

        const slicePx = breakY - srcY;
        const sliceH = (slicePx / scaleFactor) * ratio;

        const slice = document.createElement("canvas");
        slice.width = canvas.width;
        slice.height = Math.ceil(slicePx);
        const sCtx = slice.getContext("2d");
        sCtx.fillStyle = "#ffffff";
        sCtx.fillRect(0, 0, slice.width, slice.height);
        sCtx.drawImage(canvas, 0, Math.floor(srcY), canvas.width, Math.ceil(slicePx), 0, 0, canvas.width, Math.ceil(slicePx));

        // Content image first — use JPEG with compression for smaller file size
        doc.addImage(slice.toDataURL("image/jpeg", 0.6), "JPEG", margin, margin, usableW, sliceH, undefined, 'FAST');
        // Then overlays ON TOP with transparency
        drawPageOverlays();

        srcY = breakY;
        if (srcY < canvas.height - 1) doc.addPage();
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
    <div style={{ fontFamily:"Calibri, 'Segoe UI', Arial, sans-serif", minHeight:"100vh", background:"#f4f1ec", color:"#1c1c1c", position:"relative" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Source+Serif+4:ital,wght@0,400;0,600;0,700;1,400&family=DM+Sans:wght@300;400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap');
        *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
        .bg-image-overlay{position:fixed;top:0;left:0;width:100%;height:100%;background:url('/image.png') center/cover no-repeat;opacity:0.5;z-index:0;pointer-events:none}
        .wrap{max-width:900px;margin:0 auto;padding:32px 24px 80px;position:relative;z-index:1}
        .app-header{display:flex;align-items:flex-end;justify-content:space-between;padding-bottom:20px;border-bottom:2.5px solid #1c1c1c;margin-bottom:30px}
        .app-header h1{font-family:'Source Serif 4',Georgia,serif;font-size:1.95rem;font-weight:700;letter-spacing:-.5px}
        .app-header .sub{font-size:.8rem;font-weight:600;letter-spacing:2.5px;text-transform:uppercase;color:#999;margin-top:4px}
        .badge-inst{background:#1c1c1c;color:#f4f1ec;padding:6px 16px;font-size:.77rem;font-weight:700;letter-spacing:2px;text-transform:uppercase}
        .steps{display:flex;margin-bottom:28px;border:1.5px solid #1c1c1c}
        .step-item{display:flex;align-items:center;justify-content:center;gap:8px;flex:1;padding:11px 0;font-size:.83rem;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;border-right:1.5px solid #1c1c1c;color:#666}
        .step-item:last-child{border-right:none}
        .step-item.active{background:#1c1c1c;color:#f4f1ec}
        .step-item.done{background:#444;color:#fff}
        .step-num{width:20px;height:20px;border-radius:50%;border:1.5px solid currentColor;display:flex;align-items:center;justify-content:center;font-size:.8rem;flex-shrink:0}
        .card{background:#fff;border:1.5px solid #ddd7ce;padding:26px 28px;margin-bottom:20px}
        .card-title{font-family:'Source Serif 4',Georgia,serif;font-size:1.15rem;font-weight:700;margin-bottom:20px;display:flex;align-items:center;gap:10px}
        .card-title::after{content:'';flex:1;height:1px;background:#e8e2d9}
        .upload-zone{border:2px dashed #c5bfb4;padding:52px 24px;text-align:center;cursor:pointer;background:#faf8f5;transition:border-color .2s,background .2s}
        .upload-zone:hover,.upload-zone.drag-over{border-color:#1c1c1c;background:#f0ede7}
        .upload-icon{font-size:3.15rem;margin-bottom:12px;display:block}
        .upload-title{font-family:'Source Serif 4',Georgia,serif;font-size:1.25rem;font-weight:600;margin-bottom:6px}
        .upload-hint{font-size:.93rem;color:#999;margin-top:6px}
        .file-pill{display:flex;align-items:center;gap:10px;background:#f0f0f0;border:1.5px solid #888;padding:11px 16px;margin-top:14px}
        .file-name{font-size:1.01rem;color:#1c1c1c;font-weight:600;font-family:'IBM Plex Mono',monospace}
        .file-size{margin-left:auto;font-size:.87rem;color:#777}
        .error-box{background:#fdecea;border:1.5px solid #f5c6c2;padding:12px 16px;font-size:.97rem;color:#c0392b;margin-top:14px}
        .spin{display:inline-block;width:14px;height:14px;border:2px solid rgba(255,255,255,.3);border-top-color:#fff;border-radius:50%;animation:spin .7s linear infinite}
        @keyframes spin{to{transform:rotate(360deg)}}
        .inp-group{display:flex;flex-direction:column;gap:5px}
        .inp-group label{font-size:.77rem;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#888}
        .inp-group input,.inp-group textarea{border:1.5px solid #d4cec6;padding:9px 12px;font-size:1.025rem;font-family:'DM Sans',sans-serif;background:#faf8f5;color:#1c1c1c;outline:none;width:100%;transition:border-color .15s}
        .inp-group input:focus,.inp-group textarea:focus{border-color:#1c1c1c;background:#fff}
        .inp-group textarea{resize:vertical;min-height:84px}
        .inp-group.result-textarea{width:100%;min-height:120px;border:1px solid #ccc;padding:12px 16px;font-size:1.15rem;font-family:'DM Sans',sans-serif;font-weight:400;line-height:1.6;resize:vertical;outline:none;border-radius:4px;box-sizing:border-box}
        .test-case-check{margin-top:14px}
        .test-case-check label{font-size:1.025rem;font-family:'DM Sans',sans-serif;font-weight:400;color:#1c1c1c;cursor:pointer}
        .test-case-list{margin-top:10px}
        .test-case-item{font-size:1.025rem;font-family:'DM Sans',sans-serif;color:#1c1c1c;padding:6px 0}
        .btn{padding:11px 26px;font-size:.87rem;font-family:'DM Sans',sans-serif;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;cursor:pointer;border:2px solid #1c1c1c;transition:all .15s;display:inline-flex;align-items:center;gap:8px;background:transparent;color:#1c1c1c}
        .btn:hover{background:#1c1c1c;color:#f4f1ec}
        .btn:disabled{opacity:.5;cursor:not-allowed}
        .btn-filled{background:#1c1c1c;color:#f4f1ec}
        .btn-filled:hover{background:#333}
        .btn-filled:disabled{background:#bbb;border-color:#bbb}
        .btn-row{display:flex;justify-content:space-between;align-items:center;margin-top:24px;gap:12px;flex-wrap:wrap}
        .qa-item{border:1.5px solid #ddd7ce;margin-bottom:14px;background:#fff}
        .qa-head{background:#f4f1ec;border-bottom:1px solid #ddd7ce;padding:11px 16px;display:flex;align-items:center;justify-content:space-between;gap:12px}
        .qa-num{font-family:'Source Serif 4',Georgia,serif;font-weight:700;font-size:1.1rem}
        .qa-right{display:flex;align-items:center;gap:14px}
        .stag{font-size:.77rem;font-weight:700;letter-spacing:1px;text-transform:uppercase;padding:3px 9px;border:1px solid #888;color:#333}
        .marks-display{font-family:'IBM Plex Mono',monospace;font-size:1.025rem;font-weight:600;background:#fff;border:1px solid #ccc;padding:4px 12px}
        .qa-ps{padding:14px 16px;font-size:1.025rem;line-height:1.72;color:#2a2a2a;font-family:'Source Serif 4',Georgia,serif}
        .rtable{width:100%;border-collapse:collapse;font-size:1rem;margin-top:8px}
        .rtable th{border:1.5px solid #000;padding:12px 14px;text-align:left;font-size:.77rem;letter-spacing:1.2px;text-transform:uppercase;font-weight:700;background:#fff;color:#000}
        .rtable td{border:1.5px solid #000;padding:11px 14px;color:#000}
        .rtable .total-r td{font-weight:700;font-family:Calibri, 'Segoe UI', Arial, sans-serif;background:#fff;border:1.5px solid #000;color:#000}
        .rtable input[type=number]{width:80px;border:1px solid #ccc;padding:6px 8px;font-size:.97rem;font-family:'DM Sans',sans-serif;background:#fff;text-align:center;outline:none}
        .rtable input[type=number]:focus{border-color:#1c1c1c;background:#fafafa}
        .pr-wrap{background:#fff;display:flex;flex-direction:column}
        .pr-pages-wrapper{display:flex;flex-direction:column;padding:0;background:#fff}
        .pr-page{background:#fff;width:210mm;min-height:297mm;height:auto;margin:0 auto;padding:6mm 18mm 18mm 18mm;box-sizing:border-box;position:relative;overflow:visible;border:none;box-shadow:0 0 0 2px #1c1c1c}
        .pr-page::before{content:'';position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:40%;height:40%;background:url('/Collegelogofinal.png') center/contain no-repeat;opacity:0.2;pointer-events:none;z-index:0}
        .pr-page-inner{position:relative;height:auto;width:100%;display:flex;flex-direction:column}
        .print-page-border{position:fixed;top:10mm;left:10mm;right:10mm;bottom:10mm;border:2px solid #1c1c1c;z-index:1;pointer-events:none;display:none}

        .page-wm-reg{position:absolute;font-size:0.7rem;font-weight:600;opacity:0.15;color:#000;pointer-events:none;z-index:0;font-family:'IBM Plex Mono',monospace !important;letter-spacing:1px}
        .page-wm-reg.wm-tl{top:2mm;left:2mm}.page-wm-reg.wm-tr{top:2mm;right:2mm}.page-wm-reg.wm-bl{bottom:2mm;left:2mm}.page-wm-reg.wm-br{bottom:2mm;right:2mm}
        .print-fixed-wm{display:none;position:fixed;pointer-events:none;z-index:9999}

        .print-fixed-reg{font-size:0.7rem;font-weight:600;opacity:0.15;color:#000;font-family:'IBM Plex Mono',monospace !important;letter-spacing:1px}
        .print-fixed-reg.wm-tl{top:12mm;left:12mm}.print-fixed-reg.wm-tr{top:12mm;right:12mm}.print-fixed-reg.wm-bl{bottom:12mm;left:12mm}.print-fixed-reg.wm-br{bottom:12mm;right:12mm}
        .pdf-hide{visibility:visible}
        .pdf-generating .pdf-hide{visibility:hidden !important}
        .pdf-generating .pr-page{box-shadow:none !important}
        .pdf-generating .pr-page::before{display:none !important}
        .pr-content-wrapper{position:relative;z-index:2;flex:1;overflow:visible;font-size:14pt;line-height:1.5;font-family:Calibri, 'Segoe UI', Arial, sans-serif;color:#000}
        .pr-content-wrapper *{color:#000 !important;font-family:Calibri, 'Segoe UI', Arial, sans-serif !important;font-size:14pt}
        .pr-header{text-align:center;padding:8px 0 10px;border-bottom:2px solid #1c1c1c;margin-bottom:12px}
        .pr-inst{font-family:Calibri, 'Segoe UI', Arial, sans-serif;font-size:16pt;font-weight:700;letter-spacing:.2px;margin-bottom:6px}
        .pr-subtitle{font-size:.7rem;font-weight:700;letter-spacing:2.5px;text-transform:uppercase;color:#666;margin:8px 0 4px}
        .pr-lab{font-family:Calibri, 'Segoe UI', Arial, sans-serif;font-size:16pt;font-weight:700;font-style:normal;color:#333;margin-top:6px}
        .info-strip{display:grid;grid-template-columns:repeat(4,1fr);border-bottom:1px solid #bbb;margin-bottom:10px}
        .info-strip.row2{grid-template-columns:1.8fr 1.2fr 1fr 1fr;border-bottom:1px solid #bbb;margin-bottom:10px}
        .info-cell{padding:8px 10px;border-right:1px solid #bbb}
        .info-cell:last-child{border-right:none}
        .ic-label{font-size:.65rem;font-weight:700;letter-spacing:1.2px;text-transform:uppercase;color:#888;margin-bottom:2px}
        .ic-value{font-size:.97rem;color:#1c1c1c;font-weight:700;font-family:'Source Serif 4',Georgia,serif;word-break:break-all}
        .exp-strip{border-bottom:1px solid #bbb;padding:14px 24px;display:flex;justify-content:space-between;align-items:flex-start}
        .exp-meta-label{font-size:.7rem;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#999;margin-bottom:3px}
        .exp-meta-val{font-family:'Source Serif 4',Georgia,serif;font-size:1.1rem;font-weight:700}
        .exp-prog-label{font-size:.7rem;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#999;margin-top:10px;margin-bottom:3px}
        .exp-prog-val{font-family:'Source Serif 4',Georgia,serif;font-size:1.05rem;font-style:italic;color:#333}
        .exp-right-block{text-align:right;padding-left:24px;border-left:1px solid #bbb}
        .score-meta-label{font-size:.7rem;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#999;margin-bottom:4px}
        .score-num{font-family:'Source Serif 4',Georgia,serif;font-size:1.75rem;font-weight:700;line-height:1}
        .pr-content{padding:0;background:#fff;flex:1;overflow:visible;font-size:14pt;line-height:1.5}
        .pr-qa{border:none;margin:0 0 14px 0;padding:0;font-size:14pt;page-break-inside:avoid;break-inside:avoid}
        .pr-qa-head{background:transparent;border-bottom:1px solid #bbb;padding:8px 0;display:flex;align-items:flex-end;justify-content:space-between;font-weight:600;break-after:avoid;page-break-after:avoid}
        .pr-qnum{font-family:'Source Serif 4',Georgia,serif;font-weight:700;font-size:1.1rem;color:#1c1c1c}
        .pr-qa-right{display:flex;align-items:center;gap:14px;font-size:.97rem}
        .pr-stag{font-size:.75rem;font-weight:700;letter-spacing:1px;text-transform:uppercase;padding:3px 10px;border:1px solid #888;color:#333;background:transparent}
        .pr-mk{font-family:'IBM Plex Mono',monospace;font-size:.97rem;font-weight:600}
        .pr-qa-body{padding:10px 0 0 0;break-inside:auto;page-break-inside:auto}
        .ps-label{font-size:.7rem;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#000;margin-bottom:8px;page-break-inside:avoid;break-inside:avoid}
        .ps-text{font-family:'IBM Plex Mono',monospace;font-size:14pt;line-height:1.6;color:#000;white-space:pre-wrap;background:transparent;margin:6px 0 0 0;padding:0;border:none;page-break-inside:avoid;break-inside:avoid}
        .pr-result{margin:18px 0;padding:0;page-break-inside:avoid;break-inside:avoid}
        .section-hd{font-size:.71rem;font-weight:700;letter-spacing:2.2px;text-transform:uppercase;color:#555;margin-bottom:10px}
        .pr-result-text{font-family:Calibri, 'Segoe UI', Arial, sans-serif;font-size:25pt;line-height:1.4;color:#000}
        .pr-result-write{min-height:90px;border:1px solid #1c1c1c;padding:10px 12px;white-space:pre-wrap;break-inside:avoid;page-break-inside:avoid}
        .pr-rubric{margin-bottom:0;page-break-inside:avoid;break-inside:avoid}
        .pr-rubric, .pr-rubric *{font-size:16pt}
        .pr-rubric table{page-break-inside:avoid;break-inside:avoid}

        @media print{
          *{-webkit-print-color-adjust:exact;print-color-adjust:exact}
          .pr-pages-wrapper{background:#fff;padding:0}
          .pr-page{box-shadow:none;margin:0;width:auto;min-height:auto;padding:12mm;border:none}
          .print-page-border{display:block}
          .print-fixed-wm{display:block !important}
          .pr-qa{break-inside:avoid;page-break-inside:avoid}
          .ps-text{orphans:3;widows:3}
          .pr-page::before{opacity:0.08 !important}
        }
        .dl-sub{font-size:.93rem;color:#888}
        .page-nav{display:flex;justify-content:center;align-items:center;gap:12px;margin-top:20px;padding:20px;background:#f4f1ec;border:1px solid #ddd;border-radius:4px}
        .page-nav button{padding:8px 16px;font-size:.9rem;font-weight:600;border:1px solid #1c1c1c;background:transparent;color:#1c1c1c;cursor:pointer;transition:all .2s}
        .page-nav button:hover{background:#1c1c1c;color:#f4f1ec}
        .page-nav button:disabled{opacity:.5;cursor:not-allowed}
        .page-info{font-size:.95rem;color:#666;font-weight:600}
        .pr-page-visible{display:flex !important}
        .pr-page-hidden{display:none !important}
        .watermark-container{position:relative}
        .watermark-center{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);font-size:6.15rem;font-weight:700;opacity:0.5;color:#ccc;text-align:center;pointer-events:none;z-index:0;max-width:80%}
        .watermark-logo{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);opacity:0.5;pointer-events:none;z-index:0;max-width:40%;max-height:40%;object-fit:contain;filter:grayscale(100%)}
        .watermark-corner{position:absolute;font-size:1.15rem;font-weight:600;opacity:0.4;color:#999;pointer-events:none;font-family:'IBM Plex Mono',monospace;letter-spacing:2px}
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

      <div className="bg-image-overlay"></div>

      <div className="wrap">
        <div className="app-header no-print">
          <div style={{display:"flex",alignItems:"center",gap:16}}>
            <img src="/Collegelogo.png" alt="PSG iTech" style={{height:68,width:68,objectFit:"contain"}} />
            <div>
              <h1>Lab Record Generator</h1>
              <div className="sub" style={{fontSize:"18px",color:"#000"}}>PSG Institute of Technology and Applied Research</div>
            </div>
          </div>
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


            <div className="btn-row" style={{justifyContent:"flex-end"}}>
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
                <div className="inp-group">
                  <label>Register Number {parsedStudent?.rollNo && parsedStudent.rollNo.trim() ? "(from PDF)" : "(not found in PDF — enter manually)"}</label>
                  {parsedStudent?.rollNo && parsedStudent.rollNo.trim() ? (
                    <input type="text" value={manualRollNo} readOnly style={{backgroundColor:"#f0f0f0",cursor:"not-allowed",color:"#555"}} />
                  ) : (
                    <input type="text" value={manualRollNo} onChange={e => setManualRollNo(e.target.value)} placeholder="e.g. 715524104007" />
                  )}
                </div>
              </div>
            </div>

            <div className="card">
              <div className="card-title" style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                <span>Section A — Questions &amp; Marks</span>
                <div style={{display:"flex",gap:8}}>
                  <button 
                    className="btn" 
                    onClick={() => setSelectedQuestions(new Set(qaList.map(q => q.id)))}
                    style={{padding:"6px 12px",fontSize:".85rem"}}
                  >
                    Select All
                  </button>
                  <button 
                    className="btn" 
                    onClick={() => setSelectedQuestions(new Set())}
                    style={{padding:"6px 12px",fontSize:".85rem"}}
                  >
                    Deselect All
                  </button>
                </div>
              </div>
              <p style={{ fontSize:".91rem", color:"#888", fontStyle:"italic", marginBottom:16 }}>Marks are extracted directly from the student's PDF and are not editable. Select questions to include in the PDF.</p>
              {qaList.length === 0 && <p style={{ fontSize:"1rem", color:"#999" }}>No questions detected.</p>}
              {qaList.map((qa, idx) => (
                <div className="qa-item" key={qa.id} style={{opacity: selectedQuestions.has(qa.id) ? 1 : 0.5}}>
                  <div className="qa-head">
                    <label style={{display:"flex",alignItems:"center",gap:10,cursor:"pointer",marginRight:12}}>
                      <input 
                        type="checkbox" 
                        checked={selectedQuestions.has(qa.id)} 
                        onChange={(e) => {
                          const newSelected = new Set(selectedQuestions);
                          if (e.target.checked) {
                            newSelected.add(qa.id);
                          } else {
                            newSelected.delete(qa.id);
                          }
                          setSelectedQuestions(newSelected);
                        }}
                        style={{cursor:"pointer",width:18,height:18,margin:0}} 
                      />
                    </label>
                    <span className="qa-num">Question {idx + 1}</span>
                    <div className="qa-right">
                      {qa.status && <span className="stag">{qa.status}</span>}
                      <span className="marks-display">{qa.marksObtained !== "" ? qa.marksObtained : "0"} / {qa.maxMarks}</span>
                    </div>
                  </div>
                  <div className="qa-ps">{qa.problemStatement || <em style={{ color:"#aaa" }}>No problem statement extracted.</em>}</div>
                </div>
              ))}
              <div style={{ display:"flex", justifyContent:"space-between", paddingTop:10, gap:8, alignItems:"center" }}>
                <span style={{ fontSize:".85rem", color:"#666" }}>Selected: {selectedQuestions.size} of {qaList.length} questions</span>
                <div style={{ display:"flex", gap:8, alignItems:"center" }}>
                  <span style={{ fontSize:".93rem", color:"#888" }}>Total marks:</span>
                  <strong style={{ fontFamily:"'IBM Plex Mono',monospace", fontSize:"1.15rem" }}>{totalObtained} / {totalMax}</strong>
                </div>
              </div>
            </div>


            <div className="card">
              <div className="card-title">Section B — Result</div>
              <div className="inp-group">
                <label>Result</label>
                <textarea value={result} onChange={e => setResult(e.target.value)}
                  placeholder="e.g. The student has successfully completed all programs and demonstrated a clear understanding of the concepts."
                  style={{ minHeight:96 }} />
              </div>
            </div>

            <div className="card">
              <div className="card-title">Section C — Sample Test Cases (Auto-Extracted {qaList.some(q => q.testCase && q.testCase.trim()) ? "✓" : ""})</div>
              {qaList.some(q => q.testCase && q.testCase.trim()) ? (
                <div>
                  <label style={{display:"flex",alignItems:"center",gap:10,cursor:"pointer",fontSize:"1.025rem",fontWeight:500,marginBottom:12}}>
                    <input type="checkbox" checked={includeTestCases} onChange={e => setIncludeTestCases(e.target.checked)} 
                      style={{cursor:"pointer",width:18,height:18}} />
                    Include sample test cases in the record (extracted from PDF)
                  </label>
                  {includeTestCases && (
                    <div style={{background:"#f9f9f9",border:"1px solid #ddd",padding:12,borderRadius:4,marginTop:12}}>
                      <p style={{fontSize:".9rem",color:"#666",marginBottom:12}}>Test cases found for:</p>
                      <ul style={{fontSize:"1rem",color:"#333",marginLeft:20}}>
                        {qaList.map((qa, idx) => qa.testCase && qa.testCase.trim() && <li key={idx}>Question {idx + 1}</li>)}
                      </ul>
                    </div>
                  )}
                </div>
              ) : (
                <p style={{fontSize:"1rem",color:"#999"}}>No sample test cases were found in the uploaded PDF.</p>
              )}
            </div>

            <div className="btn-row">
              <button className="btn" onClick={() => setStep(0)}>← Re-upload</button>
              <div style={{display:"flex",gap:10}}>
                <button className="btn" onClick={resetAll}>New Record</button>
                <button className="btn btn-filled" onClick={handleDownloadPDF} disabled={downloading}>
                  {downloading ? <><span className="spin" />Generating…</> : "⬇ Download PDF"}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ══ HIDDEN PRINT AREA (always rendered for PDF generation) ══ */}
        {step === 1 && (
          <div>
            <div ref={printAreaRef} className="pr-wrap" style={{position:"absolute",left:"-9999px",top:0,opacity:0,pointerEvents:"none"}}>
              <div className="pr-pages-wrapper">
                <div className="print-page-border" />
                {/* Print-only fixed watermarks — appear on every printed page */}

                <div className="print-fixed-wm print-fixed-reg wm-tl">{effectiveRollNo}</div>
                <div className="print-fixed-wm print-fixed-reg wm-tr">{effectiveRollNo}</div>
                <div className="print-fixed-wm print-fixed-reg wm-bl">{effectiveRollNo}</div>
                <div className="print-fixed-wm print-fixed-reg wm-br">{effectiveRollNo}</div>

                <div className="pr-page">
                  {/* PSG iTech watermark + corner register numbers (screen preview) */}

                  <div className="page-wm-reg wm-tl">{effectiveRollNo}</div>
                  <div className="page-wm-reg wm-tr">{effectiveRollNo}</div>
                  <div className="page-wm-reg wm-bl">{effectiveRollNo}</div>
                  <div className="page-wm-reg wm-br">{effectiveRollNo}</div>
                  <div className="pr-page-inner">
                    <div className="pr-content-wrapper">
                      <div className="pr-header">
                        <div className="pr-inst">{labInfo.institution || "PSG Institute of Technology and Applied Research"}</div>
                        <div className="pr-subtitle">Laboratory Record</div>
                        <div className="pr-lab">{labInfo.labName || "PYTHON Lab"}</div>
                      </div>

                      <div className="info-strip">
                        <div className="info-cell"><div className="ic-label">Student Name</div><div className="ic-value">{si.name || ""}</div></div>
                        <div className="info-cell"><div className="ic-label">Register Number</div><div className="ic-value">{effectiveRollNo}</div></div>
                        <div className="info-cell"><div className="ic-label">Department</div><div className="ic-value">{si.department || si.branch || ""}</div></div>
                        <div className="info-cell"><div className="ic-label">Date</div><div className="ic-value">{labInfo.date || today}</div></div>
                      </div>
                      <div className="info-strip row2" style={{gridTemplateColumns:"1.8fr 1.2fr 1fr"}}>
                        <div className="info-cell"><div className="ic-label">Email</div><div className="ic-value">{si.email || ""}</div></div>
                        <div className="info-cell"><div className="ic-label">Batch</div><div className="ic-value">{si.batch || ""}</div></div>
                        <div className="info-cell"><div className="ic-label">Degree</div><div className="ic-value">{si.degree || ""}</div></div>
                      </div>
                      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,padding:"8px 0",borderBottom:"1px solid #bbb",marginBottom:12}}>
                        <div>
                          <div style={{fontSize:".65rem",fontWeight:700,letterSpacing:"1.2px",textTransform:"uppercase",color:"#888",marginBottom:2}}>Week</div>
                          <div style={{fontSize:"1.05rem",fontWeight:600,fontFamily:"'Source Serif 4'",color:"#1c1c1c"}}>{labInfo.weekNo || "Week 1"}</div>
                        </div>
                        <div style={{textAlign:"right"}}>
                          {labInfo.experimentTitle && (
                            <>
                              <div style={{fontSize:".65rem",fontWeight:700,letterSpacing:"1.2px",textTransform:"uppercase",color:"#888",marginBottom:2}}>Program</div>
                              <div style={{fontSize:"1rem",fontStyle:"normal",color:"#333"}}>{labInfo.experimentTitle}</div>
                            </>
                          )}
                        </div>
                      </div>

                      <div style={{marginBottom:12}}>
                        <div style={{fontSize:".9rem",fontWeight:700,letterSpacing:"1.2px",textTransform:"uppercase",color:"#888",marginBottom:6}}>Aim:</div>
                        <div style={{minHeight:"80px"}}></div>
                      </div>

                      {qaList.filter(qa => selectedQuestions.has(qa.id)).map((qa, idx) => (
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

                      <div style={{marginBottom:18}}>
                        <div style={{textAlign:"right",marginBottom:12}}>
                          <div style={{fontSize:".65rem",fontWeight:700,letterSpacing:"1.2px",textTransform:"uppercase",color:"#888",marginBottom:6}}>Total Score</div>
                          <div style={{fontSize:"2rem",fontWeight:700,fontFamily:"'Source Serif 4'"}}>{totalObtained}/{totalMax}</div>
                        </div>
                      </div>
                      <div className="pr-rubric" data-pdf-keep-together="true" style={{textAlign:"center",marginBottom:18,background:"#fff",position:"relative",zIndex:2,padding:"16px",boxShadow:"0 0 0 20px #fff",outline:"20px solid #fff"}}>
                        <img src="/Rubrics.png" alt="Marks Rubric" style={{maxWidth:"100%",height:"auto",margin:"0 auto",display:"block",opacity:1,backgroundColor:"#fff",position:"relative",zIndex:3}} />
                      </div>
                      <div style={{marginBottom:18}}>
                        <div className="pr-result" data-pdf-keep-together="true" style={{border:"none",background:"transparent"}}>
                          <div className="section-hd">Result:</div>
                          <div className="pr-result-write pr-result-text" style={{border:"none",background:"transparent",minHeight:"90px"}}>{result || "\n\n\n"}</div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ══ FOOTER ══ */}
      <footer className="no-print" style={{background:"#2d3748",color:"#a0aec0",padding:"18px 24px",textAlign:"center",fontSize:".93rem",lineHeight:1.7,marginTop:40,position:"relative",zIndex:10}}>
        <div>© 2026 PSG Institute of Technology and Applied Research. All rights reserved.</div>
        <div style={{marginTop:4}}>Developed with care by{" "}
          <span title="Developed by Adhithya J" style={{cursor:"pointer",color:"#e2e8f0",fontWeight:600,borderBottom:"1px dashed #a0aec0"}}>SDC</span>
        </div>
      </footer>
    </div>
  );
}
