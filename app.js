/**
 * SCRIPTURE NOTES — app.js  v4.0
 * Smart Bible linking:
 *   - Live book autocomplete as you type (partial match: "Joh" → John, "1 Co" → 1 Corinthians)
 *   - All verse formats recognised on blur/highlight:
 *       John 3:16  · John 3 16  · John 3 vs 16  · John 3 verse 16
 *       John 3/16  · John 3 - 16  · John 3:16-17  · John 3 vs 16 - 17
 *   - Suggestion popup tracks caret position, keyboard-navigable
 */
'use strict';

const DB_NAME    = 'ScriptureNotesDB';
const DB_VERSION = 4;
const STORE_NAME = 'notes';

const state = {
  bible: null, books: [],
  currentBook: 'John', currentChapter: 3, currentVerse: 1,
  db: null, saveTimer: null, activeTab: 'bible',
  activeNoteId: null,
  notes: [],
  // autocomplete state
  ac: {
    active: false,
    items: [],        // [{book, label}]
    index: -1,        // keyboard selection
    startOffset: 0,   // char offset in text node where trigger word started
    triggerNode: null // the text node being typed in
  }
};

const $ = id => document.getElementById(id);
let DOM = {};

/* ─── Utils ─────────────────────────────────────────────── */
function generateId() { return Date.now().toString(36) + Math.random().toString(36).slice(2,7); }

function escapeHtml(str) {
  return String(str)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function formatDate(ts) {
  const d = new Date(ts), now = new Date();
  const mins = Math.floor((now-d)/60000), hrs = Math.floor((now-d)/3600000), days = Math.floor((now-d)/86400000);
  if (mins < 1)  return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  if (hrs  < 24) return `${hrs}h ago`;
  if (days < 7)  return `${days}d ago`;
  return `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()}`;
}

/* ─── Toast ─────────────────────────────────────────────── */
let _toastTimer;
function showToast(msg, type='') {
  clearTimeout(_toastTimer);
  DOM.toast.textContent = msg;
  DOM.toast.className = `toast ${type}`;
  void DOM.toast.offsetWidth;
  DOM.toast.classList.add('show');
  _toastTimer = setTimeout(() => DOM.toast.classList.remove('show'), 2500);
}

/* ─── Modal ─────────────────────────────────────────────── */
function showConfirm(msg) {
  return new Promise(res => {
    DOM.modalMessage.textContent = msg;
    DOM.modalOverlay.classList.remove('hidden');
    const ok = () => { close(); res(true); };
    const no = () => { close(); res(false); };
    function close() {
      DOM.modalOverlay.classList.add('hidden');
      DOM.modalConfirm.removeEventListener('click', ok);
      DOM.modalCancel.removeEventListener('click', no);
    }
    DOM.modalConfirm.addEventListener('click', ok);
    DOM.modalCancel.addEventListener('click', no);
  });
}

/* ─── IndexedDB ─────────────────────────────────────────── */
function openDB() {
  return new Promise((res,rej) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (db.objectStoreNames.contains(STORE_NAME)) db.deleteObjectStore(STORE_NAME);
      const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      store.createIndex('timestamp','timestamp',{unique:false});
    };
    req.onsuccess = e => res(e.target.result);
    req.onerror   = e => rej(e.target.error);
  });
}
function dbPut(note) { return new Promise((res,rej) => { const r=state.db.transaction(STORE_NAME,'readwrite').objectStore(STORE_NAME).put(note); r.onsuccess=()=>res(); r.onerror=e=>rej(e.target.error); }); }
function dbDel(id)   { return new Promise((res,rej) => { const r=state.db.transaction(STORE_NAME,'readwrite').objectStore(STORE_NAME).delete(id); r.onsuccess=()=>res(); r.onerror=e=>rej(e.target.error); }); }
function dbAll()     { return new Promise((res,rej) => { const r=state.db.transaction(STORE_NAME,'readonly').objectStore(STORE_NAME).getAll(); r.onsuccess=e=>res((e.target.result||[]).sort((a,b)=>b.timestamp-a.timestamp)); r.onerror=e=>rej(e.target.error); }); }

/* ─── Note helpers ──────────────────────────────────────── */
function makeNote() { return { id: generateId(), title: '', content: '', timestamp: Date.now() }; }

function getNoteLabel(note) {
  if (note.title && note.title.trim()) return note.title.trim();
  const tmp = document.createElement('div');
  tmp.innerHTML = note.content;
  const text = (tmp.textContent || '').trim().split('\n')[0].trim();
  return text || 'Untitled';
}

/* ─── Open / Create ─────────────────────────────────────── */
async function openNote(id) {
  await triggerSave();
  const note = state.notes.find(n => n.id === id);
  if (!note) return;
  state.activeNoteId = note.id;
  DOM.noteTitle.innerHTML   = escapeHtml(note.title);
  DOM.notesEditor.innerHTML = note.content;
  applyVerseHighlights();
  updateSaveLabel('saved');
  showEditorView();
  refreshChips();
  DOM.noteTitle.focus();
  placeCaretAtEnd(DOM.noteTitle);
}

async function createAndOpenNote() {
  await triggerSave();
  const note = makeNote();
  state.notes.unshift(note);
  if (state.db) await dbPut(note);
  state.activeNoteId = note.id;
  DOM.noteTitle.textContent = '';
  DOM.notesEditor.innerHTML = '';
  updateSaveLabel('');
  showEditorView();
  refreshChips();
  DOM.noteTitle.focus();
  showToast('New note', 'success');
}

function placeCaretAtEnd(el) {
  try {
    const range = document.createRange(), sel = window.getSelection();
    range.selectNodeContents(el); range.collapse(false);
    sel.removeAllRanges(); sel.addRange(range);
  } catch(_) {}
}

/* ─── Save ──────────────────────────────────────────────── */
function scheduleAutoSave() {
  updateSaveLabel('unsaved');
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(triggerSave, 2000);
}

