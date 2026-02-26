# Lab Record Generator — PSG iTech

## Folder Structure

```
lab-record-app/
├── frontend/          ← React + Vite (runs on port 5173)
│   ├── src/
│   │   ├── main.jsx
│   │   ├── App.jsx
│   │   └── LabRecordApp.jsx   ← Main component (all UI logic)
│   ├── index.html
│   ├── vite.config.js
│   └── package.json
│
├── backend/           ← Express API (runs on port 3001)
│   ├── server.js
│   └── package.json
│
└── README.md
```

---

## Setup & Run

### 1. Frontend

```bash
cd frontend
npm install
npm run dev
```
Opens at → http://localhost:5173

---

### 2. Backend (optional — for saving records)

Open a second terminal:

```bash
cd backend
npm install
npm run dev
```
Runs at → http://localhost:3001

---

## Backend API Endpoints

| Method | Endpoint            | Description              |
|--------|---------------------|--------------------------|
| GET    | /api/health         | Check if server is alive |
| POST   | /api/records/save   | Save a lab record        |
| GET    | /api/records        | List all saved records   |
| GET    | /api/records/:id    | Get one record by ID     |
| DELETE | /api/records/:id    | Delete a record          |

---

## Notes

- The frontend works **completely standalone** — no backend needed for PDF parsing, marks entry, or downloading PDF.
- The backend is for **optional features** like saving records to a database in future.
- PDF parsing happens 100% in the browser using PDF.js (no file is uploaded anywhere).
