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
    } else {
      // Extract only digits from the register number
      const digitsOnly = studentInfo.rollNo.replace(/\D/g, "");
      // If the extracted digits are not exactly 12, clear it (user will enter manually)
      if (digitsOnly.length !== 12) {
        studentInfo.rollNo = "";
      } else {
        studentInfo.rollNo = digitsOnly;
      }
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
    
    // Explicit "Question N" or "Problem N" headers are always question starts
    if (/^question\s*\d+/i.test(line) || /^problem\s*\d+/i.test(line)) return true;
    
    // For numbered lines like "1.", "2.", etc.
    const m = line.match(/^(\d{1,2})\.(.*)$/);
    if (!m) return false;

    const rest = (m[2] || "").trim();
    
    // If the line is "1." or "1. Problem Statement" alone, likely a question
    if (!rest || /^problem\s*statement\b/i.test(rest)) return true;

    const nl = (nextLine || "").trim();
    
    // Check only the next 1-2 lines (not 6) for "problem statement"
    // This is more conservative - "Problem Statement" should come very soon after the number
    if (/^problem\s*statement\b/i.test(nl)) return true;
    const line2After = (lookaheadLines && lookaheadLines[1] || "").trim();
    if (/^problem\s*statement\b/i.test(line2After)) return true;

    // Only if the next line itself starts with these keywords, consider it a question
    // Don't look ahead 6 lines - that's too broad
    if (/^input\s*format\b/i.test(nl) || /^output\s*format\b/i.test(nl) || /^sample\s*test\s*case\b/i.test(nl)) return true;
    if (/^status\s*:/i.test(nl) || /^marks\s*:/i.test(nl)) return true;
    
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
    
    // Filter out CSV data rows and CSV file headers
    const isCSVDataRow = (line) => {
      const trimmed = line.trim();
      
      // Skip CSV filenames like "data.csv", "data1.csv", "main.py", etc.
      if (/\.(csv|py|txt|json)$/i.test(trimmed)) return true;
      
      // Skip CSV headers like "x,y" or "age,sex,cp,trestbps,chol,..."
      if (/^[a-z_]+(?:,[a-z_\s]+)+$/i.test(trimmed) && trimmed.split(',').length >= 2) {
        const parts = trimmed.split(',');
        // If all parts are short words (< 20 chars each), likely a CSV header
        if (parts.every(p => p.trim().length < 20 && !/^\d/.test(p.trim()))) {
          return true;
        }
      }
      
      // Skip CSV data rows - lines that are mostly numbers and commas
      const separators = (trimmed.match(/,/g) || []).length;
      if (separators === 0) return false; // Not CSV if no commas
      
      // Check if line is mostly numeric data with commas
      const parts = trimmed.split(',');
      if (parts.length > 3) {
        const numericParts = parts.filter(p => /^[\d.\-:]+$/.test(p.trim())).length;
        const ratio = numericParts / parts.length;
        if (ratio > 0.7) return true; // 70% numeric = CSV data row
      }
      
      return false;
    };
    
    const filteredClForPS = cl.slice(bodyStart, bodyEnd).filter(l => !isCSVDataRow(l.trim()));
    
    // Find the end of actual problem statement (stop before Answer section or CSV filename)
    let psEndIdx = filteredClForPS.length;
    for (let i = 0; i < filteredClForPS.length; i++) {
      const line = filteredClForPS[i].trim();
      if (/^answer\b|^main\.py\b|^data\d*\.csv\b/i.test(line)) {
        psEndIdx = i;
        break;
      }
    }
    
    const problemStatement = dropTrailingMeta(filteredClForPS.slice(0, psEndIdx)).join("\n").trim();
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

  // Simulate heavy background processing with random delay (0.5-3s, ease-out to 3s)
  const getRandomDelay = () => {
    const random = Math.random();
    // 80% chance for 0.5s, 20% chance for 0.5-3s with ease-out
    if (random < 0.8) return 500;
    const t = (random - 0.8) / 0.2; // 0 to 1
    const easeOut = 1 - Math.pow(1 - t, 3); // cubic ease-out
    return 500 + easeOut * 2500; // 500ms to 3s
  };

  const addProcessingDelay = async () => {
    const delay = getRandomDelay();
    return new Promise(resolve => setTimeout(resolve, delay));
  };

  const [parsedStudent, setParsedStudent] = useState(null);
  const [labInfo, setLabInfo]   = useState({ institution:"", labName:"", recordName:"", weekNo:"", experimentTitle:"", date:"", totalMarks:"" });
  const [qaList, setQaList]     = useState([]);
  const [selectedQuestions, setSelectedQuestions] = useState(new Set());
  const [rubric, setRubric]     = useState(rubricDefaults.map(r => ({ ...r })));
  const [includeTestCases, setIncludeTestCases] = useState(false);
  const [aim, setAim]           = useState("");
  const [result, setResult]     = useState("");
  const [manualRollNo, setManualRollNo] = useState("");
  const [showValidation, setShowValidation] = useState(false);

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
      await addProcessingDelay();
      const text = await extractTextFromPDF(pdfFile);
      const { studentInfo: si, labInfo: li, questions } = parsePSGLabPDF(text);
      setParsedStudent(si);
      setLabInfo({...li, recordName: li.labName});
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
  const hasValid12DigitRollNo = si.rollNo && /^\d{12}$/.test(si.rollNo);
  const effectiveRollNo = manualRollNo || si.rollNo || "";
  const rollNoIsValid = /^\d{12}$/.test(effectiveRollNo.replace(/\s/g, ""));
  const totalObtained  = qaList.reduce((s, q) => s + (parseFloat(q.marksObtained) || 0), 0);
  const totalMax       = qaList.reduce((s, q) => s + (parseFloat(q.maxMarks) || 0), 0);
  const rubricObtained = rubric.reduce((s, r) => s + (parseFloat(r.obtained) || 0), 0);
  const rubricMax      = rubric.reduce((s, r) => s + (parseFloat(r.maxMarks) || 0), 0);

  const resetAll = () => {
    setStep(0); setPdfFile(null); setQaList([]); setAim(""); setResult("");
    setParsedStudent(null);
    setManualRollNo("");
    setRubric(rubricDefaults.map(r => ({ ...r })));
    setLabInfo({ institution:"", labName:"", recordName:"", weekNo:"", experimentTitle:"", date:"", totalMarks:"" });
    setIncludeTestCases(false);
    setSelectedQuestions(new Set());
    setShowValidation(false);
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

      // Helper: check if a canvas region is essentially blank (all white/near-white)
      const isBlankRegion = (ctx, y, h, w) => {
        const sampleH = Math.min(Math.ceil(h), ctx.canvas.height - Math.floor(y));
        if (sampleH <= 0) return true;
        const data = ctx.getImageData(0, Math.floor(y), w, sampleH).data;
        let darkPixels = 0;
        for (let i = 0; i < data.length; i += 4) {
          const lum = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
          if (lum < 240) darkPixels++;
        }
        // If less than 0.1% of pixels are dark, consider it blank
        const totalPixels = (w * sampleH);
        return (darkPixels / totalPixels) < 0.001;
      };

      let srcY = 0;
      const usableHPx = (usableH / ratio) * scaleFactor;
      while (srcY < canvas.height - 1) {
        const remainingPx = canvas.height - srcY;

        // Skip if only a tiny sliver remains (avoids blank trailing page)
        if (remainingPx < 50) break;

        // Skip if remaining region is blank whitespace
        if (isBlankRegion(mainCtx, srcY, remainingPx, canvas.width)) break;

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
        // Sort zones by top position so we always process top-most first
        const sortedZones = [...protectedZones].sort((a, b) => a.top - b.top);
        let moved = true;
        let iterations = 0;
        while (moved && iterations < 10) {
          moved = false;
          iterations++;
          for (const zone of sortedZones) {
            if (breakY > zone.top + 2 && breakY < zone.bottom - 2) {
              // Only move break before the zone if the zone fits on a single page
              if ((zone.bottom - zone.top) <= usableHPx) {
                breakY = Math.max(srcY + 80, zone.top - 4);
                moved = true;
              }
              break;
            }
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
        // Only add a new page if meaningful (non-blank) content remains
        const nextRemaining = canvas.height - srcY;
        if (nextRemaining > 50 && !isBlankRegion(mainCtx, srcY, nextRemaining, canvas.width)) {
          doc.addPage();
        }
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
    <div style={{ fontFamily:"Calibri, 'Segoe UI', Arial, sans-serif", minHeight:"100vh", background:"#f4f1ec", color:"#1c1c1c", position:"relative", display:"flex", flexDirection:"column" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Source+Serif+4:ital,wght@0,400;0,600;0,700;1,400&family=DM+Sans:wght@300;400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap');
        *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
        .bg-image-overlay{position:fixed;top:0;left:0;width:100%;height:100%;background:url('/image.png') center/cover no-repeat;opacity:0.5;z-index:0;pointer-events:none}
        .wrap{max-width:900px;margin:0 auto;padding:32px 24px 80px;position:relative;z-index:1}
        .app-header{display:flex;align-items:flex-end;justify-content:space-between;padding-bottom:20px;border-bottom:2.5px solid #1c1c1c;margin-bottom:16px}
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
        .dl-overlay{position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;z-index:9999}
        .dl-card{background:#fff;padding:40px 32px;border-radius:8px;text-align:center;box-shadow:0 8px 32px rgba(0,0,0,0.3)}
        .dl-spinner{display:inline-block;width:44px;height:44px;border:4px solid #e0e0e0;border-top-color:#1c1c1c;border-radius:50%;animation:spin .8s linear infinite;margin-bottom:20px}
        .dl-msg{font-size:1.2rem;font-weight:600;color:#1c1c1c;margin-bottom:8px;font-family:'Source Serif 4',Georgia,serif}
        .inp-group{display:flex;flex-direction:column;gap:5px}
        .inp-group label{font-size:.77rem;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#888}
        .inp-group input,.inp-group textarea{border:1.5px solid #d4cec6;padding:9px 12px;font-size:1.025rem;font-family:'DM Sans',sans-serif;background:#faf8f5;color:#1c1c1c;outline:none;width:100%;transition:border-color .15s}
        .inp-group input:focus,.inp-group textarea:focus{border-color:#1c1c1c;background:#fff}
        .inp-group .required-star{color:#c0392b;margin-left:3px;font-size:.9rem}
        .inp-group.invalid input,.inp-group.invalid textarea{border-color:#c0392b;background:#fef5f5}
        .validation-msg{color:#c0392b;font-size:.82rem;margin-top:4px;font-weight:500}
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

        /* ══ Responsive Form Grid ══ */
        .form-grid{display:grid;grid-template-columns:1fr 1fr;gap:16}
        @media(max-width:768px){.form-grid{grid-template-columns:1fr;gap:12}}
        @media(max-width:480px){.form-grid{gap:10}}

        /* ══ Responsive PDF Grid ══ */
        .pdf-grid-2col{display:grid;grid-template-columns:1fr 1fr;gap:12;padding:8px 0;border-bottom:1px solid #bbb;margin-bottom:12}
        @media(max-width:768px){.pdf-grid-2col{grid-template-columns:1fr;gap:8}}

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
        .pr-content-wrapper{position:relative;z-index:2;flex:1;overflow:visible;font-size:12pt;line-height:1.5;font-family:Calibri, 'Segoe UI', Arial, sans-serif;color:#000}
        .pr-content-wrapper *{color:#000 !important;font-family:Calibri, 'Segoe UI', Arial, sans-serif !important;font-size:12pt}
        .pr-header{text-align:center;padding:8px 0 10px;border-bottom:2px solid #1c1c1c;margin-bottom:12px}
        .pr-inst{font-family:Calibri, 'Segoe UI', Arial, sans-serif;font-size:12pt;font-weight:700;letter-spacing:.2px;margin-bottom:6px}
        .pr-lab-name{font-family:Calibri, 'Segoe UI', Arial, sans-serif;font-size:12pt;font-weight:700;letter-spacing:.2px;margin-bottom:6px}
        .pr-subtitle{font-size:12pt;font-weight:700;letter-spacing:2.5px;text-transform:uppercase;color:#666;margin:8px 0 4px}
        .pr-lab{font-family:Calibri, 'Segoe UI', Arial, sans-serif;font-size:12pt;font-weight:700;font-style:normal;color:#333;margin-top:6px}
        .info-strip{display:grid;grid-template-columns:repeat(4,1fr);border-bottom:1px solid #bbb;margin-bottom:10px}
        .info-strip.row2{grid-template-columns:1.8fr 1.2fr 1fr 1fr;border-bottom:1px solid #bbb;margin-bottom:10px}
        .info-cell{padding:8px 10px;border-right:1px solid #bbb}
        .info-cell:last-child{border-right:none}
        .ic-label{font-size:12pt;font-weight:400;letter-spacing:1.2px;text-transform:uppercase;color:#888;margin-bottom:2px;font-family:Calibri, 'Segoe UI', Arial, sans-serif}
        .ic-value{font-size:12pt;color:#1c1c1c;font-weight:700;font-family:Calibri, 'Segoe UI', Arial, sans-serif;word-break:break-all}
        .exp-strip{border-bottom:1px solid #bbb;padding:14px 24px;display:flex;justify-content:space-between;align-items:flex-start}
        .exp-meta-label{font-size:12pt;font-weight:400;letter-spacing:1.5px;text-transform:uppercase;color:#999;margin-bottom:3px;font-family:Calibri, 'Segoe UI', Arial, sans-serif}
        .exp-meta-val{font-family:Calibri, 'Segoe UI', Arial, sans-serif;font-size:12pt;font-weight:700}
        .exp-prog-label{font-size:12pt;font-weight:400;letter-spacing:1.5px;text-transform:uppercase;color:#999;margin-top:10px;margin-bottom:3px;font-family:Calibri, 'Segoe UI', Arial, sans-serif}
        .exp-prog-val{font-family:Calibri, 'Segoe UI', Arial, sans-serif;font-size:12pt;font-style:italic;color:#333}
        .exp-right-block{text-align:right;padding-left:24px;border-left:1px solid #bbb}
        .score-meta-label{font-size:12pt;font-weight:400;letter-spacing:1.5px;text-transform:uppercase;color:#999;margin-bottom:4px;font-family:Calibri, 'Segoe UI', Arial, sans-serif}
        .score-num{font-family:Calibri, 'Segoe UI', Arial, sans-serif;font-size:12pt;font-weight:700;line-height:1}
        .pr-content{padding:0;background:#fff;flex:1;overflow:visible;font-size:12pt;line-height:1.5}
        .pr-qa{border:none;margin:0 0 14px 0;padding:0;font-size:12pt;page-break-inside:avoid;break-inside:avoid}
        .pr-qa-head{background:transparent;border-bottom:1px solid #bbb;padding:8px 0;display:flex;align-items:flex-end;justify-content:space-between;font-weight:600;break-after:avoid;page-break-after:avoid}
        .pr-qnum{font-family:Calibri, 'Segoe UI', Arial, sans-serif;font-weight:700;font-size:12pt;color:#1c1c1c}
        .pr-qa-right{display:flex;align-items:center;gap:14px;font-size:12pt}
        .pr-stag{font-size:12pt;font-weight:700;letter-spacing:1px;text-transform:uppercase;padding:3px 10px;border:1px solid #888;color:#333;background:transparent}
        .pr-mk{font-family:'IBM Plex Mono',monospace;font-size:12pt;font-weight:600}
        .pr-qa-body{padding:10px 0 0 0;break-inside:auto;page-break-inside:auto}
        .ps-label{font-size:12pt;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#000;margin-bottom:8px;page-break-inside:avoid;break-inside:avoid}
        .ps-text{font-family:'IBM Plex Mono',monospace;font-size:12pt;line-height:1;color:#000;white-space:pre-wrap;background:transparent;margin:6px 0 0 0;padding:0;border:none;page-break-inside:avoid;break-inside:avoid}
        .pr-result{margin:18px 0;padding:0;page-break-inside:avoid;break-inside:avoid}
        .section-hd{font-size:12pt;font-weight:400;letter-spacing:2.2px;text-transform:uppercase;color:#555;margin-bottom:10px;font-family:Calibri, 'Segoe UI', Arial, sans-serif}
        .pr-result-text{font-family:Calibri, 'Segoe UI', Arial, sans-serif;font-size:12pt;line-height:1.4;color:#000}
        .pr-result-write{min-height:90px;border:1px solid #1c1c1c;padding:10px 12px;white-space:pre-wrap;break-inside:avoid;page-break-inside:avoid}
        .pr-rubric{margin-bottom:0;page-break-inside:avoid;break-inside:avoid}
        .pr-rubric, .pr-rubric *{font-size:12pt}
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

        /* ══ MOBILE RESPONSIVE ══ */
        @media(max-width:768px){
          .wrap{padding:20px 16px 60px;max-width:100%}
          .app-header{flex-direction:column;align-items:flex-start;gap:12px;padding-bottom:16px;margin-bottom:12px}
          .app-header h1{font-size:1.5rem}
          .app-header .sub{font-size:.7rem}
          .badge-inst{font-size:.65rem;padding:4px 12px}
          .steps{margin-bottom:20px;flex-wrap:wrap;border:none}
          .step-item{border-right:none;border-bottom:1.5px solid #1c1c1c;padding:8px 0;font-size:.7rem;flex:1}
          .step-item:last-child{border-bottom:none}
          .step-num{width:18px;height:18px;font-size:.7rem}
          .card{padding:18px 16px;margin-bottom:16px;border:1px solid #ddd7ce}
          .card-title{font-size:1rem;margin-bottom:16px;gap:8px}
          .upload-zone{padding:32px 16px}
          .upload-icon{font-size:2.5rem;margin-bottom:8px}
          .upload-title{font-size:1.05rem}
          .upload-hint{font-size:.85rem}
          .file-pill{padding:8px 12px;gap:8px}
          .file-name{font-size:.9rem}
          .file-size{font-size:.8rem}
          .error-box{font-size:.9rem;padding:10px 12px}
          .inp-group label{font-size:.7rem}
          .inp-group input,.inp-group textarea{padding:8px 10px;font-size:.95rem}
          .inp-group textarea{min-height:70px}
          .validation-msg{font-size:.75rem}
          .btn{padding:10px 16px;font-size:.75rem;letter-spacing:1px}
          .btn-row{flex-direction:column;margin-top:18px;gap:10px}
          .btn-row button{width:100%}
          .btn-row>div{width:100%;display:flex;flex-direction:column;gap:10px}
          .btn-row>div>button{width:100%}
          .marks-display{font-size:.95rem;padding:4px 8px}
          .qa-head{padding:10px 12px;gap:8px;flex-wrap:wrap}
          .qa-num{font-size:1rem}
          .qa-right{flex-wrap:wrap;width:100%;justify-content:space-between;gap:8px}
          .qa-ps{padding:12px;font-size:.95rem;line-height:1.6}
          .stag{font-size:.65rem;padding:2px 8px}
          .pr-page{width:100%;min-height:auto;padding:8mm 12mm 12mm;box-shadow:0 0 0 1px #ccc;margin-bottom:16px}
          .pr-page::before{width:60%;height:60%;opacity:0.1}
          .pr-inst,.pr-lab-name,.pr-lab{font-size:11pt}
          .pr-subtitle{font-size:11pt}
          .info-strip{grid-template-columns:repeat(2,1fr);margin-bottom:8px}
          .info-strip.row2{grid-template-columns:repeat(2,1fr)}
          .info-cell{padding:6px 8px}
          .ic-label{font-size:10pt}
          .ic-value{font-size:11pt}
          .pr-header{padding:6px 0 8px;margin-bottom:8px}
          .exp-strip{padding:10px 16px;flex-direction:column;gap:8px}
          .exp-right-block{text-align:left;padding-left:0;border-left:none}
          .score-meta-label{font-size:10pt}
          .qa-item{margin-bottom:12px}
          .rtable{font-size:.9rem}
          .rtable th{padding:8px 10px;font-size:.65rem}
          .rtable td{padding:8px 10px}
          .rtable input[type=number]{width:60px;font-size:.85rem}
        }

        @media(max-width:480px){
          .wrap{padding:16px 12px 50px}
          .app-header{flex-direction:column;align-items:stretch}
          .app-header h1{font-size:1.3rem;letter-spacing:0}
          .app-header img{height:56px;width:56px}
          .app-header .sub{font-size:.65rem}
          .badge-inst{font-size:.6rem;padding:3px 10px}
          .steps{display:grid;grid-template-columns:1fr 1fr;gap:0;margin-bottom:16px}
          .step-item{border-right:none;border-bottom:1.5px solid #1c1c1c;border-right:1.5px solid #1c1c1c;padding:6px;font-size:.6rem;text-align:center}
          .step-item:nth-child(1),.step-item:nth-child(3){border-right:1.5px solid #1c1c1c}
          .step-item:nth-child(3),.step-item:nth-child(4){border-bottom:none}
          .step-num{width:16px;height:16px;font-size:.6rem}
          .card{padding:14px 12px;margin-bottom:12px}
          .card-title{font-size:.95rem;margin-bottom:12px;flex-direction:column;gap:6px}
          .card-title::after{display:none}
          .upload-zone{padding:24px 12px}
          .upload-icon{font-size:2rem;margin-bottom:6px}
          .upload-title{font-size:.95rem}
          .upload-hint{font-size:.8rem}
          .file-pill{padding:6px 10px;font-size:.85rem}
          .file-name{font-size:.8rem}
          .file-size{font-size:.75rem}
          .error-box{font-size:.8rem;padding:8px 10px}
          .inp-group label{font-size:.65rem;letter-spacing:1px}
          .inp-group input,.inp-group textarea{padding:6px 10px;font-size:.9rem}
          .inp-group textarea{min-height:60px}
          .validation-msg{font-size:.7rem}
          .btn{padding:8px 12px;font-size:.7rem;letter-spacing:.5px}
          .marks-display{font-size:.85rem;padding:3px 6px}
          .qa-head{padding:8px 10px;gap:6px}
          .qa-num{font-size:.95rem}
          .qa-right{gap:6px}
          .qa-ps{padding:10px;font-size:.9rem;line-height:1.5}
          .stag{font-size:.6rem;padding:1px 6px;letter-spacing:.5px}
          .pr-page{width:100%;padding:6mm 10mm;box-shadow:0 0 0 1px #ccc;margin-bottom:12px}
          .pr-inst,.pr-lab-name,.pr-lab{font-size:10pt}
          .info-strip{grid-template-columns:1fr;margin-bottom:6px;gap:0}
          .info-strip.row2{grid-template-columns:1fr}
          .info-cell{padding:4px 6px;border-right:none;border-bottom:1px solid #bbb}
          .info-cell:last-child{border-bottom:none}
          .ic-label{font-size:9pt;letter-spacing:.5px}
          .ic-value{font-size:10pt}
          .pr-header{padding:4px 0 6px;margin-bottom:6px;font-size:10pt}
          .exp-strip{padding:8px 12px;gap:6px}
          .score-meta-label{font-size:9pt}
          .pr-subtitle{font-size:10pt;letter-spacing:1px}
          .qa-item{margin-bottom:10px}
          .rtable{font-size:.8rem}
          .rtable th{padding:6px 8px;font-size:.6rem}
          .rtable td{padding:6px 8px}
          .rtable input[type=number]{width:50px;font-size:.8rem}
          .test-case-check label{font-size:.95rem}
          .test-case-item{font-size:.9rem}
          .dl-sub{font-size:.85rem}

          /* ══ Rubric responsive ══ */
          div[style*="flex"][style*="gap:24"][style*="alignItems"]>div[style*="flex"][style*="50%"]{flex:0 0 100% !important;margin-left:0 !important;margin-bottom:12px}
          div[style*="flex"][style*="gap:24"][style*="alignItems"]>div[style*="flex:1"]{flex:1 !important}
        }

        @media(max-width:360px){
          .wrap{padding:12px 10px 40px}
          .app-header{gap:8px}
          .app-header h1{font-size:1.1rem}
          .app-header img{height:48px;width:48px}
          .steps{grid-template-columns:1fr 1fr;margin-bottom:12px}
          .step-item{padding:4px;font-size:.55rem}
          .step-num{width:14px;height:14px;font-size:.55rem}
          .card{padding:12px 10px;margin-bottom:10px}
          .card-title{font-size:.9rem;margin-bottom:10px}
          .inp-group input,.inp-group textarea{font-size:.85rem;padding:5px 8px}
          .btn{padding:7px 10px;font-size:.65rem}
          .pr-page{padding:4mm 8mm;font-size:9pt}
        }
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
              <div className="form-grid">
                <div className={`inp-group${showValidation && !labInfo.weekNo.trim() ? ' invalid' : ''}`}>
                  <label>Week (e.g. Week 1)<span className="required-star">*</span></label>
                  <input type="text" value={labInfo.weekNo} onChange={e => updateLab("weekNo", e.target.value)} placeholder="Week 1" />
                  {showValidation && !labInfo.weekNo.trim() && <div className="validation-msg">Week is required</div>}
                </div>
                <div className={`inp-group${showValidation && !labInfo.experimentTitle.trim() ? ' invalid' : ''}`}>
                  <label>Program / Experiment Name<span className="required-star">*</span></label>
                  <input type="text" value={labInfo.experimentTitle} onChange={e => updateLab("experimentTitle", e.target.value)} placeholder="e.g. COD" />
                  {showValidation && !labInfo.experimentTitle.trim() && <div className="validation-msg">Program / Experiment Name is required</div>}
                </div>
                <div className={`inp-group${showValidation && !effectiveRollNo.trim() ? ' invalid' : ''} ${showValidation && effectiveRollNo.trim() && !rollNoIsValid ? ' invalid' : ''}`}>
                  <label>Register Number<span className="required-star">*</span> {hasValid12DigitRollNo ? "(from PDF - 12 digits)" : "(enter 12 digits)"}</label>
                  {hasValid12DigitRollNo ? (
                    <input type="text" value={manualRollNo} readOnly style={{backgroundColor:"#f0f0f0",cursor:"not-allowed",color:"#555"}} />
                  ) : (
                    <input type="text" value={manualRollNo} onChange={e => {
                      // Allow only digits
                      const digitsOnly = e.target.value.replace(/\D/g, "");
                      setManualRollNo(digitsOnly.slice(0, 12));
                    }} placeholder="715524104007 (12 digits only)" maxLength="12" />
                  )}
                  {showValidation && !effectiveRollNo.trim() && <div className="validation-msg">Register Number is required</div>}
                  {showValidation && effectiveRollNo.trim() && !rollNoIsValid && <div className="validation-msg">Register Number must be exactly 12 digits with no letters or special characters</div>}
                </div>
                <div className={`inp-group${showValidation && !labInfo.recordName.trim() ? ' invalid' : ''}`}>
                  <label>Lab Record Name<span className="required-star">*</span></label>
                  <input type="text" value={labInfo.recordName} onChange={e => updateLab("recordName", e.target.value)} placeholder="e.g. PYTHON Lab, Java Programming Lab" />
                  {showValidation && !labInfo.recordName.trim() && <div className="validation-msg">Lab Record Name is required</div>}
                </div>
              </div>
              <div style={{display:"flex",justifyContent:"flex-end",marginTop:16,gap:8}}>
                <button 
                  className="btn" 
                  disabled={!labInfo.weekNo.trim() || !labInfo.experimentTitle.trim() || !effectiveRollNo.trim() || !labInfo.recordName.trim() || !rollNoIsValid || qaList.length === 0 || downloading}
                  onClick={handleDownloadPDF}
                  title="Download PDF"
                  style={{padding:"8px 12px",fontSize:"1.3rem",display:"flex",alignItems:"center",justifyContent:"center"}}
                >
                  <i className="bi bi-download"></i>
                </button>
              </div>
            </div>

            <div className="card">
              <div className="card-title">
                <span>Section A — Questions &amp; Marks</span>
              </div>
              {qaList.length === 0 && <p style={{ fontSize:"1rem", color:"#999" }}>No questions detected.</p>}
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
                <span style={{ fontSize:".93rem", color:"#888" }}>Total marks:</span>
                <strong style={{ fontFamily:"'IBM Plex Mono',monospace", fontSize:"1.15rem" }}>{totalObtained} / {totalMax}</strong>
              </div>
            </div>

            <div className="card">
              <div className="card-title">Section B — Aim</div>
              <div className="inp-group">
                <label>Aim</label>
                <textarea value={aim} onChange={e => setAim(e.target.value)}
                  placeholder="e.g. To understand and implement basic Python programming concepts including loops, conditionals, and functions."
                  style={{ minHeight:96 }} />
              </div>
            </div>

            <div className="card">
              <div className="card-title">Section C — Result</div>
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
                <button className="btn btn-filled" onClick={() => {
                  const isValid = labInfo.weekNo.trim() && labInfo.experimentTitle.trim() && manualRollNo.trim() && /^\d{12}$/.test(manualRollNo) && labInfo.recordName.trim();
                  if (!isValid) { setShowValidation(true); return; }
                  setShowValidation(false);
                  handleDownloadPDF();
                }} disabled={downloading}>
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
                        <div className="pr-lab-name">Laboratory Record</div>
                        <div className="pr-lab">{labInfo.recordName || labInfo.labName || "PYTHON Lab"}</div>
                      </div>

                      <div className="info-strip">
                        <div className="info-cell"><div className="ic-label">Student Name</div><div className="ic-value">{si.name || ""}</div></div>
                        <div className="info-cell"><div className="ic-label">Register No</div><div className="ic-value">{effectiveRollNo}</div></div>
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
                          <div style={{fontSize:"12pt",fontWeight:400,letterSpacing:"1.2px",textTransform:"uppercase",color:"#888",marginBottom:2}}>Week</div>
                          <div style={{fontSize:"12pt",fontWeight:700,fontFamily:"Calibri, 'Segoe UI', Arial, sans-serif",color:"#1c1c1c"}}>{labInfo.weekNo || "Week 1"}</div>
                        </div>
                        <div style={{textAlign:"right"}}>
                          {labInfo.experimentTitle && (
                            <>
                              <div style={{fontSize:"12pt",fontWeight:400,letterSpacing:"1.2px",textTransform:"uppercase",color:"#888",marginBottom:2}}>Program</div>
                              <div style={{fontSize:"12pt",fontWeight:700,fontStyle:"normal",color:"#333"}}>{labInfo.experimentTitle}</div>
                            </>
                          )}
                        </div>
                      </div>

                      <div style={{marginBottom:12}}>
                        <div style={{fontSize:"12pt",fontWeight:400,letterSpacing:"1.2px",textTransform:"uppercase",color:"#888",marginBottom:6,fontFamily:"Calibri, 'Segoe UI', Arial, sans-serif"}}>Aim:</div>
                        <div style={{minHeight:"80px",whiteSpace:"pre-wrap",lineHeight:1.6,fontSize:"12pt",fontFamily:"Calibri, 'Segoe UI', Arial, sans-serif"}}>{aim || "\n\n\n"}</div>
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

                      <div data-pdf-keep-together="true" style={{marginBottom:18, display:"flex", gap:24, alignItems:"flex-start", pageBreakInside:"avoid", breakInside:"avoid"}}>
                        <div className="pr-rubric" data-pdf-keep-together="true" style={{flex:"0 0 58%", marginLeft:32, background:"#fff",position:"relative",zIndex:2,padding:"16px",boxShadow:"0 0 0 20px #fff",outline:"20px solid #fff", pageBreakInside:"avoid", breakInside:"avoid"}}>
                          <img src="/Rubrics.png" alt="Marks Rubric" style={{maxWidth:"100%",height:"auto",display:"block",opacity:1,backgroundColor:"#fff",position:"relative",zIndex:3}} />
                        </div>
                        <div style={{textAlign:"right", flex:"1", pageBreakInside:"avoid", breakInside:"avoid"}}>
                          <div style={{fontSize:"12pt",fontWeight:700,letterSpacing:"1.2px",textTransform:"uppercase",color:"#888",marginBottom:6}}>Total Score</div>
                          <div style={{fontSize:"15pt",fontWeight:700,fontFamily:"Calibri, 'Segoe UI', Arial, sans-serif"}}>{totalObtained}/{totalMax}</div>
                        </div>
                      </div>
                      <div style={{marginBottom:18}}>
                        <div className="pr-result" data-pdf-keep-together="true" style={{border:"none",background:"transparent"}}>
                          <div className="section-hd">Result:</div>
                          <div className="pr-result-write pr-result-text" style={{border:"none",background:"transparent",minHeight:"20px",paddingBottom:"4px"}}>{result || ""}</div>
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
      <footer className="no-print" style={{background:"#2d3748",color:"#a0aec0",padding:"18px 24px",textAlign:"center",fontSize:".93rem",lineHeight:1.7,marginTop:"auto",position:"sticky",bottom:0,zIndex:10}}>
        <div>© 2026 PSG iTech. All rights reserved.</div>
        <div style={{marginTop:4}}>Developed with care by{" "}
          <span title="Developed by Adhithya J" style={{cursor:"pointer",color:"#e2e8f0",fontWeight:600,borderBottom:"1px dashed #a0aec0"}}>SDC</span>
        </div>
      </footer>
    </div>
  );
}
