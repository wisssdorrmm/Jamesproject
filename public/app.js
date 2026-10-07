(() => {
  const app = document.getElementById('app');
  const toastEl = document.getElementById('toast');

  const state = {
    token: localStorage.getItem('token'),
    user: null,
    authMode: 'login',
    tab: 'students', // owner tab
  };

  /* ---------- helpers ---------- */

  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const fmtDate = (d) => {
    if (!d) return '';
    const [y, m, day] = d.split('-').map(Number);
    return new Date(y, m - 1, day).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  };

  const isLate = (d) => {
    if (!d) return false;
    const [y, m, day] = d.split('-').map(Number);
    const end = new Date(y, m - 1, day, 23, 59, 59);
    return end < new Date();
  };

  let toastTimer;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2400);
  }

  async function api(path, options = {}) {
    const res = await fetch('/api' + path, {
      method: options.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...(state.token ? { Authorization: 'Bearer ' + state.token } : {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (res.status === 401 && state.token) logout(true);
      throw new Error(data.error || 'Something went wrong.');
    }
    return data;
  }

  function logout(expired) {
    localStorage.removeItem('token');
    state.token = null;
    state.user = null;
    renderAuth();
    if (expired) toast('Session expired. Log in again.');
  }

  /* ---------- auth screen ---------- */

  function renderAuth() {
    const signup = state.authMode === 'signup';
    app.innerHTML = `
      <div class="auth">
        <section class="auth-side">
          <h1>Schoolhouse</h1>
          <p>Students, teachers and assignments, in one place.</p>
        </section>
        <section class="auth-main">
          <form class="auth-card" id="auth-form" novalidate>
            <h2>${signup ? 'Create your account' : 'Log in'}</h2>
            ${signup ? `
              <div class="role-pick" role="radiogroup" aria-label="I am a">
                <label><input type="radio" name="role" value="student" checked> Student</label>
                <label><input type="radio" name="role" value="teacher"> Teacher</label>
              </div>
              <label class="field"><span>Full name</span><input name="full_name" autocomplete="name" required></label>
            ` : ''}
            <label class="field"><span>Email</span><input name="email" type="email" autocomplete="email" required></label>
            <label class="field"><span>Password</span><input name="password" type="password" autocomplete="${signup ? 'new-password' : 'current-password'}" required></label>
            <p class="error" id="auth-error"></p>
            <button class="btn block" type="submit">${signup ? 'Sign up' : 'Log in'}</button>
            <p class="switch">
              ${signup ? 'Already have an account?' : 'New here?'}
              <button type="button" class="link" id="switch-mode">${signup ? 'Log in' : 'Create an account'}</button>
            </p>
          </form>
        </section>
      </div>`;

    document.getElementById('switch-mode').onclick = () => {
      state.authMode = signup ? 'login' : 'signup';
      renderAuth();
    };

    document.getElementById('auth-form').onsubmit = async (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      const errEl = document.getElementById('auth-error');
      errEl.textContent = '';
      try {
        const body = Object.fromEntries(f.entries());
        const data = await api(signup ? '/auth/signup' : '/auth/login', { method: 'POST', body });
        state.token = data.token;
        state.user = data.user;
        localStorage.setItem('token', data.token);
        await renderApp();
      } catch (err) {
        errEl.textContent = err.message;
      }
    };
  }

  /* ---------- shell ---------- */

  function shell(inner) {
    const u = state.user;
    app.innerHTML = `
      <header class="topbar">
        <div class="topbar-inner">
          <span class="brand">Schoolhouse</span>
          <div class="who">
            <span><span class="name">${esc(u.full_name)} </span><span class="role">(${esc(u.role)})</span></span>
            <button class="btn ghost small" id="logout">Log out</button>
          </div>
        </div>
      </header>
      <main>${inner}</main>`;
    document.getElementById('logout').onclick = () => logout(false);
  }

  /* ---------- shared renderers ---------- */

  function assignmentItems(list, { canDelete, userId, role }) {
    if (!list.length) return '<div class="empty">No assignments yet.</div>';
    return `<ul class="list">${list
      .map((a) => {
        const mine = role === 'owner' || (role === 'teacher' && a.teacher_id === userId);
        return `
        <li class="item">
          <div>
            <h4>${esc(a.title)}</h4>
            <div class="meta">Posted by ${esc(a.teacher_name)}</div>
            ${a.description ? `<p>${esc(a.description)}</p>` : ''}
            ${a.due_date ? `<span class="due ${isLate(a.due_date) ? 'late' : ''}">Due ${fmtDate(a.due_date)}</span>` : ''}
          </div>
          ${canDelete && mine ? `<div><button class="btn danger small" data-del-assignment="${a.id}">Delete</button></div>` : ''}
        </li>`;
      })
      .join('')}</ul>`;
  }

  function peopleTable(rows, { withCount, removable }) {
    if (!rows.length) return '<div class="empty">Nobody here yet.</div>';
    return `<table>
      <thead><tr><th>Name</th><th>Email</th><th>Joined</th>${withCount ? '<th>Assignments</th>' : ''}${removable ? '<th></th>' : ''}</tr></thead>
      <tbody>${rows
        .map(
          (r) => `<tr>
            <td>${esc(r.full_name)}</td>
            <td>${esc(r.email)}</td>
            <td>${esc((r.created_at || '').slice(0, 10))}</td>
            ${withCount ? `<td>${r.assignment_count}</td>` : ''}
            ${removable ? `<td class="actions"><button class="btn danger small" data-del-user="${r.id}" data-name="${esc(r.full_name)}">Remove</button></td>` : ''}
          </tr>`
        )
        .join('')}</tbody></table>`;
  }

  function bindDeletes(reload) {
    document.querySelectorAll('[data-del-assignment]').forEach((b) => {
      b.onclick = async () => {
        if (!confirm('Delete this assignment?')) return;
        try {
          await api('/assignments/' + b.dataset.delAssignment, { method: 'DELETE' });
          toast('Assignment deleted');
          reload();
        } catch (e) { toast(e.message); }
      };
    });
    document.querySelectorAll('[data-del-user]').forEach((b) => {
      b.onclick = async () => {
        if (!confirm(`Remove ${b.dataset.name}? This also deletes their assignments.`)) return;
        try {
          await api('/users/' + b.dataset.delUser, { method: 'DELETE' });
          toast('Account removed');
          reload();
        } catch (e) { toast(e.message); }
      };
    });
  }

  /* ---------- owner ---------- */

  async function renderOwner() {
    const [stats, studentsRes, teachersRes, assignmentsRes] = await Promise.all([
      api('/stats'), api('/students'), api('/teachers'), api('/assignments'),
    ]);
    const tab = state.tab;
    const tabs = [
      ['students', stats.students, 'Students'],
      ['teachers', stats.teachers, 'Teachers'],
      ['assignments', stats.assignments, 'Assignments'],
    ];

    let body = '';
    if (tab === 'students') body = peopleTable(studentsRes.students, { removable: true });
    if (tab === 'teachers') body = peopleTable(teachersRes.teachers, { withCount: true, removable: true });
    if (tab === 'assignments')
      body = assignmentItems(assignmentsRes.assignments, { canDelete: true, userId: state.user.id, role: 'owner' });

    shell(`
      <h2>School overview</h2>
      <div class="tabs" role="tablist">
        ${tabs
          .map(
            ([key, n, label]) => `
          <button class="tab" role="tab" aria-selected="${tab === key}" data-tab="${key}">
            <span class="n">${n}</span><span class="l">${label}</span>
          </button>`
          )
          .join('')}
      </div>
      <div class="panel" role="tabpanel">${body}</div>`);

    document.querySelectorAll('[data-tab]').forEach((b) => {
      b.onclick = () => { state.tab = b.dataset.tab; renderOwner(); };
    });
    bindDeletes(renderOwner);
  }

  /* ---------- teacher ---------- */

  async function renderTeacher() {
    const [assignmentsRes, studentsRes] = await Promise.all([api('/assignments'), api('/students')]);
    const mine = assignmentsRes.assignments.filter((a) => a.teacher_id === state.user.id);

    shell(`
      <h2>Your classroom</h2>
      <section class="panel">
        <div class="panel-head"><h3>New assignment</h3></div>
        <form class="panel-body" id="assign-form">
          <div class="form-grid">
            <label class="field"><span>Title</span><input name="title" required></label>
            <label class="field"><span>Due date</span><input name="due_date" type="date"></label>
            <label class="field wide"><span>Instructions</span><textarea name="description"></textarea></label>
          </div>
          <p class="error" id="assign-error"></p>
          <button class="btn" type="submit">Post assignment</button>
        </form>
      </section>

      <section class="panel">
        <div class="panel-head"><h3>Your assignments (${mine.length})</h3></div>
        ${assignmentItems(mine, { canDelete: true, userId: state.user.id, role: 'teacher' })}
      </section>

      <section class="panel">
        <div class="panel-head"><h3>Students (${studentsRes.students.length})</h3></div>
        ${peopleTable(studentsRes.students, {})}
      </section>`);

    document.getElementById('assign-form').onsubmit = async (e) => {
      e.preventDefault();
      const errEl = document.getElementById('assign-error');
      errEl.textContent = '';
      try {
        await api('/assignments', { method: 'POST', body: Object.fromEntries(new FormData(e.target).entries()) });
        toast('Assignment posted');
        renderTeacher();
      } catch (err) { errEl.textContent = err.message; }
    };
    bindDeletes(renderTeacher);
  }

  /* ---------- student ---------- */

  async function renderStudent() {
    const { assignments } = await api('/assignments');
    shell(`
      <h2>Your assignments</h2>
      <section class="panel">
        ${assignmentItems(assignments, { canDelete: false, userId: state.user.id, role: 'student' })}
      </section>`);
  }

  /* ---------- router ---------- */

  async function renderApp() {
    try {
      if (!state.user) state.user = (await api('/me')).user;
      const role = state.user.role;
      if (role === 'owner') return await renderOwner();
      if (role === 'teacher') return await renderTeacher();
      return await renderStudent();
    } catch (err) {
      if (state.token) toast(err.message);
    }
  }

  if (state.token) renderApp().then(() => { if (!state.user) renderAuth(); });
  else renderAuth();
})();
