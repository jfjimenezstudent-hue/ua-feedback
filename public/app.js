"use strict";
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const levelColor = (a) => a >= 4.5 ? "var(--l5)" : a >= 3.5 ? "var(--l4)" : a >= 2.5 ? "var(--l3)" : a >= 1.5 ? "var(--l2)" : "var(--l1)";
const classify = (a) => a >= 4.5 ? "Excellent" : a >= 3.5 ? "Very Satisfactory" : a >= 2.5 ? "Satisfactory" : a >= 1.5 ? "Needs Improvement" : "Poor";
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const r2 = (n) => Math.round(n * 100) / 100;

/* ---------- Talking to the server ---------- */
async function api(path, body) {
  const opts = { credentials: "same-origin" };
  if (body !== undefined) {
    opts.method = "POST";
    opts.headers = { "Content-Type": "application/json" };
    opts.body = JSON.stringify(body);
  }
  let res;
  try { res = await fetch(path, opts); }
  catch (e) { throw new Error("Cannot reach the server. Check your internet connection and try again."); }
  let data = {};
  try { data = await res.json(); } catch (e) { /* no body */ }
  if (!res.ok) { const err = new Error(data.error || "Something went wrong."); err.status = res.status; throw err; }
  return data;
}
const setMsg = (sel, text, bad) => { const m = $(sel); m.textContent = text; m.className = "msg" + (bad ? " err" : ""); };

/* ---------- Tabs ---------- */
function show(tab) {
  $("#give").classList.toggle("hidden", tab !== "give");
  $("#admin").classList.toggle("hidden", tab !== "admin");
  $("#tab-give").setAttribute("aria-selected", tab === "give");
  $("#tab-admin").setAttribute("aria-selected", tab === "admin");
}
$("#tab-give").onclick = () => show("give");
$("#tab-admin").onclick = () => show("admin");

/* ---------- Feedback form ---------- */
let QUESTIONS = [];
let answers = [];

function buildScale(i, text, ends) {
  const d = document.createElement("div");
  d.className = "question";
  d.innerHTML = `<span class="q"></span><div class="scale" role="group"></div><div class="ends"><span>${ends[0]}</span><span>${ends[1]}</span></div>`;
  d.querySelector(".q").textContent = text;
  const g = d.querySelector(".scale");
  for (let v = 1; v <= 5; v++) {
    const b = document.createElement("button");
    b.type = "button"; b.textContent = v; b.setAttribute("aria-pressed", "false");
    b.setAttribute("aria-label", `${text} Rating ${v} of 5`);
    b.onclick = () => { answers[i] = v; [...g.children].forEach((c, j) => c.setAttribute("aria-pressed", j + 1 === v)); updateMeter(); };
    g.append(b);
  }
  $("#qs").append(d);
}

function updateMeter() {
  const got = answers.filter(Boolean);
  if (!got.length) { $("#avg").textContent = "–"; $("#level").textContent = "Rate to begin"; $("#barfill").style.width = "0"; return; }
  const a = r2(mean(got));
  $("#avg").textContent = a.toFixed(2);
  $("#level").textContent = classify(a);
  $("#level").style.color = $("#barfill").style.background = levelColor(a);
  $("#barfill").style.width = (a / 5 * 100) + "%";
}

function resetForm() {
  answers = new Array(QUESTIONS.length + 1).fill(0);
  $("#comment").value = "";
  document.querySelectorAll(".scale button").forEach((b) => b.setAttribute("aria-pressed", "false"));
  updateMeter();
}

$("#submit").onclick = async () => {
  if (answers.some((v) => !v)) return setMsg("#gmsg", "Please answer every rating question before submitting.", true);
  $("#submit").disabled = true;
  try {
    const r = await api("/api/feedback", { office: $("#office").value, overall: answers[0], answers: answers.slice(1), comment: $("#comment").value.trim() });
    setMsg("#gmsg", `Thank you. Your average rating was ${r.average.toFixed(2)} (${r.level}). Your feedback was saved encrypted.`);
    resetForm();
  } catch (e) {
    if (e.status === 401) { showStudent(null); setMsg("#smsg", "Your session ended. Please log in again.", true); }
    else setMsg("#gmsg", e.message, true);
  } finally { $("#submit").disabled = false; }
};