async function triggerSave() {
  clearTimeout(state.saveTimer);
  if (!state.activeNoteId || !state.db) return;
  const note = state.notes.find(n => n.id === state.activeNoteId);
  if (!note) return;
  updateSaveLabel('saving');
  try {
    note.title     = DOM.noteTitle.textContent.trim();
    note.content   = DOM.notesEditor.innerHTML;
    note.timestamp = Date.now();
    await dbPut(note);
    updateSaveLabel('saved');
    refreshChips();
  } catch(err) {
    console.error('Save error', err);
    updateSaveLabel('error');
  }
}

function updateSaveLabel(s) {
  const ind = DOM.saveIndicator, txt = DOM.saveText;
  if (s === 'saving')       { ind.className = 'save-indicator saving';  txt.textContent = 'Saving…'; }
  else if (s === 'unsaved') { ind.className = 'save-indicator unsaved'; txt.textContent = 'Unsaved'; }
  else if (s === 'saved')   { ind.className = 'save-indicator';         txt.textContent = 'Saved'; }
  else if (s === 'error')   { ind.className = 'save-indicator unsaved'; txt.textContent = 'Error'; }
  else                      { ind.className = 'save-indicator';         txt.textContent = ''; }
}

/* ─── Rich text formatting ──────────────────────────────── */
function applyFormat(cmd) {
  if (cmd === 'heading') {
    const sel = window.getSelection();
    if (!sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    let node = range.commonAncestorContainer;
    while (node && node !== DOM.notesEditor) {
      if (/^H[1-3]$/.test(node.nodeName)) {
        const frag = document.createDocumentFragment();
        while (node.firstChild) frag.appendChild(node.firstChild);
        node.parentNode.replaceChild(frag, node);
        scheduleAutoSave(); return;
      }
      node = node.parentNode;
    }
    document.execCommand('formatBlock', false, 'H2');
  } else {
    document.execCommand(cmd, false, null);
  }
  DOM.notesEditor.focus();
  updateToolbarState();
  scheduleAutoSave();
}

function updateToolbarState() {
  DOM.formatBtns.forEach(btn => {
    const cmd = btn.dataset.cmd;
    if (!cmd || cmd === 'heading' || cmd === 'removeFormat') return;
    btn.classList.toggle('active', document.queryCommandState(cmd));
  });
}

/* ══════════════════════════════════════════════════════════
   SMART BIBLE LINKING — two parts:
   1. Live autocomplete: partial book name → dropdown
   2. Smart highlight: all verse formats → clickable spans
══════════════════════════════════════════════════════════ */

/* ── Part 1: Autocomplete ────────────────────────────────

   Triggered when the user types in the notes editor.
   Looks at the word(s) immediately before the caret.
   If they fuzzy-match a Bible book, show a dropdown.

   Handles:
     "Joh"         → John
     "1 Co"        → 1 Corinthians
     "2Tim"        → 2 Timothy
     "gen"         → Genesis
     "rev"         → Revelation
   Dismissed by: Escape, selecting an item, clicking away,
                 or typing something that no longer matches.
*/

function getWordBeforeCaret() {
  const sel = window.getSelection();
  if (!sel.rangeCount) return null;
  const range = sel.getRangeAt(0);
  if (!range.collapsed) return null;
  const node = range.startContainer;
  if (node.nodeType !== Node.TEXT_NODE) return null;
  const text = node.textContent.slice(0, range.startOffset);
  // Capture: optional leading digit+"space", then up to 3 words (for "Song of Sol")
  // This handles "1 Co", "2 Tim", "Song of Sol", plain "John" etc.
  const m = text.match(/((?:\d\s+)?[A-Za-z]+(?:\s+[A-Za-z]+){0,2})$/);
  if (!m) return null;
  return {
    word: m[1],
    node,
    startOffset: range.startOffset - m[1].length
  };
}

// Common abbreviation aliases → canonical book name prefix
const BOOK_ALIASES = {
  'gen':'Genesis','ex':'Exodus','exo':'Exodus','lev':'Leviticus','num':'Numbers',
  'deut':'Deuteronomy','deu':'Deuteronomy','dt':'Deuteronomy',
  'josh':'Joshua','jos':'Joshua','judg':'Judges','jdg':'Judges',
  'ruth':'Ruth','ru':'Ruth',
  '1sam':'1 Samuel','2sam':'2 Samuel','1kgs':'1 Kings','2kgs':'2 Kings',
  '1chr':'1 Chronicles','2chr':'2 Chronicles','1chron':'1 Chronicles','2chron':'2 Chronicles',
  'ezr':'Ezra','neh':'Nehemiah','est':'Esther','esth':'Esther',
  'ps':'Psalms','psa':'Psalms','pss':'Psalms',
  'prov':'Proverbs','pro':'Proverbs','prv':'Proverbs',
  'eccl':'Ecclesiastes','ecc':'Ecclesiastes','qoh':'Ecclesiastes',
  'sos':'Song of Solomon','sng':'Song of Solomon','song':'Song of Solomon','ss':'Song of Solomon',
  'isa':'Isaiah','jer':'Jeremiah','lam':'Lamentations','eze':'Ezekiel','ezek':'Ezekiel',
  'dan':'Daniel','hos':'Hosea','joel':'Joel','amos':'Amos','oba':'Obadiah','obad':'Obadiah',
  'jon':'Jonah','mic':'Micah','nah':'Nahum','hab':'Habakkuk','zeph':'Zephaniah','zep':'Zephaniah',
  'hag':'Haggai','zech':'Zechariah','zec':'Zechariah','mal':'Malachi',
  'mt':'Matthew','matt':'Matthew','mk':'Mark','lk':'Luke','jn':'John',
  'acts':'Acts','ac':'Acts',
  'rom':'Romans','ro':'Romans',
  '1co':'1 Corinthians','2co':'2 Corinthians',
  '1cor':'1 Corinthians','2cor':'2 Corinthians',
  'gal':'Galatians','ga':'Galatians',
  'eph':'Ephesians',
  'phil':'Philippians','php':'Philippians',
  'col':'Colossians',
  '1th':'1 Thessalonians','2th':'2 Thessalonians',
  '1thes':'1 Thessalonians','2thes':'2 Thessalonians',
  '1tim':'1 Timothy','2tim':'2 Timothy',
  'tit':'Titus','phm':'Philemon','phlm':'Philemon',
  'heb':'Hebrews',
  'jas':'James','jms':'James',
  '1pet':'1 Peter','2pet':'2 Peter','1pe':'1 Peter','2pe':'2 Peter',
  '1jn':'1 John','2jn':'2 John','3jn':'3 John',
  '1john':'1 John','2john':'2 John','3john':'3 John',
  'jude':'Jude','rev':'Revelation','rvl':'Revelation','apoc':'Revelation',
};

function matchBooks(query) {
  if (!query || query.length < 2) return [];
  const q = query.toLowerCase().replace(/\s+/g,'');
  // Check alias map first (exact key match)
  if (BOOK_ALIASES[q]) {
    const target = BOOK_ALIASES[q];
    const book = state.books.find(b => b === target);
    if (book) return [book];
  }
  // Also check partial alias matches (e.g. "1c" → "1co" → 1 Corinthians)
  const aliasMatches = [];
  for (const [alias, canonical] of Object.entries(BOOK_ALIASES)) {
    if (alias.startsWith(q) && !aliasMatches.includes(canonical)) {
      const book = state.books.find(b => b === canonical);
      if (book) aliasMatches.push(book);
    }
  }
  // Standard prefix match on actual book names
  const directMatches = state.books.filter(book => {
    const b = book.toLowerCase().replace(/\s+/g,'');
    return b.startsWith(q);
  });
  // Merge, deduplicate, limit
  const merged = [...new Set([...aliasMatches, ...directMatches])];
  return merged.slice(0, 8);
}

function showAutocomplete(matches, wordInfo) {
  let popup = $('ac-popup');
  if (!popup) {
    popup = document.createElement('div');
    popup.id = 'ac-popup';
    popup.className = 'ac-popup';
    document.body.appendChild(popup);
  }

  popup.innerHTML = '';
  matches.forEach((book, i) => {
    const item = document.createElement('button');
    item.className = 'ac-item' + (i === state.ac.index ? ' ac-item-active' : '');
    item.dataset.book = book;
    // Bold the matched prefix
    const q = wordInfo.word.replace(/\s+/g,'');
    const display = book.replace(/\s+/g,'');
    const matchLen = q.length;
    // Find where the match ends in the original book name
    let charCount = 0, endIdx = 0;
    for (let c = 0; c < book.length; c++) {
      if (book[c] !== ' ') charCount++;
      if (charCount >= matchLen) { endIdx = c + 1; break; }
    }
    item.innerHTML = `<strong>${escapeHtml(book.slice(0, endIdx))}</strong>${escapeHtml(book.slice(endIdx))}`;
    item.addEventListener('mousedown', e => {
      e.preventDefault(); // don't blur editor
      acceptAutocomplete(book, wordInfo);
    });
    popup.appendChild(item);
  });

  // Position near caret
  positionPopupAtCaret(popup);
  popup.classList.add('ac-visible');

  state.ac.active    = true;
  state.ac.items     = matches;
  state.ac.triggerNode  = wordInfo.node;
  state.ac.startOffset  = wordInfo.startOffset;
}

function positionPopupAtCaret(popup) {
  const sel = window.getSelection();
  if (!sel.rangeCount) return;
  const range = sel.getRangeAt(0).cloneRange();
  range.collapse(true);
  const rect = range.getBoundingClientRect();
  if (!rect || rect.width === 0) return;

  const scrollY = window.scrollY || document.documentElement.scrollTop;
  const scrollX = window.scrollX || document.documentElement.scrollLeft;

  let top  = rect.bottom + scrollY + 4;
  let left = rect.left   + scrollX;

  // Keep inside viewport
  const pw = 220;
  if (left + pw > window.innerWidth - 8) left = window.innerWidth - pw - 8;
  if (left < 8) left = 8;

  popup.style.top  = top + 'px';
  popup.style.left = left + 'px';
}

function hideAutocomplete() {
  const popup = $('ac-popup');
  if (popup) popup.classList.remove('ac-visible');
  state.ac.active = false;
  state.ac.items  = [];
  state.ac.index  = -1;
}

function moveAcSelection(dir) {
  const items = state.ac.items;
  if (!items.length) return;
  state.ac.index = (state.ac.index + dir + items.length) % items.length;
  renderAcSelection();
}

function renderAcSelection() {
  const popup = $('ac-popup');
  if (!popup) return;
  popup.querySelectorAll('.ac-item').forEach((el, i) => {
    el.classList.toggle('ac-item-active', i === state.ac.index);
  });
}

function acceptAutocomplete(book, wordInfo) {
  // Replace the partial word in the text node with the full book name + space
  const node  = wordInfo ? wordInfo.node  : state.ac.triggerNode;
  const start = wordInfo ? wordInfo.startOffset : state.ac.startOffset;
  if (!node || node.nodeType !== Node.TEXT_NODE) { hideAutocomplete(); return; }

  const sel = window.getSelection();
  const caretOffset = sel.rangeCount ? sel.getRangeAt(0).startOffset : start;
  const before   = node.textContent.slice(0, start);
  const after    = node.textContent.slice(caretOffset);
  const inserted = book + '\u00A0'; // non-breaking space keeps caret outside any future span
  node.textContent = before + inserted + after;

  // Place caret right after the inserted text (after the space)
  try {
    const range = document.createRange();
    range.setStart(node, before.length + inserted.length);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
  } catch(_) {}

  hideAutocomplete();
  // Delay live highlight so caret position is stable first
  clearTimeout(_liveHighlightTimer);
  _liveHighlightTimer = setTimeout(() => {
    if (!state.activeNoteId) return;
    const savedOffset = getAbsoluteCaretOffset(DOM.notesEditor);
    applyVerseHighlights();
    try { restoreCaretFromOffset(DOM.notesEditor, savedOffset); } catch(_) {}
  }, 800);
  scheduleAutoSave();
}

/* Handle input in editor for autocomplete */
function handleEditorInputForAC() {
  if (!state.bible) return;
  const info = getWordBeforeCaret();
  if (!info || info.word.trim().length < 2) { hideAutocomplete(); return; }

  const matches = matchBooks(info.word.trim());
  if (!matches.length) { hideAutocomplete(); return; }

  // If the text immediately after the typed word is already a digit/colon,
  // the user is typing a chapter — hide suggestions
  const full      = info.node.textContent;
  const charAfter = full[info.startOffset + info.word.length];
  if (charAfter && /[\d:]/.test(charAfter)) { hideAutocomplete(); return; }

  // Auto-select index: if single match, highlight it; otherwise no pre-selection
  state.ac.index = matches.length === 1 ? 0 : -1;
  showAutocomplete(matches, info);
}

/* Handle keydown in editor for autocomplete navigation */
function handleEditorKeydownForAC(e) {
  if (!state.ac.active) return false;
  if (e.key === 'ArrowDown')  { e.preventDefault(); moveAcSelection(1); return true; }
  if (e.key === 'ArrowUp')    { e.preventDefault(); moveAcSelection(-1); return true; }
  if (e.key === 'Escape')     { e.preventDefault(); hideAutocomplete(); return true; }
  if (e.key === 'Enter' || e.key === 'Tab') {
    if (state.ac.index >= 0 && state.ac.items[state.ac.index]) {
      e.preventDefault();
      acceptAutocomplete(state.ac.items[state.ac.index], null);
      return true;
    }
    // If only 1 match, accept it
    if (state.ac.items.length === 1) {
      e.preventDefault();
      const info = getWordBeforeCaret();
      acceptAutocomplete(state.ac.items[0], info);
      return true;
    }
  }
  return false;
}

/* ── Part 2: Smart Verse Pattern Matching ────────────────

   Formats supported (all case-insensitive for separators):
     John 3:16
     John 3:16-17        (range)
     John 3 16
     John 3 vs 16
     John 3 vs 16-17
     John 3 verse 16
     John 3 verse 16-17
     John 3 v 16
     John 3 - 16
     John 3/16
     John 3.16
     1 John 3:16         (numbered books)
     Song of Solomon 1:1 (multi-word books)

   The pattern is built dynamically from state.books once Bible loads.
*/

let _versePattern = null;

/* Abbreviation → full book name map */
const BOOK_ABBREVS = {
  // Old Testament
  'gen':'Genesis','ge':'Genesis','gn':'Genesis',
  'ex':'Exodus','exo':'Exodus','exod':'Exodus',
  'lev':'Leviticus','le':'Leviticus','lv':'Leviticus',
  'num':'Numbers','nu':'Numbers','nm':'Numbers','nb':'Numbers',
  'deut':'Deuteronomy','deu':'Deuteronomy','dt':'Deuteronomy',
  'josh':'Joshua','jos':'Joshua','jsh':'Joshua',
  'judg':'Judges','jdg':'Judges','jg':'Judges','jdgs':'Judges',
  'ruth':'Ruth','rth':'Ruth','ru':'Ruth',
  '1sam':'1 Samuel','1sa':'1 Samuel','1 sam':'1 Samuel','1 sa':'1 Samuel','1s':'1 Samuel',
  '2sam':'2 Samuel','2sa':'2 Samuel','2 sam':'2 Samuel','2 sa':'2 Samuel','2s':'2 Samuel',
  '1kgs':'1 Kings','1ki':'1 Kings','1 kgs':'1 Kings','1 ki':'1 Kings','1k':'1 Kings',
  '2kgs':'2 Kings','2ki':'2 Kings','2 kgs':'2 Kings','2 ki':'2 Kings','2k':'2 Kings',
  '1chr':'1 Chronicles','1ch':'1 Chronicles','1 chr':'1 Chronicles','1 ch':'1 Chronicles',
  '2chr':'2 Chronicles','2ch':'2 Chronicles','2 chr':'2 Chronicles','2 ch':'2 Chronicles',
  'ezra':'Ezra','ezr':'Ezra',
  'neh':'Nehemiah','ne':'Nehemiah',
  'est':'Esther','esth':'Esther',
  'job':'Job','jb':'Job',
  'ps':'Psalms','psa':'Psalms','psm':'Psalms','pss':'Psalms',
  'prov':'Proverbs','pro':'Proverbs','prv':'Proverbs','pr':'Proverbs',
  'eccl':'Ecclesiastes','ecc':'Ecclesiastes','ec':'Ecclesiastes','qoh':'Ecclesiastes',
  'song':'Song of Solomon','sos':'Song of Solomon','ss':'Song of Solomon','sg':'Song of Solomon','cant':'Song of Solomon',
  'isa':'Isaiah','is':'Isaiah',
  'jer':'Jeremiah','je':'Jeremiah','jr':'Jeremiah',
  'lam':'Lamentations','la':'Lamentations',
  'ezek':'Ezekiel','eze':'Ezekiel','ezk':'Ezekiel',
  'dan':'Daniel','da':'Daniel','dn':'Daniel',
  'hos':'Hosea','ho':'Hosea',
  'joel':'Joel','jl':'Joel',
  'amos':'Amos','am':'Amos',
  'obad':'Obadiah','ob':'Obadiah',
  'jonah':'Jonah','jon':'Jonah',
  'mic':'Micah','mi':'Micah',
  'nah':'Nahum','na':'Nahum',
  'hab':'Habakkuk','hb':'Habakkuk',
  'zeph':'Zephaniah','zep':'Zephaniah','zp':'Zephaniah',
  'hag':'Haggai','hg':'Haggai',
  'zech':'Zechariah','zec':'Zechariah','zc':'Zechariah',
  'mal':'Malachi','ml':'Malachi',
  // New Testament
  'matt':'Matthew','mat':'Matthew','mt':'Matthew',
  'mark':'Mark','mrk':'Mark','mk':'Mark','mr':'Mark',
  'luke':'Luke','luk':'Luke','lk':'Luke',
  'john':'John','joh':'John','jn':'John','jhn':'John',
  'acts':'Acts','act':'Acts','ac':'Acts',
  'rom':'Romans','ro':'Romans','rm':'Romans',
  '1cor':'1 Corinthians','1co':'1 Corinthians','1 cor':'1 Corinthians','1 co':'1 Corinthians',
  '2cor':'2 Corinthians','2co':'2 Corinthians','2 cor':'2 Corinthians','2 co':'2 Corinthians',
  'gal':'Galatians','ga':'Galatians',
  'eph':'Ephesians','ep':'Ephesians',
  'phil':'Philippians','php':'Philippians','pp':'Philippians',
  'col':'Colossians',
  '1thess':'1 Thessalonians','1th':'1 Thessalonians','1 thess':'1 Thessalonians','1 th':'1 Thessalonians',
  '2thess':'2 Thessalonians','2th':'2 Thessalonians','2 thess':'2 Thessalonians','2 th':'2 Thessalonians',
  '1tim':'1 Timothy','1ti':'1 Timothy','1 tim':'1 Timothy','1 ti':'1 Timothy',
  '2tim':'2 Timothy','2ti':'2 Timothy','2 tim':'2 Timothy','2 ti':'2 Timothy',
  'tit':'Titus','ti':'Titus',
  'phlm':'Philemon','phm':'Philemon','pm':'Philemon',
  'heb':'Hebrews','he':'Hebrews',
  'jas':'James','jm':'James',
  '1pet':'1 Peter','1pe':'1 Peter','1 pet':'1 Peter','1 pe':'1 Peter','1p':'1 Peter',
  '2pet':'2 Peter','2pe':'2 Peter','2 pet':'2 Peter','2 pe':'2 Peter','2p':'2 Peter',
  '1jn':'1 John','1jo':'1 John','1 jn':'1 John','1 jo':'1 John','1 john':'1 John',
  '2jn':'2 John','2jo':'2 John','2 jn':'2 John','2 jo':'2 John','2 john':'2 John',
  '3jn':'3 John','3jo':'3 John','3 jn':'3 John','3 jo':'3 John','3 john':'3 John',
  'jude':'Jude','jud':'Jude',
  'rev':'Revelation','re':'Revelation','rv':'Revelation','apoc':'Revelation'
};

function resolveBookName(raw) {
  // First try exact match in books list
  const exact = state.books.find(b => b.toLowerCase() === raw.toLowerCase());
  if (exact) return exact;
  // Try abbreviation map
  const full = BOOK_ABBREVS[raw.toLowerCase().replace(/\s+/g,'')];
  if (full) return state.books.find(b => b.toLowerCase() === full.toLowerCase()) || null;
  // Also try with spaces preserved
  const full2 = BOOK_ABBREVS[raw.toLowerCase()];
  if (full2) return state.books.find(b => b.toLowerCase() === full2.toLowerCase()) || null;
  return null;
}

function buildVersePattern() {
  if (!state.books.length) return;
  // Full book names sorted longest-first
  const escaped = [...state.books]
    .sort((a,b) => b.length - a.length)
    .map(b => b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  // Abbreviations sorted longest-first to avoid partial matches
  const abbrevEscaped = Object.keys(BOOK_ABBREVS)
    .sort((a,b) => b.length - a.length)
    .map(a => a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\ /g, '\\s+'));
  const bookPart = `(?:${[...escaped, ...abbrevEscaped].join('|')})`;
  // Separator between chapter and verse:
  //   :  /  .  -  (space)  vs(.)  verse  v(.)
  const sep = `(?:\\s*(?::|/|\\.|vs?\\.?\\s*|verse\\s+|-)\\s*|\\s+)`;
  // Optional verse range: -17
  const range = `(?:\\s*-\\s*\\d+)?`;
  _versePattern = new RegExp(
    `\\b(${bookPart})\\s+(\\d+)${sep}(\\d+)${range}\\b`,
    'gi'
  );
}

function applyVerseHighlights() {
  if (!_versePattern) return;
  walkAndHighlight(DOM.notesEditor);
  DOM.notesEditor.querySelectorAll('.verse-ref').forEach(el => {
    el.addEventListener('click', e => {
      e.stopPropagation();
      navigateTo(el.dataset.book, parseInt(el.dataset.chapter,10), parseInt(el.dataset.verse,10));
    });
  });
}

function walkAndHighlight(node) {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = node.textContent;
    _versePattern.lastIndex = 0;
    let match, lastIndex = 0;
    const parts = [];
    while ((match = _versePattern.exec(text)) !== null) {
      const rawBook = match[1];
      const ch   = match[2];
      const v    = match[3];
      // Normalise book name (supports full names and abbreviations)
      const book = resolveBookName(rawBook);
      if (!book) continue;
      if (match.index > lastIndex) parts.push(document.createTextNode(text.slice(lastIndex, match.index)));
      const span = document.createElement('span');
      span.className = 'verse-ref';
      span.dataset.book    = book;
      span.dataset.chapter = ch;
      span.dataset.verse   = v;
      span.textContent     = match[0];
      parts.push(span);
      lastIndex = match.index + match[0].length;
    }
    if (!parts.length) return;
    if (lastIndex < text.length) parts.push(document.createTextNode(text.slice(lastIndex)));
    const frag = document.createDocumentFragment();
    parts.forEach(p => frag.appendChild(p));
    node.parentNode.replaceChild(frag, node);
    return;
  }
  if (node.nodeType === Node.ELEMENT_NODE && node.classList.contains('verse-ref')) return;
  Array.from(node.childNodes).forEach(walkAndHighlight);
}

