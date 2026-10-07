(() => {
  const app = document.getElementById('app');
  const toastEl = document.getElementById('toast');
  const state = { token: localStorage.getItem('token'), user: null, authMode: 'login', people: [], peopleQ: '', peopleRole: '' };

  /* ---------- helpers ---------- */
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const day = (s) => (s || '').slice(0, 10);
  const fmtDate = (d) => {
    if (!d) return '';
    const [y, m, dd] = day(d).split('-').map(Number);
    return new Date(y, m - 1, dd).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  };
  const isLate = (d) => { if (!d) return false; const [y, m, dd] = d.split('-').map(Number); return new Date(y, m - 1, dd, 23, 59, 59) < new Date(); };
  const opts = (list, sel) => list.map(([v, l]) => `<option value="${esc(v)}" ${v === sel ? 'selected' : ''}>${esc(l)}</option>`).join('');
  const $ = (sel, root = document) => root.querySelector(sel);

  let toastTimer;
  function toast(msg) {
    toastEl.textContent = msg; toastEl.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2600);
  }

  async function api(path, o = {}) {
    const res = await fetch('/api' + path, {
      method: o.method || 'GET',
      headers: { 'Content-Type': 'application/json', ...(state.token ? { Authorization: 'Bearer ' + state.token } : {}) },
      body: o.body ? JSON.stringify(o.body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if ((res.status === 401 || (res.status === 403 && /disabled/.test(data.error || ''))) && state.token) logout(true);
      throw new Error(data.error || 'Something went wrong.');
    }
    return data;
  }
  const act = async (fn) => { try { await fn(); } catch (e) { toast(e.message); } };

  function logout(expired) {
    localStorage.removeItem('token'); state.token = null; state.user = null;
    location.hash = ''; renderAuth(); if (expired) toast('You were logged out. Log in again.');
  }

  /* ---------- auth ---------- */
  function renderAuth() {
    const signup = state.authMode === 'signup';
    app.innerHTML = `
      <div class="auth">
        <section class="auth-side"><h1>Schoolhouse</h1><p>Classes, assignments, grades and announcements in one place.</p></section>
        <section class="auth-main">
          <form class="auth-card" id="auth-form" novalidate>
            <h2>${signup ? 'Create your account' : 'Log in'}</h2>
            ${signup ? `
              <div class="role-pick" role="radiogroup" aria-label="I am a">
                <label><input type="radio" name="role" value="student" checked> Student</label>
                <label><input type="radio" name="role" value="teacher"> Teacher</label>
              </div>
              <label class="field"><span>Full name</span><input name="full_name" autocomplete="name" required></label>` : ''}
            <label class="field"><span>Email</span><input name="email" type="email" autocomplete="email" required></label>
            <label class="field"><span>Password</span><input name="password" type="password" autocomplete="${signup ? 'new-password' : 'current-password'}" required></label>
            <p class="error" id="auth-error"></p>
            <button class="btn block" type="submit">${signup ? 'Sign up' : 'Log in'}</button>
            <p class="switch">${signup ? 'Already have an account?' : 'New here?'}
              <button type="button" class="link" id="switch-mode">${signup ? 'Log in' : 'Create an account'}</button></p>
          </form>
        </section>
      </div>`;
    $('#switch-mode').onclick = () => { state.authMode = signup ? 'login' : 'signup'; renderAuth(); };
    $('#auth-form').onsubmit = async (e) => {
      e.preventDefault();
      const errEl = $('#auth-error'); errEl.textContent = '';
      try {
        const data = await api(signup ? '/auth/signup' : '/auth/login', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) });
        state.token = data.token; state.user = data.user; localStorage.setItem('token', data.token);
        location.hash = ''; route();
      } catch (err) { errEl.textContent = err.message; }
    };
  }

  /* ---------- shell + nav ---------- */
  const NAV = {
    owner: [['', 'Overview'], ['people', 'People'], ['classes', 'Classes'], ['announcements', 'Announcements']],
    teacher: [['', 'My classes'], ['announcements', 'Announcements']],
    student: [['', 'My classes'], ['announcements', 'Announcements']],
  };

  function shell(active, inner) {
    const u = state.user;
    app.innerHTML = `
      <header class="topbar">
        <div class="topbar-inner">
          <span class="brand">Schoolhouse</span>
          <div class="who">
            <a class="who-link" href="#/account">${esc(u.full_name)} <span class="role">(${esc(u.role)})</span></a>
            <button class="btn ghost small" id="logout">Log out</button>
          </div>
        </div>
        <nav class="nav"><div class="nav-inner">
          ${NAV[u.role].map(([h, l]) => `<a href="#/${h}" ${h === active ? 'aria-current="page"' : ''}>${l}</a>`).join('')}
        </div></nav>
      </header>
      <main>${inner}</main>`;
    $('#logout').onclick = () => logout(false);
  }

  /* ---------- shared pieces ---------- */
  const empty = (t) => `<div class="empty">${t}</div>`;

  function announcementList(list, canDelete, me) {
    if (!list.length) return empty('No announcements yet.');
    return `<ul class="list">${list.map((n) => `
      <li class="item"><div>
        <h4>${esc(n.title)}</h4>
        <div class="meta">${esc(n.author_name)} · ${fmtDate(n.created_at)} · ${n.class_name ? esc(n.class_name) : 'Whole school'}</div>
        ${n.body ? `<p>${esc(n.body)}</p>` : ''}</div>
        ${canDelete && (state.user.role === 'owner' || n.author_id === me) ? `<div><button class="btn danger small" data-act="del-ann" data-id="${n.id}">Delete</button></div>` : ''}
      </li>`).join('')}</ul>`;
  }

  function announceForm(classes, allowSchool) {
    const options = (allowSchool ? [['', 'Whole school']] : []).concat(classes.map((c) => [String(c.id), c.name]));
    if (!options.length) return '';
    return `<form class="panel-body" data-form="announce">
      <div class="form-grid">
        <label class="field"><span>Title</span><input name="title" required></label>
        <label class="field"><span>Send to</span><select name="class_id">${opts(options)}</select></label>
        <label class="field wide"><span>Message</span><textarea name="body"></textarea></label>
      </div>
      <p class="error"></p><button class="btn" type="submit">Post announcement</button></form>`;
  }

  function assignmentItems(list, role, me) {
    if (!list.length) return empty('No assignments yet.');
    return `<ul class="list">${list.map((a) => {
      const mine = role === 'owner' || a.teacher_id === me;
      let tail = '';
      if (role === 'student') {
        const graded = a.sub_score !== null && a.sub_score !== undefined;
        tail = `
          <div class="status">
            ${graded ? `<span class="chip ok">Graded: ${a.sub_score}/${a.max_score}</span>` : a.sub_id ? '<span class="chip">Submitted</span>' : '<span class="chip warn">Not submitted</span>'}
            ${a.sub_feedback ? `<p class="feedback">Feedback: ${esc(a.sub_feedback)}</p>` : ''}
          </div>
          ${graded ? '' : `<details class="submit"><summary>${a.sub_id ? 'Edit your answer' : 'Submit work'}</summary>
            <form data-form="submit" data-id="${a.id}"><textarea name="content" required>${esc(a.sub_content || '')}</textarea>
            <p class="error"></p><button class="btn small" type="submit">${a.sub_id ? 'Resubmit' : 'Submit'}</button></form></details>`}`;
      } else {
        tail = `<div class="row-actions">
          <button class="btn ghost small" data-act="subs" data-id="${a.id}">Submissions (${a.submission_count})</button>
          ${mine ? `<button class="btn danger small" data-act="del-assignment" data-id="${a.id}">Delete</button>` : ''}</div>
          <div class="subs" id="subs-${a.id}"></div>`;
      }
      return `<li class="item col"><div>
          <h4>${esc(a.title)}</h4>
          <div class="meta">${esc(a.class_name || 'General')} · ${esc(a.teacher_name)} · ${a.max_score} points</div>
          ${a.description ? `<p>${esc(a.description)}</p>` : ''}
          ${a.due_date ? `<span class="due ${isLate(a.due_date) ? 'late' : ''}">Due ${fmtDate(a.due_date)}</span>` : ''}
        </div>${tail}</li>`;
    }).join('')}</ul>`;
  }

  function classCards(list, role) {
    if (!list.length) return empty(role === 'student' ? 'You have not joined a class yet. Enter a join code above.' : 'No classes yet.');
    return `<div class="cards">${list.map((c) => `
      <a class="card" href="#/class/${c.id}">
        <h4>${esc(c.name)}</h4>
        <div class="meta">${esc(c.subject || 'No subject')}</div>
        <div class="meta">Teacher: ${esc(c.teacher_name)}</div>
        <div class="card-foot"><span>${c.student_count} student${c.student_count === 1 ? '' : 's'}</span>
          ${c.join_code ? `<span class="code">${esc(c.join_code)}</span>` : ''}</div>
      </a>`).join('')}</div>`;
  }

  /* ---------- views ---------- */
  async function viewOverview() {
    const [s, ann, classes] = await Promise.all([api('/stats'), api('/announcements'), api('/classes')]);
    const stat = (n, l, href) => `<a class="stat" href="${href}"><span class="n">${n}</span><span class="l">${l}</span></a>`;
    shell('', `
      <h2>School overview</h2>
      <div class="stats">
        ${stat(s.students, 'Students', '#/people')}${stat(s.teachers, 'Teachers', '#/people')}${stat(s.classes, 'Classes', '#/classes')}
        ${stat(s.assignments, 'Assignments', '#/classes')}${stat(s.ungraded, 'Awaiting grades', '#/classes')}${stat(s.owners, 'Owners', '#/people')}
      </div>
      <section class="panel"><div class="panel-head"><h3>Post a school-wide announcement</h3></div>${announceForm(classes.classes, true)}</section>
      <section class="panel"><div class="panel-head"><h3>Recent announcements</h3></div>${announcementList(ann.announcements.slice(0, 5), true, state.user.id)}</section>`);
  }

  function peopleRows() {
    const q = state.peopleQ.toLowerCase();
    const rows = state.people.filter((p) => (!state.peopleRole || p.role === state.peopleRole) &&
      (!q || p.full_name.toLowerCase().includes(q) || p.email.toLowerCase().includes(q)));
    if (!rows.length) return `<tr><td colspan="5" class="empty">No one matches.</td></tr>`;
    return rows.map((p) => {
      const me = p.id === state.user.id;
      return `<tr>
        <td>${esc(p.full_name)}${me ? ' <span class="meta">(you)</span>' : ''}<div class="meta">Joined ${fmtDate(p.created_at)}</div></td>
        <td>${esc(p.email)}</td>
        <td><select data-act="role" data-id="${p.id}" aria-label="Role for ${esc(p.full_name)}">${opts([['owner', 'Owner'], ['teacher', 'Teacher'], ['student', 'Student']], p.role)}</select></td>
        <td>${p.active ? '<span class="chip ok">Active</span>' : '<span class="chip warn">Disabled</span>'}</td>
        <td class="actions">
          <button class="btn ghost small" data-act="reset" data-id="${p.id}" data-name="${esc(p.full_name)}">Reset password</button>
          ${me ? '' : `<button class="btn ghost small" data-act="toggle" data-id="${p.id}" data-active="${p.active ? 0 : 1}">${p.active ? 'Disable' : 'Enable'}</button>
          <button class="btn danger small" data-act="del-user" data-id="${p.id}" data-name="${esc(p.full_name)}">Remove</button>`}
        </td></tr>`;
    }).join('');
  }

  async function viewPeople() {
    state.people = (await api('/admin/users')).users;
    shell('people', `
      <h2>People</h2>
      <section class="panel">
        <div class="panel-head"><h3>Add a person</h3></div>
        <form class="panel-body" data-form="add-user">
          <div class="form-grid four">
            <label class="field"><span>Full name</span><input name="full_name" required></label>
            <label class="field"><span>Email</span><input name="email" type="email" required></label>
            <label class="field"><span>Temporary password</span><input name="password" type="text" minlength="6" required></label>
            <label class="field"><span>Role</span><select name="role">${opts([['student', 'Student'], ['teacher', 'Teacher'], ['owner', 'Owner']])}</select></label>
          </div>
          <p class="error"></p><button class="btn" type="submit">Create account</button>
        </form>
      </section>
      <section class="panel">
        <div class="panel-head"><h3>All accounts (${state.people.length})</h3>
          <div class="filters">
            <input id="people-q" type="search" placeholder="Search name or email" value="${esc(state.peopleQ)}" aria-label="Search people">
            <select id="people-role" aria-label="Filter by role">${opts([['', 'All roles'], ['owner', 'Owners'], ['teacher', 'Teachers'], ['student', 'Students']], state.peopleRole)}</select>
          </div></div>
        <div class="scroll"><table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th></th></tr></thead>
        <tbody id="people-body">${peopleRows()}</tbody></table></div>
      </section>`);
    $('#people-q').oninput = (e) => { state.peopleQ = e.target.value; $('#people-body').innerHTML = peopleRows(); };
    $('#people-role').onchange = (e) => { state.peopleRole = e.target.value; $('#people-body').innerHTML = peopleRows(); };
  }

  async function viewClasses() {
    const role = state.user.role;
    const { classes } = await api('/classes');
    shell(role === 'owner' ? 'classes' : '', `
      <h2>${role === 'owner' ? 'All classes' : 'My classes'}</h2>
      ${role === 'teacher' ? `<section class="panel"><div class="panel-head"><h3>Create a class</h3></div>
        <form class="panel-body" data-form="new-class"><div class="form-grid">
          <label class="field"><span>Class name</span><input name="name" required></label>
          <label class="field"><span>Subject</span><input name="subject"></label></div>
          <p class="error"></p><button class="btn" type="submit">Create class</button></form></section>` : ''}
      ${role === 'student' ? `<section class="panel"><div class="panel-head"><h3>Join a class</h3></div>
        <form class="panel-body inline" data-form="join"><label class="field"><span>Join code from your teacher</span><input name="code" maxlength="6" autocapitalize="characters" required></label>
          <button class="btn" type="submit">Join class</button></form><p class="error pad"></p></section>` : ''}
      ${classCards(classes, role)}`);
  }

  async function viewClass(id) {
    const role = state.user.role, me = state.user.id;
    const [c, as, ann] = await Promise.all([api('/classes/' + id), api('/assignments?class_id=' + id), api('/announcements?class_id=' + id)]);
    const cls = c.class, manage = role === 'owner' || (role === 'teacher' && cls.teacher_id === me);
    shell(role === 'owner' ? 'classes' : '', `
      <p class="crumb"><a href="#/${role === 'owner' ? 'classes' : ''}">&larr; Classes</a></p>
      <div class="class-head">
        <div><h2>${esc(cls.name)}</h2><div class="meta">${esc(cls.subject || '')} ${cls.subject ? '·' : ''} Teacher: ${esc(cls.teacher_name)}</div></div>
        ${cls.join_code ? `<div class="joinbox"><span class="meta">Join code</span><span class="code big">${esc(cls.join_code)}</span></div>` : ''}
      </div>
      ${role === 'teacher' && manage ? `<section class="panel"><div class="panel-head"><h3>New assignment</h3></div>
        <form class="panel-body" data-form="new-assignment" data-class="${cls.id}"><div class="form-grid three">
          <label class="field"><span>Title</span><input name="title" required></label>
          <label class="field"><span>Due date</span><input name="due_date" type="date"></label>
          <label class="field"><span>Points</span><input name="max_score" type="number" min="1" value="100"></label>
          <label class="field wide"><span>Instructions</span><textarea name="description"></textarea></label></div>
          <p class="error"></p><button class="btn" type="submit">Post assignment</button></form></section>` : ''}
      <section class="panel"><div class="panel-head"><h3>Assignments (${as.assignments.length})</h3></div>${assignmentItems(as.assignments, role, me)}</section>
      <section class="panel"><div class="panel-head"><h3>Announcements</h3></div>
        ${manage ? announceForm([cls], false).replace('<select name="class_id">', '<select name="class_id" disabled>') + '' : ''}
        ${announcementList(ann.announcements, manage, me)}</section>
      <section class="panel"><div class="panel-head"><h3>Students (${c.students.length})</h3>
        ${role === 'student' ? `<button class="btn danger small" data-act="leave" data-id="${cls.id}">Leave class</button>` : ''}</div>
        ${c.students.length ? `<ul class="list">${c.students.map((s) => `<li class="item"><div>${esc(s.full_name)}${s.email ? `<div class="meta">${esc(s.email)}</div>` : ''}</div>
          ${manage ? `<div><button class="btn danger small" data-act="kick" data-class="${cls.id}" data-id="${s.id}">Remove</button></div>` : ''}</li>`).join('')}</ul>`
          : empty(manage ? 'No students yet. Share the join code above.' : 'No students yet.')}</section>
      ${manage ? `<div class="danger-zone"><button class="btn danger" data-act="del-class" data-id="${cls.id}">Delete this class</button></div>` : ''}`);
    // class-scoped announcement form: set the hidden class value
    const sel = $('select[name="class_id"][disabled]');
    if (sel) { sel.disabled = false; sel.closest('label').style.display = 'none'; }
  }

  async function viewAnnouncements() {
    const role = state.user.role;
    const [{ announcements }, { classes }] = await Promise.all([api('/announcements'), api('/classes')]);
    shell('announcements', `
      <h2>Announcements</h2>
      ${role !== 'student' ? `<section class="panel"><div class="panel-head"><h3>New announcement</h3></div>${announceForm(classes, role === 'owner') || empty('Create a class first to post announcements.')}</section>` : ''}
      <section class="panel">${announcementList(announcements, role !== 'student', state.user.id)}</section>`);
  }

  function viewAccount() {
    const u = state.user;
    shell('account', `
      <h2>Your account</h2>
      <section class="panel"><div class="panel-head"><h3>Profile</h3></div>
        <form class="panel-body" data-form="profile"><div class="form-grid">
          <label class="field"><span>Full name</span><input name="full_name" value="${esc(u.full_name)}" required></label>
          <label class="field"><span>Email</span><input value="${esc(u.email)}" disabled></label></div>
          <p class="error"></p><button class="btn" type="submit">Save changes</button></form></section>
      <section class="panel"><div class="panel-head"><h3>Change password</h3></div>
        <form class="panel-body" data-form="password"><div class="form-grid">
          <label class="field"><span>Current password</span><input name="current" type="password" autocomplete="current-password" required></label>
          <label class="field"><span>New password</span><input name="next" type="password" autocomplete="new-password" minlength="6" required></label></div>
          <p class="error"></p><button class="btn" type="submit">Update password</button></form></section>`);
  }

  /* ---------- router ---------- */
  async function route() {
    if (!state.token) return renderAuth();
    try {
      if (!state.user) state.user = (await api('/me')).user;
      const [, page, arg] = (location.hash || '#/').split('/');
      const role = state.user.role;
      if (page === 'account') return viewAccount();
      if (page === 'class' && arg) return await viewClass(arg);
      if (page === 'announcements') return await viewAnnouncements();
      if (role === 'owner') {
        if (page === 'people') return await viewPeople();
        if (page === 'classes') return await viewClasses();
        return await viewOverview();
      }
      return await viewClasses();
    } catch (err) { if (state.token) toast(err.message); }
  }
  window.addEventListener('hashchange', route);

  /* ---------- actions (event delegation) ---------- */
  app.addEventListener('submit', async (e) => {
    const form = e.target.closest('[data-form]'); if (!form) return;
    e.preventDefault();
    const kind = form.dataset.form, body = Object.fromEntries(new FormData(form));
    const errEl = $('.error', form) || $('.error', form.parentElement);
    if (errEl) errEl.textContent = '';
    try {
      if (kind === 'announce') { await api('/announcements', { method: 'POST', body }); toast('Announcement posted'); }
      if (kind === 'add-user') { await api('/admin/users', { method: 'POST', body }); toast('Account created'); }
      if (kind === 'new-class') { await api('/classes', { method: 'POST', body }); toast('Class created'); }
      if (kind === 'join') { const r = await api('/classes/join', { method: 'POST', body }); toast('Joined ' + r.class.name); }
      if (kind === 'new-assignment') { await api('/assignments', { method: 'POST', body: { ...body, class_id: form.dataset.class } }); toast('Assignment posted'); }
      if (kind === 'submit') { await api(`/assignments/${form.dataset.id}/submit`, { method: 'POST', body }); toast('Work submitted'); }
      if (kind === 'grade') { await api(`/submissions/${form.dataset.id}/grade`, { method: 'PUT', body }); toast('Grade saved'); return openSubs(form.dataset.assignment, true); }
      if (kind === 'profile') { state.user = (await api('/me', { method: 'PUT', body })).user; toast('Profile saved'); }
      if (kind === 'password') { await api('/me/password', { method: 'PUT', body }); toast('Password updated'); form.reset(); return; }
      route();
    } catch (err) { if (errEl) errEl.textContent = err.message; else toast(err.message); }
  });

  async function openSubs(id, force) {
    const box = $('#subs-' + id); if (!box) return;
    if (box.innerHTML && !force) { box.innerHTML = ''; return; }
    const { assignment, rows } = await api(`/assignments/${id}/submissions`);
    box.innerHTML = rows.length ? rows.map((r) => `
      <div class="sub">
        <div class="sub-head"><strong>${esc(r.full_name)}</strong>
          ${r.submission_id ? `<span class="meta">Submitted ${fmtDate(r.submitted_at)}</span>` : '<span class="chip warn">Not submitted</span>'}</div>
        ${r.submission_id ? `<p class="answer">${esc(r.content)}</p>
          <form class="grade" data-form="grade" data-id="${r.submission_id}" data-assignment="${id}">
            <label>Score <input name="score" type="number" min="0" max="${assignment.max_score}" value="${r.score ?? ''}" required> / ${assignment.max_score}</label>
            <input name="feedback" placeholder="Feedback (optional)" value="${esc(r.feedback || '')}">
            <button class="btn small" type="submit">${r.score === null ? 'Save grade' : 'Update grade'}</button>
            <span class="error"></span></form>` : ''}
      </div>`).join('') : empty('No students in this class yet.');
  }

  app.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]'); if (!b || b.tagName === 'SELECT') return;
    const { act: a, id, name } = b.dataset;
    act(async () => {
      if (a === 'subs') return openSubs(id);
      if (a === 'del-ann') { if (!confirm('Delete this announcement?')) return; await api('/announcements/' + id, { method: 'DELETE' }); toast('Announcement deleted'); }
      if (a === 'del-assignment') { if (!confirm('Delete this assignment and all submissions?')) return; await api('/assignments/' + id, { method: 'DELETE' }); toast('Assignment deleted'); }
      if (a === 'del-class') { if (!confirm('Delete this class, its assignments and submissions?')) return; await api('/classes/' + id, { method: 'DELETE' }); toast('Class deleted'); location.hash = '#/'; return; }
      if (a === 'leave') { if (!confirm('Leave this class?')) return; await api(`/classes/${id}/leave`, { method: 'POST' }); location.hash = '#/'; return; }
      if (a === 'kick') { if (!confirm('Remove this student from the class?')) return; await api(`/classes/${b.dataset.class}/students/${id}`, { method: 'DELETE' }); toast('Student removed'); }
      if (a === 'reset') { const p = prompt(`New password for ${name} (min 6 characters):`); if (!p) return; await api(`/admin/users/${id}/password`, { method: 'POST', body: { password: p } }); toast('Password reset'); return; }
      if (a === 'toggle') { await api(`/admin/users/${id}/active`, { method: 'PUT', body: { active: b.dataset.active === '1' } }); toast('Account updated'); }
      if (a === 'del-user') { if (!confirm(`Remove ${name}? Their classes, submissions and posts are deleted too.`)) return; await api('/admin/users/' + id, { method: 'DELETE' }); toast('Account removed'); }
      route();
    });
  });

  app.addEventListener('change', (e) => {
    const s = e.target.closest('select[data-act="role"]'); if (!s) return;
    act(async () => {
      try { await api(`/admin/users/${s.dataset.id}/role`, { method: 'PUT', body: { role: s.value } }); toast('Role updated'); if (Number(s.dataset.id) === state.user.id) state.user = null; }
      finally { route(); }
    });
  });

  route();
})();
