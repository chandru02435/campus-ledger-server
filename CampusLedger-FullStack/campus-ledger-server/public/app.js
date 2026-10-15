'use strict';
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = p => '₹' + (p / 100).toLocaleString('en-IN');
const today = () => new Date(Date.now() - new Date().getTimezoneOffset() * 6e4).toISOString().slice(0, 10);
const when = t => new Date(t).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
const STATUS = { P: 'Present', A: 'Absent', L: 'Late', E: 'Excused' };

/* ---- original artwork drawn in code (no third-party images) ---- */
(function () {
  let cols = '', win = '', trees = '';
  for (let i = 0; i < 8; i++) cols += `<rect x="${272 + i * 36}" y="392" width="12" height="88" rx="2"/>`;
  for (let i = 0; i < 5; i++) win += `<circle cx="${320 + i * 40}" cy="372" r="5"/>`;
  [[90, 470, 34], [150, 480, 26], [650, 472, 36], [715, 484, 26], [40, 486, 22]].forEach(t => trees += `<rect x="${t[0] - 3}" y="${t[1]}" width="6" height="30"/><circle cx="${t[0]}" cy="${t[1] - 6}" r="${t[2]}"/>`);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 600" preserveAspectRatio="xMidYMax slice"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0a1630"/><stop offset=".55" stop-color="#2a4584"/><stop offset="1" stop-color="#e9a43a"/></linearGradient></defs>
 <rect width="800" height="600" fill="url(#g)"/><circle cx="620" cy="350" r="72" fill="#ffd98a" opacity=".5"/><circle cx="620" cy="350" r="44" fill="#ffe9b8" opacity=".6"/>
 <path d="M0 440Q200 380 400 435T800 415V600H0Z" fill="#1b3366" opacity=".85"/>
 <g fill="#0d1b3b"><rect x="250" y="360" width="300" height="130"/><path d="M228 362L400 292L572 362Z"/><rect x="372" y="212" width="56" height="82"/><path d="M366 214L400 176L434 214Z"/><rect x="200" y="400" width="52" height="90"/><rect x="548" y="400" width="52" height="90"/></g>
 <g fill="#2f4d91">${cols}</g><g fill="#ffd98a">${win}<circle cx="400" cy="245" r="14"/></g>
 <path d="M0 490Q250 450 500 492T800 480V600H0Z" fill="#0b1630"/><g fill="#0e1f44">${trees}</g></svg>`;
  document.documentElement.style.setProperty('--hero', 'url("data:image/svg+xml,' + encodeURIComponent(svg) + '")');
})();
const BOOK = '<svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linejoin="round"><path d="M8 14h20a4 4 0 0 1 4 4v32a4 4 0 0 0-4-4H8zM56 14H36a4 4 0 0 0-4 4v32a4 4 0 0 1 4-4h20z"/></svg>';
const empty = (m, a = '') => `<div class="empty">${BOOK}<p>${m}</p>${a}</div>`;

/* ---- talking to the server. Every rule is enforced there; this page only displays results. ---- */
async function api(method, path, body) {
  let r;
  try {
    r = await fetch('/api/v1' + path, { method, credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'CampusLedger' }, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch (e) { throw Object.assign(new Error('Cannot reach the server. Check your internet connection.'), { status: 0 }); }
  let j = null; try { j = await r.json(); } catch (e) { /* no body */ }
  if (!r.ok) throw Object.assign(new Error((j && j.error && j.error.message) || 'Something went wrong. Please try again.'), { status: r.status, code: j && j.error && j.error.code });
  return j ? j.data : null;
}

let INFO = { college: 'Campus Ledger', needsSetup: false }, ME = null, role = 'admin', view = '', D = null, LOADERR = '', q = '';
let flt = { sub: 'All', st: 'All' }, ui = { grp: '', sub: 0, date: today(), marks: {} };

function toast(m) { const t = document.createElement('div'); t.className = 'toast'; t.textContent = m; document.body.append(t); setTimeout(() => t.remove(), 3000); }
function closeM() { const m = $('#mod'); if (m) m.remove(); }
function modal(h) { closeM(); const m = document.createElement('div'); m.className = 'modal'; m.id = 'mod'; m.innerHTML = '<div class="panel" role="dialog" aria-modal="true">' + h + '</div>'; m.onclick = e => { if (e.target === m) m.remove(); }; document.body.append(m); const i = m.querySelector('input:not([disabled]),select'); if (i) i.focus(); }
const fld = (id, l, v = '', t = 'text', x = '') => `<div class="f"><label for="${id}">${l}</label><input id="${id}" type="${t}" value="${esc(v)}" ${x}></div>`;
const btns = (ok, fn) => `<div class="row"><button class="btn pri" onclick="${fn}">${ok}</button><button class="btn" onclick="closeM()">Cancel</button></div>`;
const toPaise = v => Math.round(parseFloat(v) * 100);
const stTag = s => `<span class="tag ${s === 'Paid' ? 'ok' : s === 'Overdue' ? 'bad' : 'warn'}">${s}</span>`;
const bar = (v, min) => `<div class="bar" role="img" aria-label="${v} percent"><i class="${v < min ? 'low' : ''}" style="width:${v}%"></i></div>`;

// Runs a button action. Errors appear in the form's error line (errId) or as a toast; expired sessions go back to sign-in.
async function run(fn, errId = 'fe') {
  try { return await fn(); } catch (e) {
    if (e.status === 401 && ME) { ME = null; D = null; render(); toast('Your session has ended. Please sign in again.'); return; }
    if (e.code === 'PASSWORD_CHANGE_REQUIRED' && ME) { ME.mustChangePassword = true; view = 'force'; render(); return; }
    const el = $('#' + errId) || $('#err');
    if (el) el.textContent = e.message; else toast(e.message);
  }
}

/* ---- page data: each screen asks the server for exactly what it shows ---- */
async function loadAtt() {
  const [subjects, students] = await Promise.all([api('GET', '/admin/subjects'), api('GET', '/admin/students')]);
  if (!subjects.find(s => s.id === ui.sub)) ui.sub = subjects[0] ? subjects[0].id : 0;
  const existing = {};
  if (ui.sub) (await api('GET', `/admin/attendance?subjectId=${ui.sub}&date=${ui.date}`)).forEach(m => { existing[m.studentId] = m.status; });
  return { subjects, students, existing };
}
const LOAD = {
  dash: () => api('GET', '/admin/overview'),
  stu: () => api('GET', '/admin/students').then(students => ({ students })),
  att: loadAtt,
  fee: () => api('GET', '/admin/fees'),
  ann: () => api('GET', '/admin/announcements').then(items => ({ items })),
  aud: () => api('GET', '/admin/audit').then(items => ({ items })),
  set: () => api('GET', '/admin/settings'),
  home: async () => { const d = await api('GET', '/me/overview'); ME.unread = d.announcements.unread; return d; },
  satt: () => api('GET', '/me/attendance'),
  sfee: () => api('GET', '/me/fees'),
  sann: async () => { const d = await api('GET', '/me/announcements'); setTimeout(() => api('POST', '/me/announcements/read').then(() => { ME.unread = 0; }).catch(() => {}), 600); return d; },
  sme: () => api('GET', '/me/profile'),
};
async function go(v) {
  view = v; D = null;
  if (v === 'force') { render(); return; }
  const m = $('main'); if (m) m.innerHTML = '<p class="muted">Loading…</p>';
  try { D = await LOAD[v](); LOADERR = ''; } catch (e) {
    if (e.status === 401) { ME = null; render(); return; }
    if (e.code === 'PASSWORD_CHANGE_REQUIRED') { ME.mustChangePassword = true; view = 'force'; render(); return; }
    LOADERR = e.message;
  }
  render(); scrollTo(0, 0);
}
const reload = () => go(view);

/* ---- sign in ---- */
function renderLogin() {
  const adm = role === 'admin', first = INFO.needsSetup;
  let form;
  if (adm && first) form = `<p class="muted" style="margin:0 0 12px">First time here? Create the administrator account for your college.</p>${fld('ac', 'College name', '', 'text', 'autocomplete="organization"')}${fld('an', 'Your name')}${fld('ae', 'Email', '', 'email', 'autocomplete="username"')}${fld('ap', 'Password (8+ characters, with a number)', '', 'password', 'autocomplete="new-password"')}${fld('ap2', 'Confirm password', '', 'password', 'autocomplete="new-password" onkeydown="event.key===\'Enter\'&&setupAdmin()"')}<div class="err" id="err" role="alert"></div><button class="btn pri" style="width:100%" onclick="setupAdmin()">Create admin account</button>`;
  else if (adm) form = `${fld('ae', 'Email', '', 'email', 'autocomplete="username"')}${fld('ap', 'Password', '', 'password', 'autocomplete="current-password" onkeydown="event.key===\'Enter\'&&loginAdmin()"')}<div class="err" id="err" role="alert"></div><button class="btn pri" style="width:100%" onclick="loginAdmin()">Sign in as admin</button>`;
  else form = `${fld('id', 'Enrollment number', '', 'text', 'autocomplete="username" autocapitalize="characters"')}${fld('ap', 'Password', '', 'password', 'autocomplete="current-password" onkeydown="event.key===\'Enter\'&&loginStudent()"')}<div class="err" id="err" role="alert"></div><button class="btn pri" style="width:100%" onclick="loginStudent()">Sign in as student</button><p class="hint">Your enrollment number and first password come from the college office.</p>`;
  $('#app').innerHTML = `<div class="wrap"><div class="login"><h1>${esc(INFO.college)}</h1><p class="lead" style="margin:2px 0 0">Attendance and fee portal</p>
 <div class="tabs" role="tablist"><button class="${adm ? 'on' : ''}" onclick="role='admin';render()">Admin</button><button class="${adm ? '' : 'on'}" onclick="role='student';render()">Student</button></div>${form}</div></div>`;
}
const setupAdmin = () => run(async () => {
  if ($('#ap').value !== $('#ap2').value) return $('#err').textContent = 'Passwords do not match.';
  const college = $('#ac').value;
  ME = await api('POST', '/setup', { college, name: $('#an').value, email: $('#ae').value, password: $('#ap').value });
  INFO = { college: college.trim(), needsSetup: false }; await enter();
}, 'err');
const loginAdmin = () => run(async () => { ME = await api('POST', '/auth/login', { portal: 'admin', identifier: $('#ae').value, password: $('#ap').value }); await enter(); }, 'err');
const loginStudent = () => run(async () => { ME = await api('POST', '/auth/login', { portal: 'student', identifier: $('#id').value, password: $('#ap').value }); await enter(); }, 'err');
const enter = () => go(ME.role === 'ADMIN' ? 'dash' : ME.mustChangePassword ? 'force' : 'home');
async function logout() { try { await api('POST', '/auth/logout'); } catch (e) { /* already signed out */ } ME = null; D = null; q = ''; try { INFO = await api('GET', '/public/info'); } catch (e) { /* keep old */ } render(); }

/* ---- shell ---- */
function render() {
  if (!ME) return renderLogin();
  const adm = ME.role === 'ADMIN';
  let tabs = [], body;
  if (view === 'force') body = `<div class="panel"><h3>Choose a new password</h3><p class="muted">Your first password was set by the college office. Choose your own to continue.</p>${pwForm()}</div>`;
  else {
    tabs = adm ? [['dash', 'Dashboard'], ['stu', 'Students'], ['att', 'Attendance'], ['fee', 'Fees'], ['ann', 'Announcements'], ['aud', 'Audit log'], ['set', 'Settings']]
      : [['home', 'Overview'], ['satt', 'Attendance'], ['sfee', 'Fees'], ['sann', 'Announcements' + (ME.unread ? `<span class="dot">${ME.unread}</span>` : '')], ['sme', 'Profile']];
    body = D === null ? `<div class="panel">${empty(esc(LOADERR || 'Loading…'), LOADERR ? '<button class="btn" onclick="reload()">Try again</button>' : '')}</div>`
      : { dash, stu, att: attAdmin, fee: feeAdmin, ann: annAdmin, aud, set: settings, home: sHome, satt: sAtt, sfee: sFees, sann: sAnn, sme: sProf }[view]();
  }
  $('#app').innerHTML = `<header class="top"><h2>${esc(INFO.college)}</h2><span class="who">${esc(ME.name)}${adm ? ' (admin)' : ' · ' + esc(ME.loginId)}</span><button class="btn sm" onclick="logout()">Sign out</button></header>
 ${tabs.length ? `<nav>${tabs.map(t => `<button class="${view === t[0] ? 'on' : ''}" onclick="go('${t[0]}')">${t[1]}</button>`).join('')}</nav>` : ''}<main>${body}</main>`;
}

/* ---- admin: dashboard ---- */
function dash() {
  if (!D.activeStudents) return `<div class="panel">${empty('Welcome. Start by adding your subjects, fee heads and students.', `<div class="row" style="justify-content:center"><button class="btn pri" onclick="go('stu').then(()=>stuForm())">Add a student</button><button class="btn" onclick="go('att')">Add subjects</button><button class="btn" onclick="go('fee')">Set up fees</button></div>`)}</div>`;
  return `<div class="grid"><div class="stat"><b>${D.activeStudents}</b><span>Active students</span></div><div class="stat"><b>${D.averageAttendance === null ? '-' : D.averageAttendance + '%'}</b><span>Average attendance</span></div>
 <div class="stat"><b>${fmt(D.collected)}</b><span>Fees collected</span></div><div class="stat"><b>${fmt(D.outstanding)}</b><span>Outstanding balance</span></div></div>
 <div class="panel"><h3>Attendance by subject</h3>${D.subjectAverages.map(s => `<div class="row" style="flex-wrap:nowrap"><span style="width:140px">${esc(s.subject)}</span>${bar(s.average, D.minAttendance)}<b style="width:44px;text-align:right">${s.average}%</b></div>`).join('') || '<p class="muted">No attendance has been marked yet.</p>'}</div>
 <div class="panel"><h3>Needs attention</h3>${D.needsAttention.length ? `<div class="scroll"><table><tr><th>Student</th><th>Attendance</th><th>Fee balance</th></tr>${D.needsAttention.map(s => `<tr><td>${esc(s.name)}</td><td><span class="tag bad">${s.attendance}%</span></td><td>${fmt(s.balance)}</td></tr>`).join('')}</table></div>` : `<p class="muted">No students are below ${D.minAttendance}%.</p>`}</div>
 <div class="panel"><h3>Recent activity</h3>${D.recent.map(a => `<p style="margin:4px 0"><span class="muted">${when(a.at)}</span> ${esc(a.text)}</p>`).join('')}</div>`;
}

/* ---- admin: students ---- */
function stu() {
  const l = D.students.filter(s => (s.name + s.enrollmentNo).toLowerCase().includes(q.toLowerCase()));
  return `<div class="row"><input placeholder="Search name or enrollment no." value="${esc(q)}" style="flex:1;min-width:200px" oninput="q=this.value;render();const i=document.querySelector('main input');i.focus();i.setSelectionRange(q.length,q.length)" aria-label="Search students"><button class="btn pri" onclick="stuForm()">Add student</button></div>
 <div class="panel scroll">${D.students.length ? `<table><tr><th>Enrollment no.</th><th>Name</th><th>Class</th><th>Status</th><th></th></tr>${l.map(s => `<tr><td>${esc(s.enrollmentNo)}</td><td>${esc(s.name)}</td><td>${esc(s.course)} · Sem ${s.semester}${s.section ? ' · ' + esc(s.section) : ''}</td><td><span class="tag ${s.active ? 'ok' : 'bad'}">${s.active ? 'Active' : 'Inactive'}</span></td>
 <td style="white-space:nowrap"><button class="btn sm" onclick="stuForm(${s.id})">Edit</button> <button class="btn sm" onclick="resetForm(${s.id})">Reset password</button> <button class="btn sm" onclick="toggle(${s.id},${!s.active})">${s.active ? 'Deactivate' : 'Activate'}</button></td></tr>`).join('') || '<tr><td colspan="5" class="muted">No students match your search.</td></tr>'}</table>` : empty('No students yet.', '<button class="btn pri" onclick="stuForm()">Add the first student</button>')}</div>`;
}
const genPw = () => Math.random().toString(36).slice(2, 6) + (10 + Math.floor(Math.random() * 90));
function stuForm(id) {
  const s = id ? D.students.find(x => x.id === id) : {};
  modal(`<h3>${id ? 'Edit' : 'Add'} student</h3>${fld('sn', 'Full name', s.name)}${fld('se', 'Enrollment no.', s.enrollmentNo, 'text', id ? 'disabled' : 'autocapitalize="characters"')}${fld('sc', 'Course (for example B.E. Computer Science)', s.course)}
 <div class="two">${fld('ss', 'Semester', s.semester || 1, 'number', 'min="1" max="12"')}${fld('sx', 'Section', s.section ?? 'A')}</div>${fld('sp', 'Phone (optional)', s.phone, 'tel')}${id ? '' : fld('spw', 'First password (student must change it)', genPw())}<div class="err" id="fe" role="alert"></div>${btns('Save student', `saveStu(${id || 0})`)}`);
}
const saveStu = id => run(async () => {
  const b = { name: $('#sn').value, course: $('#sc').value, semester: parseInt($('#ss').value), section: $('#sx').value, phone: $('#sp').value };
  if (id) { await api('PATCH', '/admin/students/' + id, b); closeM(); toast('Student updated'); await reload(); return; }
  b.enrollmentNo = $('#se').value; b.firstPassword = $('#spw').value;
  const s = await api('POST', '/admin/students', b);
  modal(`<h3>Student added</h3><p>Give these login details to ${esc(s.name)}:</p><div class="creds">Enrollment no.: <b>${esc(s.enrollmentNo)}</b><br>First password: <b>${esc(b.firstPassword)}</b></div><p class="note muted">The password is not shown again. You can reset it later.</p><button class="btn pri" onclick="closeM()">Done</button>`);
  await reload();
});
const toggle = (id, active) => run(async () => { await api('POST', `/admin/students/${id}/active`, { active }); await reload(); });
function resetForm(id) { const s = D.students.find(x => x.id === id); modal(`<h3>Reset password</h3><p class="muted">${esc(s.name)} · ${esc(s.enrollmentNo)}</p>${fld('rp', 'New first password', genPw())}<div class="err" id="fe" role="alert"></div>${btns('Reset password', `doReset(${id})`)}`); }
const doReset = id => run(async () => {
  const s = D.students.find(x => x.id === id), p = $('#rp').value;
  await api('POST', `/admin/students/${id}/reset-password`, { password: p });
  modal(`<h3>Password reset</h3><div class="creds">Enrollment no.: <b>${esc(s.enrollmentNo)}</b><br>New password: <b>${esc(p)}</b></div><p class="note muted">The student is signed out and must choose a new password at next sign-in.</p><button class="btn pri" onclick="closeM()">Done</button>`);
});

/* ---- admin: attendance ---- */
const grpOf = s => `${s.course} · Sem ${s.semester}${s.section ? ' · ' + s.section : ''}`;
function attAdmin() {
  const act = D.students.filter(s => s.active), groups = [...new Set(act.map(grpOf))];
  const head = `<div class="row sp"><h3>Mark attendance</h3><button class="btn sm" onclick="subForm()">Add subject</button></div>`;
  if (!D.subjects.length) return `<div class="panel">${head}${empty('Add at least one subject to start marking attendance.', '<button class="btn pri" onclick="subForm()">Add a subject</button>')}</div>`;
  if (!act.length) return `<div class="panel">${head}${empty('Add students first.', `<button class="btn pri" onclick="go('stu')">Go to students</button>`)}</div>`;
  if (!groups.includes(ui.grp)) ui.grp = groups[0];
  const list = act.filter(s => grpOf(s) === ui.grp), mk = s => ui.marks[s.id] || D.existing[s.id] || 'P', exists = list.some(s => D.existing[s.id]);
  return `<div class="panel">${head}<div class="row"><div style="flex:1;min-width:180px"><label for="gr">Class</label><select id="gr" onchange="ui.grp=this.value;render()">${groups.map(g => `<option ${g === ui.grp ? 'selected' : ''}>${esc(g)}</option>`).join('')}</select></div>
 <div style="flex:1;min-width:150px"><label for="sb">Subject</label><select id="sb" onchange="ui.sub=+this.value;ui.marks={};go('att')">${D.subjects.map(g => `<option value="${g.id}" ${g.id === ui.sub ? 'selected' : ''}>${esc(g.name)}</option>`).join('')}</select></div>
 <div style="min-width:150px"><label for="dt">Date</label><input id="dt" type="date" value="${ui.date}" max="${today()}" onchange="if(this.value){ui.date=this.value;ui.marks={};go('att')}"></div></div>
 ${exists ? '<p class="tag warn">Attendance already exists for this date. Saving will correct it, and the change is logged.</p>' : ''}
 <button class="btn sm" onclick="markAll()" style="margin-bottom:8px">Mark all present</button>
 <div class="scroll"><table><tr><th>Student</th><th>Status</th></tr>${list.map(s => `<tr><td>${esc(s.name)}<br><span class="muted">${esc(s.enrollmentNo)}</span></td><td><div class="seg">${Object.keys(STATUS).map(k => `<button class="${mk(s) === k ? 'on' : ''}" onclick="ui.marks[${s.id}]='${k}';render()" aria-label="${STATUS[k]}" title="${STATUS[k]}">${k}</button>`).join('')}</div></td></tr>`).join('')}</table></div>
 <p class="note muted">P present · A absent · L late · E excused (not counted in the percentage)</p><div class="err" id="fe" role="alert"></div><button class="btn pri" onclick="saveAtt()">Save attendance</button></div>`;
}
function markAll() { D.students.filter(s => s.active && grpOf(s) === ui.grp).forEach(s => { ui.marks[s.id] = 'P'; }); render(); }
const subForm = () => modal(`<h3>Add subject</h3>${fld('sb1', 'Subject name')}<div class="err" id="fe" role="alert"></div>${btns('Save subject', 'saveSub()')}`);
const saveSub = () => run(async () => { await api('POST', '/admin/subjects', { name: $('#sb1').value }); closeM(); await reload(); });
const saveAtt = () => run(async () => {
  const list = D.students.filter(s => s.active && grpOf(s) === ui.grp);
  const r = await api('POST', '/admin/attendance', { subjectId: ui.sub, date: ui.date, marks: list.map(s => ({ studentId: s.id, status: ui.marks[s.id] || D.existing[s.id] || 'P' })) });
  toast(r.corrected ? `Saved. ${r.corrected} correction(s) logged.` : 'Attendance saved'); ui.marks = {}; await reload();
});

/* ---- admin: fees ---- */
function feeAdmin() {
  return `<div class="panel scroll"><div class="row sp"><h3>Fee structure</h3><button class="btn pri sm" onclick="headForm()">Add fee head</button></div>
 ${D.heads.length ? `<table><tr><th>Fee head</th><th>Amount</th><th>Due date</th><th></th></tr>${D.heads.map(h => `<tr><td>${esc(h.name)}</td><td>${fmt(h.amountPaise)}</td><td>${h.dueDate}</td><td><button class="btn sm danger" onclick="rmHead(${h.id})">Remove</button></td></tr>`).join('')}</table><p class="note muted">Each fee head applies to every active student. Add scholarships with the Discount button.</p>` : empty('No fee heads yet. Add tuition, exam and other fees.')}</div>
 <div class="panel scroll"><h3>Student balances</h3>${D.balances.length && D.heads.length ? `<table><tr><th>Student</th><th>Total due</th><th>Paid</th><th>Balance</th><th></th></tr>${D.balances.map(b => `<tr><td>${esc(b.name)}<br><span class="muted">${esc(b.enrollmentNo)}</span></td><td>${fmt(b.net)}</td><td>${fmt(b.paid)}</td><td><b>${fmt(b.balance)}</b></td>
 <td style="white-space:nowrap">${b.balance ? `<button class="btn sm pri" onclick="payForm(${b.studentId})">Record payment</button> ` : '<span class="tag ok">Cleared</span> '}<button class="btn sm" onclick="discForm(${b.studentId})">Discount</button></td></tr>`).join('')}</table>` : '<p class="muted">Balances appear once you have students and fee heads.</p>'}</div>
 <div class="panel scroll"><h3>Recent payments</h3>${D.payments.length ? `<table><tr><th>Date</th><th>Receipt</th><th>Student</th><th>Amount</th><th></th></tr>${D.payments.map(p => `<tr><td>${p.date}</td><td>${p.receiptNo}</td><td>${esc(p.studentName)}</td><td>${fmt(p.amount)}</td><td><button class="btn sm" onclick="receipt(${p.id})">Receipt</button></td></tr>`).join('')}</table>` : '<p class="muted">No payments recorded yet.</p>'}
 <p class="note muted">Payments are never edited or deleted, so the money trail stays reliable.</p></div>`;
}
const headForm = () => modal(`<h3>Add fee head</h3>${fld('hn', 'Name (for example Tuition fee)')}${fld('ha', 'Amount (₹)', '', 'number', 'min="1" step="0.01"')}${fld('hd', 'Due date', '', 'date')}<div class="err" id="fe" role="alert"></div>${btns('Save fee head', 'saveHead()')}`);
const saveHead = () => run(async () => { await api('POST', '/admin/fee-heads', { name: $('#hn').value, amountPaise: toPaise($('#ha').value), dueDate: $('#hd').value }); closeM(); await reload(); });
const rmHead = id => run(async () => { await api('DELETE', '/admin/fee-heads/' + id); await reload(); }, 'none');
function payForm(id) {
  const b = D.balances.find(x => x.studentId === id);
  modal(`<h3>Record payment</h3><p class="muted">${esc(b.name)} · balance ${fmt(b.balance)}</p>${fld('am', 'Amount (₹)', '', 'number', 'min="1" step="0.01"')}
 <div class="f"><label for="md">Method</label><select id="md"><option>Cash</option><option>UPI</option><option>Bank transfer</option><option>Card</option><option>Cheque</option></select></div>${fld('rf', 'Reference (optional)')}<div class="err" id="fe" role="alert"></div>${btns('Save payment', `pay(${id})`)}`);
}
const pay = id => run(async () => {
  const r = await api('POST', '/admin/payments', { studentId: id, amountPaise: toPaise($('#am').value), method: $('#md').value, reference: $('#rf').value });
  closeM(); await reload(); await receipt(r.id);
});
function discForm(id) {
  const b = D.balances.find(x => x.studentId === id);
  if (!D.heads.length) return toast('Add a fee head first.');
  modal(`<h3>Discount or scholarship</h3><p class="muted">${esc(b.name)}</p><div class="f"><label for="dh">Fee head</label><select id="dh">${D.heads.map(h => `<option value="${h.id}">${esc(h.name)} (${fmt(h.amountPaise)})</option>`).join('')}</select></div>${fld('dv', 'Discount amount (₹, 0 clears it)', '0', 'number', 'min="0" step="0.01"')}${fld('dr', 'Reason (optional)')}<div class="err" id="fe" role="alert"></div>${btns('Save discount', `saveDisc(${id})`)}`);
}
const saveDisc = id => run(async () => { await api('PUT', `/admin/students/${id}/discounts`, { feeHeadId: +$('#dh').value, amountPaise: toPaise($('#dv').value), reason: $('#dr').value }); closeM(); toast('Discount saved'); await reload(); });
const receipt = id => run(async () => {
  const p = await api('GET', '/payments/' + id);
  modal(`<h3>Fee receipt</h3><p class="muted">${esc(p.college)} · ${p.receiptNo} · ${p.date}</p><p><b>${esc(p.student.name)}</b><br>${esc(p.student.enrollmentNo)} · ${esc(p.student.course)}</p>
 <table style="min-width:0"><tr><td>Amount received</td><td><b>${fmt(p.amount)}</b></td></tr><tr><td>Method</td><td>${esc(p.method)}</td></tr><tr><td>Reference</td><td>${esc(p.reference || '-')}</td></tr></table>
 <div class="row noprint" style="margin-top:14px"><button class="btn pri" onclick="doPrint()">Print or save as PDF</button><button class="btn" onclick="closeM()">Close</button></div>`);
}, 'none');

/* ---- admin: announcements, audit, settings ---- */
const annAdmin = () => `<div class="row sp"><h3>Announcements</h3><button class="btn pri" onclick="annForm()">New announcement</button></div><div class="panel">${D.items.length ? D.items.map(a => `<div class="ann"><b>${esc(a.title)}</b><p class="muted">${a.date}</p><p>${esc(a.body)}</p><button class="btn sm danger" onclick="rmAnn(${a.id})">Delete</button></div>`).join('') : empty('No announcements yet. Students see announcements you post here.')}</div>`;
const annForm = () => modal(`<h3>New announcement</h3>${fld('at', 'Title')}<div class="f"><label for="ab">Message</label><textarea id="ab" rows="4"></textarea></div><div class="err" id="fe" role="alert"></div>${btns('Post announcement', 'saveAnn()')}`);
const saveAnn = () => run(async () => { await api('POST', '/admin/announcements', { title: $('#at').value, body: $('#ab').value }); closeM(); await reload(); });
const rmAnn = id => run(async () => { await api('DELETE', '/admin/announcements/' + id); await reload(); }, 'none');
const aud = () => `<div class="panel scroll"><h3>Audit log</h3><table><tr><th>Time</th><th>Actor</th><th>Action</th></tr>${D.items.map(a => `<tr><td>${when(a.at)}</td><td>${esc(a.actor)}</td><td>${esc(a.text)}</td></tr>`).join('')}</table></div>`;
const settings = () => `<div class="panel"><h3>College settings</h3>${fld('cn', 'College name', D.college)}${fld('cm', 'Minimum attendance (%)', D.minAttendance, 'number', 'min="50" max="100"')}<div class="err" id="e1" role="alert"></div><button class="btn pri" onclick="saveSet()">Save settings</button></div>
 <div class="panel"><h3>Change admin password</h3>${pwForm()}</div>`;
const saveSet = () => run(async () => { const r = await api('PUT', '/admin/settings', { college: $('#cn').value, minAttendance: parseInt($('#cm').value) }); INFO.college = r.college; toast('Settings saved'); await reload(); }, 'e1');

/* ---- password change (both roles) ---- */
const pwForm = () => `${fld('p0', 'Current password', '', 'password', 'autocomplete="current-password"')}${fld('p1', 'New password (8+ characters, with a number)', '', 'password', 'autocomplete="new-password"')}${fld('p2', 'Confirm new password', '', 'password', 'autocomplete="new-password"')}<div class="err" id="e2" role="alert"></div><button class="btn pri" onclick="savePw()">Update password</button>`;
const savePw = () => run(async () => {
  if ($('#p1').value !== $('#p2').value) return $('#e2').textContent = 'New passwords do not match.';
  await api('POST', '/auth/change-password', { currentPassword: $('#p0').value, newPassword: $('#p1').value });
  toast('Password updated');
  if (ME.mustChangePassword) { ME.mustChangePassword = false; await go('home'); } else await reload();
}, 'e2');

/* ---- student views (the server only ever returns the signed-in student's own records) ---- */
function advice(counted, attended, min) {
  const m = min / 100; if (!counted) return '';
  if (attended / counted < m) { const need = Math.ceil((m * counted - attended) / (1 - m)); return `<p class="note" style="color:var(--bad)">Attend the next ${need} ${need === 1 ? 'class' : 'classes'} in a row to reach ${min}%.</p>`; }
  const skip = Math.floor(attended / m - counted); return `<p class="note muted">You can miss ${skip} more ${skip === 1 ? 'class' : 'classes'} and stay at ${min}% or above.</p>`;
}
const annHtml = a => `<div class="ann ${a.read ? '' : 'new'}"><b>${esc(a.title)}</b> ${a.read ? '' : '<span class="tag ok">New</span>'}<p class="muted">${a.date}</p><p>${esc(a.body)}</p></div>`;
function sHome() {
  const a = D.attendance.average, min = D.minAttendance, f = D.fees, p = D.profile, C = 251.3, low = D.attendance.belowSubjects;
  return `<div class="hero"><div class="ring"><svg viewBox="0 0 100 100" width="110" height="110" role="img" aria-label="Overall attendance ${a === null ? 'not recorded' : a + ' percent'}"><circle cx="50" cy="50" r="40" fill="none" stroke="var(--line)" stroke-width="10"/>
 ${a === null ? '' : `<circle cx="50" cy="50" r="40" fill="none" stroke="${a < min ? 'var(--bad)' : 'var(--ok)'}" stroke-width="10" stroke-linecap="round" stroke-dasharray="${C * a / 100} ${C}" transform="rotate(-90 50 50)"/>`}</svg><b>${a === null ? '-' : a + '%'}</b></div>
 <div><h1>Hello, ${esc(p.name.split(' ')[0])}</h1><p class="lead" style="margin:0">${esc(p.course)} · Semester ${p.semester}${p.section ? ' · Section ' + esc(p.section) : ''}</p>
 <p style="margin:6px 0 0">${a === null ? '<span class="tag warn">No attendance recorded yet</span>' : low.length ? `<span class="tag bad">${low.length} ${low.length > 1 ? 'subjects' : 'subject'} below ${min}%</span>` : '<span class="tag ok">Attendance on track</span>'}</p></div></div>
 <div class="grid"><div class="stat"><b>${fmt(f.balance)}</b><span>Fee balance</span></div><div class="stat"><b>${fmt(f.paid)}</b><span>Paid of ${fmt(f.net)}</span></div><div class="stat"><b>${f.next ? f.next.dueDate : 'None'}</b><span>${f.next ? 'Next deadline: ' + esc(f.next.head) : 'No fees pending'}</span></div></div>
 ${low.length ? `<div class="panel" style="border-color:var(--bad)"><h3>Attendance warning</h3><p style="margin:0">Below ${min}%: ${low.map(esc).join(', ')}. Falling short may affect exam eligibility. <a href="#" onclick="go('satt');return false">See what you need</a>.</p></div>` : ''}
 ${f.next && f.next.status === 'Overdue' ? `<div class="panel" style="border-color:var(--bad)"><h3>Overdue fee</h3><p style="margin:0">${esc(f.next.head)}: ${fmt(f.next.balance)} was due on ${f.next.dueDate}. Visit the accounts office to pay.</p></div>` : ''}
 <div class="panel"><h3>Latest announcements</h3>${D.announcements.latest.length ? D.announcements.latest.map(annHtml).join('') + `<button class="btn sm" onclick="go('sann')">All announcements</button>` : '<p class="muted">No announcements yet.</p>'}</div>`;
}
function sAtt() {
  const min = D.minAttendance, subs = D.subjects;
  if (!subs.length) return `<div class="panel">${empty('No attendance has been recorded for you yet.')}</div>`;
  const rows = D.records.filter(r => (flt.sub === 'All' || flt.sub === r.subject) && (flt.st === 'All' || flt.st === r.status));
  return `<div class="subj">${subs.map(x => `<div class="panel"><div class="row sp" style="margin-bottom:6px"><b>${esc(x.subject)}</b><span class="tag ${x.percentage < min ? 'bad' : 'ok'}">${x.percentage}%</span></div>${bar(x.percentage, min)}<p class="note muted">${x.total} classes · ${x.attended} attended · ${x.missed} missed</p>${advice(x.counted, x.attended, min)}</div>`).join('')}</div>
 <div class="panel"><h3>Date-wise record</h3><div class="row"><div style="flex:1;min-width:160px"><label for="fs">Subject</label><select id="fs" onchange="flt.sub=this.value;render()">${['All', ...subs.map(s => s.subject)].map(x => `<option ${x === flt.sub ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select></div>
 <div style="flex:1;min-width:140px"><label for="ft">Status</label><select id="ft" onchange="flt.st=this.value;render()"><option value="All">All</option>${Object.entries(STATUS).map(([k, v]) => `<option value="${k}" ${k === flt.st ? 'selected' : ''}>${v}</option>`).join('')}</select></div></div>
 <div class="scroll"><table><tr><th>Date</th><th>Subject</th><th>Status</th></tr>${rows.map(r => `<tr><td>${r.date}</td><td>${esc(r.subject)}</td><td><span class="tag ${r.status === 'A' ? 'bad' : r.status === 'P' ? 'ok' : 'warn'}">${STATUS[r.status]}</span></td></tr>`).join('') || '<tr><td colspan="3" class="muted">No classes match these filters.</td></tr>'}</table></div></div>`;
}
function sFees() {
  const t = D.totals;
  if (!D.dues.length) return `<div class="panel">${empty('No fees have been set up for you yet.')}</div>`;
  return `<div class="grid"><div class="stat"><b>${fmt(t.net)}</b><span>Total fees</span></div><div class="stat"><b>${fmt(t.paid)}</b><span>Paid</span></div><div class="stat" style="border-left-color:${t.balance ? 'var(--bad)' : 'var(--ok)'}"><b>${fmt(t.balance)}</b><span>Outstanding balance</span></div></div>
 <div class="panel scroll"><h3>Fee structure</h3><table><tr><th>Fee head</th><th>Amount</th><th>Discount</th><th>Paid</th><th>Balance</th><th>Due date</th><th>Status</th></tr>
 ${D.dues.map(x => `<tr><td>${esc(x.head)}</td><td>${fmt(x.gross)}</td><td>${x.discount ? fmt(x.discount) : '-'}</td><td>${fmt(x.paid)}</td><td>${fmt(x.balance)}</td><td>${x.dueDate}</td><td>${stTag(x.status)}</td></tr>`).join('')}</table></div>
 <div class="panel scroll"><h3>Payment history</h3>${D.payments.length ? `<table><tr><th>Date</th><th>Receipt</th><th>Reference</th><th>Method</th><th>Amount</th><th></th></tr>${D.payments.map(p => `<tr><td>${p.date}</td><td>${p.receiptNo}</td><td>${esc(p.reference || '-')}</td><td>${esc(p.method)}</td><td>${fmt(p.amount)}</td><td><button class="btn sm" onclick="receipt(${p.id})">Receipt</button></td></tr>`).join('')}</table>` : '<p class="muted">No payments yet. Payments recorded by the accounts office appear here.</p>'}</div>`;
}
const sAnn = () => `<div class="panel"><h3>Announcements</h3>${D.items.length ? D.items.map(annHtml).join('') : empty('No announcements yet.')}</div>`;
const sProf = () => `<div class="panel"><h3>Academic details</h3><dl><dt>Name</dt><dd>${esc(D.name)}</dd><dt>Enrollment no.</dt><dd>${esc(D.enrollmentNo)}</dd><dt>Course</dt><dd>${esc(D.course)}</dd><dt>Semester</dt><dd>${D.semester}${D.section ? ' · Section ' + esc(D.section) : ''}</dd></dl><p class="note muted">To correct these details, contact the college office.</p></div>
 <div class="panel"><h3>Contact details</h3>${fld('ph', 'Phone', D.phone, 'tel')}<div class="f"><label for="ad">Address</label><textarea id="ad" rows="2">${esc(D.address)}</textarea></div><div class="err" id="e1" role="alert"></div><button class="btn pri" onclick="saveC()">Save changes</button></div>
 <div class="panel"><h3>Change password</h3>${pwForm()}</div>`;
const saveC = () => run(async () => { await api('PATCH', '/me/profile', { phone: $('#ph').value, address: $('#ad').value }); toast('Contact details saved'); await reload(); }, 'e1');

/* ---- hooks used by the Android app ---- */
function doPrint() { window.Android ? window.Android.print() : window.print(); }
window.appBack = function () {
  if ($('#mod')) { closeM(); return true; }
  if (ME && view !== 'force' && view !== (ME.role === 'ADMIN' ? 'dash' : 'home')) { go(ME.role === 'ADMIN' ? 'dash' : 'home'); return true; }
  return false;
};

/* ---- start ---- */
(async function boot() {
  try { INFO = await api('GET', '/public/info'); } catch (e) {
    $('#app').innerHTML = `<div class="wrap"><div class="login"><h1>Can't connect</h1><p class="lead">${esc(e.message)}</p><button class="btn pri" onclick="location.reload()">Try again</button></div></div>`; return;
  }
  try { ME = await api('GET', '/auth/me'); } catch (e) { ME = null; }
  if (ME) await enter(); else render();
})();