/* Live highlighting as user types (debounced) */
let _liveHighlightTimer = null;
function scheduleLiveHighlight() {
  clearTimeout(_liveHighlightTimer);
  _liveHighlightTimer = setTimeout(() => {
    if (!state.activeNoteId) return;
    // Save caret as absolute char offset so it survives DOM rebuilding
    const sel = window.getSelection();
    let savedOffset = null;
    if (sel.rangeCount) {
      savedOffset = getAbsoluteCaretOffset(DOM.notesEditor);
    }
    applyVerseHighlights();
    // Restore caret to exact position before linking
    if (savedOffset !== null) {
      try { restoreCaretFromOffset(DOM.notesEditor, savedOffset); } catch(_) {}
    }
  }, 8000);
}

/* Returns the character offset of the caret within el's plain text */
function getAbsoluteCaretOffset(el) {
  const sel = window.getSelection();
  if (!sel.rangeCount) return 0;
  const range = sel.getRangeAt(0);
  const preRange = document.createRange();
  preRange.selectNodeContents(el);
  preRange.setEnd(range.startContainer, range.startOffset);
  return preRange.toString().length;
}

/* Places caret at the given absolute char offset within el */
function restoreCaretFromOffset(el, offset) {
  const sel = window.getSelection();
  const range = document.createRange();
  let charCount = 0, found = false;
  function walk(node) {
    if (found) return;
    if (node.nodeType === Node.TEXT_NODE) {
      const len = node.textContent.length;
      if (charCount + len >= offset) {
        range.setStart(node, offset - charCount);
        range.collapse(true);
        found = true;
      } else {
        charCount += len;
      }
    } else {
      for (let i = 0; i < node.childNodes.length; i++) walk(node.childNodes[i]);
    }
  }
  walk(el);
  if (!found) {
    // Offset beyond content — place at end
    range.selectNodeContents(el);
    range.collapse(false);
  }
  sel.removeAllRanges();
  sel.addRange(range);
}

