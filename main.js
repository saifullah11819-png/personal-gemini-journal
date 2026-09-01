// ===== Firebase Imports (via CDN, no install needed) =====
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import {
  getFirestore,
  collection,
  addDoc,
  query,
  where,
  getDocs,
  orderBy,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

// ===== 1. Firebase Config =====
const firebaseConfig = {
  apiKey: "AIzaSyB8eWYo78R_J35MmLMZpY78dp_dVxekVLY",
  authDomain: "personal-gemini-journal-28c82.firebaseapp.com",
  projectId: "personal-gemini-journal-28c82",
  storageBucket: "personal-gemini-journal-28c82.firebasestorage.app",
  messagingSenderId: "41326165157",
  appId: "1:41326165157:web:4403c3022908eb16be614c",
  measurementId: "G-X83TFSLESM"
};

// ===== 2. Gemini API (free tier, no billing) =====
const GEMINI_API_KEY = "YOUR_GEMINI_API_KEY_HERE"; // Get your free key from aistudio.google.com
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-lite-latest:generateContent?key=${GEMINI_API_KEY}`;

// ===== 3. Init =====
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// ===== 4. DOM refs =====
const authDiv = document.getElementById('auth-container');
const appDiv = document.getElementById('app-container');
const chatBox = document.getElementById('chat-box');
const chatForm = document.getElementById('chat-form');
const userInput = document.getElementById('user-input');
const emptyState = document.getElementById('empty-state');
const searchToggle = document.getElementById('search-toggle');
const searchBar = document.getElementById('search-bar');
const searchInput = document.getElementById('search-input');
const exportBtn = document.getElementById('export-btn');
const sidebar = document.getElementById('sidebar');
const sidebarToggle = document.getElementById('sidebar-toggle');
const newChatBtn = document.getElementById('new-chat-btn');
const conversationList = document.getElementById('conversation-list');

let allDocs = [];          // every journal doc for this user (all conversations)
let currentConvoId = null; // which conversation is currently open

// ===== 5. Auth =====
document.getElementById('login-btn').onclick = () => {
  signInWithPopup(auth, new GoogleAuthProvider()).catch((err) => {
    console.error("Login error:", err);
    alert("Sign-in failed. Please try again.");
  });
};
document.getElementById('logout-btn').onclick = () => signOut(auth);

onAuthStateChanged(auth, (user) => {
  if (user) {
    authDiv.classList.add('hidden');
    appDiv.classList.remove('hidden');
    document.getElementById('user-email').innerText = user.email;
    loadAllHistory(user.uid);
  } else {
    authDiv.classList.remove('hidden');
    appDiv.classList.add('hidden');
  }
});

// ===== 6. 3D notebook parallax tilt (signature motion) =====
const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
if (!prefersReducedMotion && window.innerWidth > 700) {
  document.addEventListener('mousemove', (e) => {
    const x = (e.clientX / window.innerWidth - 0.5) * 4;
    const y = (e.clientY / window.innerHeight - 0.5) * -4;
    appDiv.style.transform = `perspective(1400px) rotateY(${x}deg) rotateX(${y}deg)`;
  });
}

// ===== 7. Sidebar toggle (mobile) =====
sidebarToggle.onclick = () => sidebar.classList.toggle('collapsed');

// ===== 8. New Chat =====
newChatBtn.onclick = () => {
  currentConvoId = 'c_' + Date.now();
  renderChat([]);
  highlightActiveConvo();
  if (window.innerWidth <= 700) sidebar.classList.add('collapsed');
  userInput.focus();
};

// ===== 9. Search (within current conversation) =====
searchToggle.onclick = () => {
  searchBar.classList.toggle('hidden');
  if (!searchBar.classList.contains('hidden')) searchInput.focus();
};
searchInput?.addEventListener('input', () => {
  const term = searchInput.value.trim().toLowerCase();
  document.querySelectorAll('.msg-row').forEach(row => {
    const text = row.innerText.toLowerCase();
    row.style.display = (!term || text.includes(term)) ? 'flex' : 'none';
  });
});

// ===== 10. Export whole journal (all conversations) =====
exportBtn.onclick = () => {
  if (allDocs.length === 0) { alert("Your journal is empty."); return; }
  let text = "PERSONAL GEMINI JOURNAL\n========================\n\n";
  let lastConvo = null;
  allDocs.forEach(d => {
    if (d.convoId !== lastConvo) { text += `\n--- ${d.time} ---\n`; lastConvo = d.convoId; }
    text += `You: ${d.prompt}\nGemini: ${d.response}\n\n`;
  });
  const blob = new Blob([text], { type: "text/plain" });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = "gemini-journal.txt";
  link.click();
};

// ===== 11. Send message =====
chatForm.onsubmit = async (e) => {
  e.preventDefault();
  const userText = userInput.value.trim();
  if (!userText) return;
  if (!currentConvoId) currentConvoId = 'c_' + Date.now();

  const userId = auth.currentUser.uid;
  emptyState.remove();
  const now = new Date();
  appendMessage('user', userText, now);
  userInput.value = '';

  const typingId = showTyping();

  try {
    const raw = await callGemini(userText);
    const { response, mood } = parseTag(raw);
    hideTyping(typingId);
    appendMessage('ai', response, new Date(), mood);

    const docData = { userId, convoId: currentConvoId, prompt: userText, response, mood: mood || '', time: now.toLocaleString() };
    allDocs.push(docData);
    renderSidebar();

    await addDoc(collection(db, "journals"), {
      userId,
      convoId: currentConvoId,
      prompt: userText,
      response,
      mood: mood || '',
      timestamp: serverTimestamp()
    });
  } catch (err) {
    console.error("Error calling Gemini or saving data:", err);
    hideTyping(typingId);
    appendMessage('ai', "Sorry, something went wrong. Please try again.", new Date());
  }
};

// ===== 12. Gemini call with retry + mood tag request =====
async function callGemini(promptText, retries = 4) {
  const instructed = `${promptText}\n\n(After your reply, on a new line, add exactly: TAG: <one short 1-2 word mood/theme for this entry, e.g. "hopeful", "stressed", "grateful">)`;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetch(GEMINI_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: instructed }] }] })
    });

    if (res.ok) {
      const data = await res.json();
      return data.candidates?.[0]?.content?.parts?.[0]?.text || "No response received.";
    }
    if (res.status === 503 && attempt < retries) {
      await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
      continue;
    }
    throw new Error(`Gemini API error: ${res.status}`);
  }
}

function parseTag(raw) {
  const match = raw.match(/TAG:\s*(.+)$/im);
  const mood = match ? match[1].trim() : '';
  const response = raw.replace(/TAG:\s*.+$/im, '').trim();
  return { response, mood };
}

// ===== 13. Load ALL history, group into conversations =====
async function loadAllHistory(uid) {
  const q = query(collection(db, "journals"), where("userId", "==", uid), orderBy("timestamp", "asc"));
  const snap = await getDocs(q);
  allDocs = [];
  snap.forEach(doc => {
    const d = doc.data();
    const time = d.timestamp?.toDate ? d.timestamp.toDate() : new Date();
    allDocs.push({
      convoId: d.convoId || 'legacy',
      prompt: d.prompt,
      response: d.response,
      mood: d.mood || '',
      time: time.toLocaleString(),
      dateObj: time
    });
  });

  renderSidebar();

  if (allDocs.length > 0) {
    currentConvoId = allDocs[allDocs.length - 1].convoId; // open most recent conversation
    renderChat(allDocs.filter(d => d.convoId === currentConvoId));
  } else {
    currentConvoId = 'c_' + Date.now();
    renderChat([]);
  }
  highlightActiveConvo();
}

// ===== 14. Sidebar: list distinct conversations =====
function renderSidebar() {
  const convoMap = new Map();
  allDocs.forEach(d => {
    if (!convoMap.has(d.convoId)) {
      convoMap.set(d.convoId, { firstPrompt: d.prompt, date: d.time });
    }
  });

  conversationList.innerHTML = '';
  [...convoMap.entries()].reverse().forEach(([id, info]) => {
    const item = document.createElement('div');
    item.className = 'convo-item';
    item.dataset.id = id;
    item.innerHTML = `<span class="convo-title">${escapeHtml(info.firstPrompt.slice(0, 28))}</span><span class="convo-date">${info.date}</span>`;
    item.onclick = () => {
      currentConvoId = id;
      renderChat(allDocs.filter(d => d.convoId === id));
      highlightActiveConvo();
      if (window.innerWidth <= 700) sidebar.classList.add('collapsed');
    };
    conversationList.appendChild(item);
  });
}

function highlightActiveConvo() {
  document.querySelectorAll('.convo-item').forEach(el => {
    el.classList.toggle('active', el.dataset.id === currentConvoId);
  });
}

// ===== 15. Render a full conversation into the chat box =====
function renderChat(entries) {
  chatBox.innerHTML = '';
  if (entries.length === 0) {
    chatBox.appendChild(emptyState);
    return;
  }
  entries.forEach(d => {
    appendMessage('user', d.prompt, d.dateObj || new Date());
    appendMessage('ai', d.response, d.dateObj || new Date(), d.mood);
  });
}

// ===== 16. Typing indicator =====
function showTyping() {
  const row = document.createElement('div');
  row.className = 'msg-row ai';
  row.id = 'typing-row';
  row.innerHTML = `
    <div class="avatar ai">✦</div>
    <div class="bubble-wrap">
      <div class="msg ai typing-dots"><span></span><span></span><span></span></div>
    </div>`;
  chatBox.appendChild(row);
  chatBox.scrollTop = chatBox.scrollHeight;
  return row.id;
}
function hideTyping(id) {
  document.getElementById(id)?.remove();
}

// ===== 17. Render a chat bubble =====
function appendMessage(sender, text, time, mood) {
  const row = document.createElement('div');
  row.className = `msg-row ${sender}`;

  const avatar = sender === 'user' ? (auth.currentUser?.email?.[0]?.toUpperCase() || 'Y') : '✦';
  const timeStr = time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const moodHtml = mood ? `<span class="mood-pill">${escapeHtml(mood)}</span>` : '';

  row.innerHTML = `
    <div class="avatar ${sender}">${avatar}</div>
    <div class="bubble-wrap">
      <div class="msg ${sender}">${escapeHtml(text)}</div>
      <div class="msg-meta">${timeStr} ${moodHtml}</div>
    </div>`;
  chatBox.appendChild(row);
  chatBox.scrollTop = chatBox.scrollHeight;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.innerText = str;
  return div.innerHTML;
}
