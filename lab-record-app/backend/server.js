const express = require('express')
const cors    = require('cors')
const app     = express()
const PORT    = 3001

app.use(cors({ origin: 'http://localhost:5173' }))
app.use(express.json())

// ── Health check ─────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'Lab Record API is running' })
})

// ── Save a lab record (example: store in memory / extend to DB) ──
const savedRecords = []

app.post('/api/records/save', (req, res) => {
  const { studentInfo, labInfo, questions, rubric, result } = req.body
  if (!studentInfo || !labInfo) {
    return res.status(400).json({ error: 'Missing required fields' })
  }
  const record = {
    id:        Date.now().toString(),
    savedAt:   new Date().toISOString(),
    studentInfo,
    labInfo,
    questions,
    rubric,
    result,
  }
  savedRecords.push(record)
  res.json({ success: true, id: record.id, message: 'Record saved successfully' })
})

// ── Get all saved records ────────────────────────────────────────
app.get('/api/records', (req, res) => {
  res.json({ records: savedRecords, total: savedRecords.length })
})

// ── Get a single record by ID ────────────────────────────────────
app.get('/api/records/:id', (req, res) => {
  const record = savedRecords.find(r => r.id === req.params.id)
  if (!record) return res.status(404).json({ error: 'Record not found' })
  res.json(record)
})

// ── Delete a record ──────────────────────────────────────────────
app.delete('/api/records/:id', (req, res) => {
  const idx = savedRecords.findIndex(r => r.id === req.params.id)
  if (idx === -1) return res.status(404).json({ error: 'Record not found' })
  savedRecords.splice(idx, 1)
  res.json({ success: true, message: 'Record deleted' })
})

app.listen(PORT, () => {
  console.log(`\n  Lab Record API running at http://localhost:${PORT}`)
  console.log(`  Health check: http://localhost:${PORT}/api/health\n`)
})