/* ─── Chips ─────────────────────────────────────────────── */
function refreshChips() {
  DOM.notesChips.innerHTML = '';
  const recent = state.notes.slice(0, 10);
  if (!recent.length) {
    DOM.notesChips.innerHTML = '<span class="empty-chips">No notes yet — tap + New Note</span>';
    return;
  }
  recent.forEach(note => {
    const chip = document.createElement('button');
    chip.className = 'note-chip' + (note.id === state.activeNoteId ? ' active' : '');
    const label = getNoteLabel(note);
    chip.innerHTML = `<span class="note-chip-dot"></span>${escapeHtml(label.slice(0,28))}`;
    chip.title = label;
    chip.addEventListener('click', () => openNote(note.id));
    DOM.notesChips.appendChild(chip);
  });
}

/* ─── Note list ─────────────────────────────────────────── */
function renderNoteList() {
  DOM.notesListItems.innerHTML = '';
  if (!state.notes.length) {
    DOM.notesListItems.innerHTML = `
      <div class="empty-list-state">
        <div class="empty-list-icon-wrap">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
            <polyline points="14 2 14 8 20 8"/>
            <line x1="12" y1="12" x2="12" y2="18"/>
            <line x1="9" y1="15" x2="15" y2="15"/>
          </svg>
        </div>
        <p class="empty-list-title">No notes yet</p>
        <p class="empty-list-sub">Capture your thoughts, insights, and reflections on Scripture.</p>
        <button class="empty-list-cta" id="btn-empty-cta">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          Create your first note
        </button>
      </div>`;
    const cta = document.getElementById('btn-empty-cta');
    if (cta) cta.addEventListener('click', createAndOpenNote);
    return;
  }
  const grid = document.createElement('div');
  grid.className = 'notes-grid';
  state.notes.forEach(note => {
    const card = document.createElement('button');
    card.className = 'note-card' + (note.id === state.activeNoteId ? ' active' : '');
    const label = getNoteLabel(note);
    const tmp = document.createElement('div');
    tmp.innerHTML = note.content;
    const bodyText = (tmp.textContent || '').trim().replace(/\s+/g,' ').slice(0,100);
    card.innerHTML = `
      <div class="nc-title">${escapeHtml(label.slice(0,50))}</div>
      ${bodyText ? `<div class="nc-preview">${escapeHtml(bodyText)}</div>` : ''}
      <div class="nc-date">${formatDate(note.timestamp)}</div>`;
    card.addEventListener('click', () => openNote(note.id));
    grid.appendChild(card);
  });
  DOM.notesListItems.appendChild(grid);
}