/* ---------- Student account ---------- */
let sMode = "login";
function sSet(m) {
  sMode = m;
  const reg = m === "register";
  $("#sTitle").textContent = reg ? "Create student account" : "Student login";
  $("#sgo").textContent = reg ? "Create account" : "Log in";
  $("#sswitch").textContent = reg ? "Back to login" : "Create student account";
  $("#sconfirm").classList.toggle("hidden", !reg);
  $("#spw").autocomplete = reg ? "new-password" : "current-password";
  setMsg("#smsg", "");
}
function showStudent(name) {
  $("#sgate").classList.toggle("hidden", !!name);
  $("#sform").classList.toggle("hidden", !name);
  if (name) { $("#swho").textContent = "Logged in as " + name; setMsg("#gmsg", ""); resetForm(); }
  else sSet("login");
}
$("#sswitch").onclick = () => sSet(sMode === "login" ? "register" : "login");
$("#sgo").onclick = async () => {
  const studentId = $("#sid").value.trim(), password = $("#spw").value;
  if (sMode === "register" && password !== $("#spw2").value) return setMsg("#smsg", "Passwords do not match.", true);
  $("#sgo").disabled = true;
  try {
    const r = await api(sMode === "register" ? "/api/student/register" : "/api/student/login", { studentId, password });
    $("#sid").value = $("#spw").value = $("#spw2").value = "";
    showStudent(r.name);
  } catch (e) { setMsg("#smsg", e.message, true); }
  finally { $("#sgo").disabled = false; }
};
$("#slogout").onclick = async () => { try { await api("/api/student/logout", {}); } catch (e) { /* ignore */ } showStudent(null); };

/* ---------- Administrator ---------- */
function showAdmin(name) {
  $("#auth").classList.toggle("hidden", !!name);
  $("#dash").classList.toggle("hidden", !name);
  if (name) loadDash(); else setMsg("#amsg", "");
}
$("#login").onclick = async () => {
  $("#login").disabled = true;
  try {
    await api("/api/admin/login", { username: $("#u").value.trim(), password: $("#p").value });
    $("#u").value = $("#p").value = "";
    showAdmin(true);
  } catch (e) { setMsg("#amsg", e.message, true); }
  finally { $("#login").disabled = false; }
};
$("#logout").onclick = async () => { try { await api("/api/admin/logout", {}); } catch (e) { /* ignore */ } showAdmin(null); };
$("#addAdmin").onclick = () => { $("#adminForm").classList.toggle("hidden"); setMsg("#nmsg", ""); };
$("#createAdmin").onclick = async () => {
  try {
    const r = await api("/api/admin/create", { username: $("#nu").value.trim(), password: $("#np").value });
    $("#nu").value = $("#np").value = "";
    setMsg("#nmsg", `Administrator “${r.name}” created.`);
  } catch (e) { setMsg("#nmsg", e.message, true); if (e.status === 401) showAdmin(null); }
};

async function loadDash() {
  $("#detail").classList.add("hidden");
  const box = $("#summary");
  try {
    const d = await api("/api/admin/summary");
    if (!d.total.count) { box.innerHTML = "<p class='msg'>No feedback yet. Responses appear here after students submit the form.</p>"; return; }
    const row = (name, count, avg, level, click) =>
      `<tr ${click ? `class="click" tabindex="0" data-o="${encodeURIComponent(name)}"` : ""}><td>${click ? "" : "<b>"}${esc(name)}${click ? "" : "</b>"}</td><td>${count}</td><td>${avg.toFixed(2)}</td><td style="color:${levelColor(avg)};font-weight:700">${esc(level)}</td></tr>`;
    box.innerHTML = `<table><thead><tr><th>Office</th><th>Responses</th><th>Average</th><th>Classification</th></tr></thead><tbody>` +
      d.offices.map((o) => row(o.office, o.count, o.average, o.level, true)).join("") +
      row("All offices", d.total.count, d.total.average, d.total.level, false) +
      `</tbody></table><p class="msg">Select an office for details.</p>`;
    box.querySelectorAll("tr.click").forEach((tr) => {
      const go = () => loadDetail(decodeURIComponent(tr.dataset.o));
      tr.onclick = go; tr.onkeydown = (e) => { if (e.key === "Enter") go(); };
    });
  } catch (e) {
    if (e.status === 401) { showAdmin(null); setMsg("#amsg", "Your session ended. Please log in again.", true); }
    else box.innerHTML = `<p class="msg err">${esc(e.message)}</p>`;
  }
}

