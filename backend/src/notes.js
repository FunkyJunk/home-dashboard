import fs from "fs";
import path from "path";

// Local-only storage for the Scratch Pad - there is no supported way to
// sync with Google Keep from here. Keep's API (keep.googleapis.com) only
// works for Google Workspace accounts with domain-wide delegation; it has
// no OAuth flow for a regular personal Google account at all, unlike
// Calendar/Gmail/Tasks which at least partially work. Confirmed against
// Google's own docs before building this - not a bug, just not offered.
const DATA_DIR = process.env.RECEIPTS_DATA_DIR || "/app/data";
fs.mkdirSync(DATA_DIR, { recursive: true });
const NOTES_FILE = path.join(DATA_DIR, "notes.json");

function loadNotes() {
  try {
    return JSON.parse(fs.readFileSync(NOTES_FILE, "utf8"));
  } catch {
    return [];
  }
}
function saveNotes(notes) {
  fs.writeFileSync(NOTES_FILE, JSON.stringify(notes, null, 2));
}

export function getNotes() {
  return loadNotes().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function createNote({ text }) {
  const notes = loadNotes();
  const note = {
    id: "note" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
    text: text || "",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  notes.push(note);
  saveNotes(notes);
  return note;
}

export function updateNote(id, { text }) {
  const notes = loadNotes();
  const note = notes.find((n) => n.id === id);
  if (!note) throw new Error("note not found");
  note.text = text;
  note.updatedAt = new Date().toISOString();
  saveNotes(notes);
  return note;
}

export function deleteNote(id) {
  const notes = loadNotes().filter((n) => n.id !== id);
  saveNotes(notes);
}