/* ─── Sub-view switching ─────────────────────────────────── */
function showEditorView() {
  DOM.viewEditor.classList.add('active');
  DOM.viewList.classList.remove('active');
}
function showListView() {
  triggerSave();
  renderNoteList();
  DOM.viewList.classList.add('active');
  DOM.viewEditor.classList.remove('active');
}

/* ─── Bible loader & rendering ──────────────────────────── */

/**
 * Decompress and return bible data from the embedded window._bibleB64 string.
 * The stored format is: gzip( JSON({ b:[bookNames], v:[[[verseText,...],...],...] }) )
 * We expand it back to the original {books, verses} shape so the rest of
 * the app works unchanged.
 */
async function loadBible() {
  return new Promise((resolve, reject) => {
    try {
      // Decode base64 → Uint8Array
      const binaryStr = atob(window._bibleB64);
      const bytes = new Uint8Array(binaryStr.length);
      for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);

      // Decompress with native DecompressionStream (gzip)
      const ds = new DecompressionStream('gzip');
      const writer = ds.writable.getWriter();
      const reader = ds.readable.getReader();
      const chunks = [];

      reader.read().then(function pump({ done, value }) {
        if (done) {
          const total = chunks.reduce((s, c) => s + c.length, 0);
          const merged = new Uint8Array(total);
          let offset = 0;
          chunks.forEach(c => { merged.set(c, offset); offset += c.length; });
          const text = new TextDecoder().decode(merged);
          const compact = JSON.parse(text);

          // Expand compact array format → original {books, verses} object shape
          const books = compact.b;
          const verses = {};
          books.forEach((book, bi) => {
            verses[book] = {};
            (compact.v[bi] || []).forEach((chArr, ci) => {
              const chNum = ci + 1;
              verses[book][chNum] = {};
              chArr.forEach((text, vi) => {
                verses[book][chNum][vi + 1] = text;
              });
            });
          });

          resolve({ books, verses });
          return;
        }
        chunks.push(value);
        return reader.read().then(pump);
      }).catch(reject);

      writer.write(bytes);
      writer.close();
    } catch(e) { reject(e); }
  });
}