async function loadDetail(office) {
  const d = $("#detail");
  try {
    const x = await api("/api/admin/office?name=" + encodeURIComponent(office));
    const qs = x.questions.map((q) => `<tr><td style="white-space:normal">${esc(q.question)}</td><td>${q.mean.toFixed(2)}</td></tr>`).join("");
    const dist = x.distribution.map((l) => `<tr><td>${esc(l.level)}</td><td>${l.count}</td></tr>`).join("");
    const cm = x.comments.map((c) => `<div class="cm">${esc(c.comment)}<br><small>${new Date(c.t).toLocaleString()} · average ${c.average.toFixed(2)}</small></div>`).join("") || "<p class='msg'>No comments.</p>";
    d.classList.remove("hidden");
    d.innerHTML = `<h2>${esc(x.office)} (${x.count} responses)</h2><p>Mean overall rating: <b>${x.overall.toFixed(2)}</b></p>
      <div class="tablewrap"><table><thead><tr><th>Question</th><th>Mean</th></tr></thead><tbody>${qs}</tbody></table></div>
      <div class="tablewrap" style="margin-top:12px"><table><thead><tr><th>Classification</th><th>Count</th></tr></thead><tbody>${dist}</tbody></table></div>
      <h2 style="margin-top:18px">Comments</h2>${cm}`;
    d.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (e) { d.classList.remove("hidden"); d.innerHTML = `<p class="msg err">${esc(e.message)}</p>`; }
}

/* ---------- Start up ---------- */
(async function init() {
  try {
    const cfg = await api("/api/config");
    QUESTIONS = cfg.questions;
    cfg.offices.forEach((o) => { const e = document.createElement("option"); e.textContent = o; $("#office").append(e); });
    buildScale(0, "Overall rating", ["Poor", "Excellent"]);
    QUESTIONS.forEach((q, i) => buildScale(i + 1, q, ["Very dissatisfied", "Very satisfied"]));
    answers = new Array(QUESTIONS.length + 1).fill(0);
    const me = await api("/api/me");
    showStudent(me.student);
    if (me.admin) showAdmin(true);
  } catch (e) {
    setMsg("#smsg", e.message, true);
  }
})();

/* ---------- App features: background, install, QR, offline ---------- */
(function () {
  const img = new Image();
  img.onload = () => document.body.classList.add("has-bg");
  img.src = "background.jpg";

  let deferred;
  window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); deferred = e; $("#install").classList.add("show"); });
  $("#install").onclick = async () => { if (!deferred) return; deferred.prompt(); await deferred.userChoice; deferred = null; $("#install").classList.remove("show"); };
  window.addEventListener("appinstalled", () => $("#install").classList.remove("show"));
  if ("serviceWorker" in navigator && location.protocol.startsWith("http")) navigator.serviceWorker.register("sw.js").catch(() => {});

  const url = location.origin + "/";
  const online = /^https?:$/.test(location.protocol) && !/^(localhost|127\.0\.0\.1)$/.test(location.hostname);
  const cv = $("#qr"), note = $("#qrnote");
  if (!online) {
    $("#share").querySelector(".row").classList.add("hidden");
    note.textContent = "The QR code appears here once the site is online at its https:// address.";
    return;
  }
  try { drawQR(cv, makeQR(url), 6); note.textContent = "Scan to open: " + url; }
  catch (e) { note.textContent = "Link: " + url; }
  $("#copyLink").onclick = async () => { try { await navigator.clipboard.writeText(url); note.textContent = "Link copied."; } catch (e) { note.textContent = "Copy this link: " + url; } };
  $("#saveQr").onclick = () => { const a = document.createElement("a"); a.href = cv.toDataURL("image/png"); a.download = "ua-feedback-qr.png"; a.click(); };
})();