function populateBookSelector() {
  DOM.selBook.innerHTML = '';
  state.books.forEach(n => {
    const o = document.createElement('option');
    o.value = n; o.textContent = n;
    if (n === state.currentBook) o.selected = true;
    DOM.selBook.appendChild(o);
  });
}

function populateChapterSelector() {
  const chs = Object.keys(state.bible.verses[state.currentBook]||{}).map(Number).sort((a,b)=>a-b);
  DOM.selChapter.innerHTML = '';
  chs.forEach(n => {
    const o = document.createElement('option');
    o.value = n; o.textContent = `Chapter ${n}`;
    if (n === state.currentChapter) o.selected = true;
    DOM.selChapter.appendChild(o);
  });
}

function populateVerseSelector() {
  const vs = Object.keys((state.bible.verses[state.currentBook]||{})[state.currentChapter]||{}).map(Number).sort((a,b)=>a-b);
  DOM.selVerse.innerHTML = '';
  vs.forEach(n => {
    const o = document.createElement('option');
    o.value = n; o.textContent = `Verse ${n}`;
    if (n === state.currentVerse) o.selected = true;
    DOM.selVerse.appendChild(o);
  });
}

function renderVerses() {
  const ch = (state.bible.verses[state.currentBook]||{})[state.currentChapter]||{};
  const nums = Object.keys(ch).map(Number).sort((a,b)=>a-b);
  DOM.verseContainer.innerHTML = '';
  const hdg = document.createElement('div');
  hdg.className = 'chapter-heading';
  hdg.innerHTML = `<span>${state.currentBook}</span> · Chapter ${state.currentChapter}`;
  DOM.verseContainer.appendChild(hdg);
  nums.forEach(v => {
    const row = document.createElement('div');
    row.className = 'verse-row'; row.dataset.verse = v; row.id = `verse-${v}`;
    if (v === state.currentVerse) row.classList.add('selected');
    row.innerHTML = `<span class="verse-num">${v}</span><span class="verse-text">${escapeHtml(ch[v])}</span>`;
    row.addEventListener('click', () => selectVerse(v));
    DOM.verseContainer.appendChild(row);
  });
  scrollToVerse(state.currentVerse);
}

function selectVerse(v) {
  const prev = DOM.verseContainer.querySelector('.verse-row.selected');
  if (prev) prev.classList.remove('selected');
  state.currentVerse = v;
  const row = $(`verse-${v}`);
  if (row) row.classList.add('selected');
  DOM.selVerse.value = v;
  scrollToVerse(v);
}

function scrollToVerse(v) {
  const row = $(`verse-${v}`);
  if (row) requestAnimationFrame(() => row.scrollIntoView({ behavior:'smooth', block:'nearest' }));
}

async function navigateTo(book, chapter, verse) {
  if (!state.bible.verses[book]) { showToast(`"${book}" not found`, 'error'); return; }
  if (!state.bible.verses[book][chapter]) { showToast(`${book} ${chapter} not found`, 'error'); return; }
  await triggerSave();
  state.currentBook = book; state.currentChapter = chapter; state.currentVerse = verse||1;
  DOM.selBook.value = book;
  populateChapterSelector(); DOM.selChapter.value = chapter;
  populateVerseSelector();   DOM.selVerse.value   = state.currentVerse;
  renderVerses();
  if (window.innerWidth <= 720) switchTab('bible');
  showToast(`${book} ${chapter}:${state.currentVerse}`, 'info');
}

/* ─── Export / Import ───────────────────────────────────── */
function exportAsPDF() {
  const note = state.notes.find(n => n.id === state.activeNoteId);
  if (!note || (!note.title && !note.content)) { showToast('Nothing to export', 'error'); return; }
  const win = window.open('','_blank','width=800,height=600');
  if (!win) { showToast('Popup blocked', 'error'); return; }
  const title = escapeHtml(getNoteLabel(note));
  win.document.write(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${title}</title>
<style>body{font-family:Georgia,serif;font-size:13pt;line-height:1.8;color:#111;max-width:680px;margin:40px auto;padding:0 20px}
h1{font-size:18pt;margin-bottom:4px}.meta{font-size:10pt;color:#666;margin-bottom:20px}hr{border:none;border-top:1px solid #ddd;margin:16px 0}
ul,ol{padding-left:24px}li{margin-bottom:4px}
</style></head><body>
<h1>${title}</h1>
<div class="meta">Scripture Notes · ${new Date().toLocaleDateString()}</div>
<hr>
${note.content}
</body></html>`);
  win.document.close(); win.focus();
  setTimeout(() => win.print(), 300);
  showToast('Opening PDF export…', 'success');
}

function importNoteFile(file) {
  const reader = new FileReader();
  reader.onload = async e => {
    const note = makeNote();
    const text = e.target.result;
    if (file.name.endsWith('.html')) {
      note.content = text;
    } else {
      note.content = text.split('\n').map(l => `<p>${escapeHtml(l)||'&nbsp;'}</p>`).join('');
    }
    state.notes.unshift(note);
    if (state.db) await dbPut(note);
    await openNote(note.id);
    showToast('Note imported', 'success');
  };
  reader.onerror = () => showToast('Failed to read file', 'error');
  reader.readAsText(file);
}

/* ─── Mobile tabs ───────────────────────────────────────── */
function switchTab(name) {
  state.activeTab = name;
  DOM.tabBtns.forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  DOM.panelBible.classList.toggle('active', name === 'bible');
  DOM.panelNotes.classList.toggle('active', name === 'notes');
}

function setupLayout() {
  const m = window.innerWidth <= 720;
  if (m) {
    DOM.panelBible.classList.toggle('active', state.activeTab === 'bible');
    DOM.panelNotes.classList.toggle('active', state.activeTab === 'notes');
  } else {
    DOM.panelBible.classList.remove('active');
    DOM.panelNotes.classList.remove('active');
  }
}

/* ─── Event wiring ──────────────────────────────────────── */
function attachEventListeners() {
  DOM.selBook.addEventListener('change', async () => {
    await triggerSave();
    state.currentBook = DOM.selBook.value; state.currentChapter = 1; state.currentVerse = 1;
    populateChapterSelector(); populateVerseSelector(); renderVerses();
  });
  DOM.selChapter.addEventListener('change', async () => {
    await triggerSave();
    state.currentChapter = parseInt(DOM.selChapter.value,10); state.currentVerse = 1;
    populateVerseSelector(); renderVerses();
  });
  DOM.selVerse.addEventListener('change', () => {
    state.currentVerse = parseInt(DOM.selVerse.value,10); selectVerse(state.currentVerse);
  });

  /* Title field */
  DOM.noteTitle.addEventListener('input', () => { if (state.activeNoteId) scheduleAutoSave(); });
  DOM.noteTitle.addEventListener('focus', () => {
    if (!state.activeNoteId) { showToast('Tap "+ New Note" to start', 'info'); setTimeout(()=>DOM.noteTitle.blur(),0); }
  });
  DOM.noteTitle.addEventListener('keydown', e => {
    if (!state.activeNoteId) { e.preventDefault(); return; }
    if (e.key === 'Enter') { e.preventDefault(); DOM.notesEditor.focus(); placeCaretAtEnd(DOM.notesEditor); }
  });

  /* Editor body — autocomplete + live highlight + save */
  DOM.notesEditor.addEventListener('input', () => {
    if (!state.activeNoteId) return;
    handleEditorInputForAC();
    scheduleLiveHighlight();
    scheduleAutoSave();
  });

  DOM.notesEditor.addEventListener('keydown', e => {
    // Autocomplete takes priority for nav keys
    if (handleEditorKeydownForAC(e)) return;
  });

  DOM.notesEditor.addEventListener('keyup', updateToolbarState);
  DOM.notesEditor.addEventListener('mouseup', () => {
    updateToolbarState();
    hideAutocomplete();
  });

  DOM.notesEditor.addEventListener('blur', () => {
    // Delay so mousedown on ac-popup can fire first
    setTimeout(() => {
      hideAutocomplete();
      if (state.activeNoteId) { applyVerseHighlights(); triggerSave(); }
    }, 150);
  });

  DOM.notesEditor.addEventListener('focus', () => {
    if (!state.activeNoteId) { showToast('Tap "+ New Note" to start', 'info'); setTimeout(()=>DOM.notesEditor.blur(),0); }
  });

  /* Format toolbar */
  DOM.formatBtns.forEach(btn => {
    btn.addEventListener('mousedown', e => {
      e.preventDefault();
      if (state.activeNoteId) applyFormat(btn.dataset.cmd);
    });
  });

  /* Delete */
  DOM.btnDeleteNote.addEventListener('click', async () => {
    if (!state.activeNoteId) return;
    const note  = state.notes.find(n => n.id === state.activeNoteId);
    const label = note ? getNoteLabel(note) : 'this note';
    if (!await showConfirm(`Delete "${label.slice(0,40)}"?\nThis cannot be undone.`)) return;
    await dbDel(state.activeNoteId);
    state.notes        = state.notes.filter(n => n.id !== state.activeNoteId);
    state.activeNoteId = null;
    if (state.notes.length) { await openNote(state.notes[0].id); }
    else { DOM.noteTitle.textContent = ''; DOM.notesEditor.innerHTML = ''; updateSaveLabel(''); refreshChips(); }
    showToast('Note deleted', 'info');
  });

  DOM.btnBackToList.addEventListener('click', showListView);
  DOM.btnCreateNoteBar.addEventListener('click', createAndOpenNote);
  DOM.btnCreateNoteList.addEventListener('click', createAndOpenNote);

  DOM.btnExport.addEventListener('click', exportAsPDF);
  DOM.btnImport.addEventListener('click', () => DOM.fileImport.click());
  DOM.fileImport.addEventListener('change', e => {
    const f = e.target.files[0];
    if (f) { importNoteFile(f); e.target.value = ''; }
  });

  DOM.tabBtns.forEach(b => b.addEventListener('click', () => switchTab(b.dataset.tab)));
  window.addEventListener('resize', setupLayout, { passive: true });

  // Hide autocomplete when clicking outside
  document.addEventListener('mousedown', e => {
    const popup = $('ac-popup');
    if (popup && !popup.contains(e.target) && e.target !== DOM.notesEditor) {
      hideAutocomplete();
    }
  });
}

/* ─── Bootstrap ─────────────────────────────────────────── */
async function init() {
  Object.assign(DOM, {
    selBook:           $('sel-book'),
    selChapter:        $('sel-chapter'),
    selVerse:          $('sel-verse'),
    verseContainer:    $('verse-container'),
    bibleLoading:      $('bible-loading'),
    noteTitle:         $('note-title'),
    notesEditor:       $('notes-editor'),
    saveIndicator:     $('save-indicator'),
    saveText:          $('save-text'),
    notesChips:        $('notes-chips'),
    toast:             $('toast'),
    modalOverlay:      $('modal-overlay'),
    modalMessage:      $('modal-message'),
    modalConfirm:      $('modal-confirm'),
    modalCancel:       $('modal-cancel'),
    btnExport:         $('btn-export'),
    btnImport:         $('btn-import'),
    fileImport:        $('file-import'),
    btnDeleteNote:     $('btn-delete-note'),
    btnBackToList:     $('btn-back-to-list'),
    btnCreateNoteBar:  $('btn-create-note-bar'),
    btnCreateNoteList: $('btn-create-note-list'),
    notesListItems:    $('notes-list-items'),
    viewEditor:        $('view-editor'),
    viewList:          $('view-list'),
    tabBtns:           document.querySelectorAll('.tab-btn'),
    panelBible:        $('panel-bible'),
    panelNotes:        $('panel-notes'),
    formatBtns:        document.querySelectorAll('.fmt-btn'),
  });

  try { state.db = await openDB(); }
  catch(e) { console.error('IDB', e); showToast('Storage unavailable', 'error'); }

  if (state.db) state.notes = await dbAll();

  let bible;
  try { bible = await loadBible(); }
  catch(e) {
    $('bible-loading').innerHTML = `<p style="color:var(--danger);text-align:center;padding:20px">
      Could not load Bible data.<br>
      <small style="color:var(--text-sec)">Make sure <strong>bible.js</strong> is in the same folder as index.html.<br>Error: ${e.message}</small></p>`;
    return;
  }

  state.bible = bible; state.books = bible.books;
  $('bible-loading').style.display = 'none';
  buildVersePattern();
  populateBookSelector(); populateChapterSelector(); populateVerseSelector(); renderVerses();

  if (state.notes.length) { await openNote(state.notes[0].id); }
  else { updateSaveLabel(''); renderNoteList(); showListView(); }
  refreshChips();

  attachEventListeners();
  setupLayout();
  if (window.innerWidth <= 720) switchTab('bible');

  console.log('Scripture Notes v4.0 ready');
}

document.addEventListener('DOMContentLoaded', init);
