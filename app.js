'use strict';
// ============ 基础 ============
const STAGES = ['简历筛选', '初试', '复试', '终面', 'Offer', '入职'];
const SOURCES = ['内推', '猎头', '官网', '招聘网站', '校园招聘', '其他'];
const EDU = ['大专', '本科', '硕士', '博士', '其他'];
const STATUS_LABEL = { active: '招聘中', in_pool: '人才库', hired: '已入职', rejected: '已淘汰' };

let token = localStorage.getItem('hr_token');
let me = null, companyKey = '', users = [];
let currentRoute = 'dashboard';
let pollTimer = null;

const $ = (s, r = document) => r.querySelector(s);
const view = () => $('#view');
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function api(method, path, body) {
  const opt = { method, headers: {} };
  if (token) opt.headers['Authorization'] = 'Bearer ' + token;
  if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  return fetch(path, opt).then(r => r.json().then(d => ({ r, d }))).then(({ r, d }) => {
    if (r.status === 401) { logout(); throw new Error(d.error || '未登录'); }
    if (!r.ok) throw new Error(d.error || '请求失败');
    return d;
  });
}
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(t._t); t._t = setTimeout(() => t.classList.add('hidden'), 2200);
}
function fmtTime(s) { if (!s) return ''; const d = new Date(s); return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; }
function stageBadge(c) { return `<span class="stage-pill">${STAGES[c.stage]}</span>`; }
function statusBadge(c) {
  const map = { active: 'b-active', in_pool: 'b-pool', hired: 'b-hired', rejected: 'b-rejected' };
  return `<span class="badge ${map[c.status]}">${STATUS_LABEL[c.status]}</span>`;
}
function ownerSelect(selected) {
  return `<select name="owner_id"><option value="">未分配</option>${users.map(u => `<option value="${u.id}" ${String(u.id) === String(selected) ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}</select>`;
}

// ============ 登录/注册 ============
function renderLogin() {
  const wrap = $('#login'); wrap.classList.remove('hidden'); $('#app').classList.add('hidden');
  wrap.innerHTML = `<div class="login-card">
    <h1>人才管理系统</h1>
    <div class="sub">北京华联 · 招聘与人才库协作平台</div>
    <div class="tabs">
      <button id="tabLogin" class="active">登录</button>
      <button id="tabReg">注册新员工</button>
    </div>
    <div id="authForm"></div>
  </div>`;
  $('#tabLogin').onclick = () => { $('#tabLogin').classList.add('active'); $('#tabReg').classList.remove('active'); loginForm(); };
  $('#tabReg').onclick = () => { $('#tabReg').classList.add('active'); $('#tabLogin').classList.remove('active'); regForm(); };
  loginForm();
}
function loginForm() {
  $('#authForm').innerHTML = `
    <div class="field"><label>用户名</label><input id="u" placeholder="如 admin"></div>
    <div class="field"><label>密码</label><input id="p" type="password" placeholder="密码"></div>
    <button class="btn" style="width:100%" id="go">登录</button>`;
  $('#go').onclick = doLogin;
}
function regForm() {
  $('#authForm').innerHTML = `
    <div class="field"><label>姓名</label><input id="rn" placeholder="您的真实姓名"></div>
    <div class="field"><label>用户名</label><input id="ru" placeholder="登录用账号"></div>
    <div class="field"><label>密码</label><input id="rp" type="password" placeholder="设置登录密码"></div>
    <div class="field"><label>公司密钥</label><input id="rk" placeholder="向管理员索取"></div>
    <button class="btn" style="width:100%" id="go">注册并登录</button>
    <div class="muted" style="font-size:12px;margin-top:10px">注册需要公司密钥，确保只有团队成员能加入。</div>`;
  $('#go').onclick = doRegister;
}
async function doLogin() {
  try {
    const d = await api('POST', '/api/auth/login', { username: $('#u').value, password: $('#p').value });
    afterAuth(d);
  } catch (e) { toast(e.message); }
}
async function doRegister() {
  try {
    const d = await api('POST', '/api/auth/register', { name: $('#rn').value, username: $('#ru').value, password: $('#rp').value, company_key: $('#rk').value });
    afterAuth(d);
  } catch (e) { toast(e.message); }
}
function afterAuth(d) {
  token = d.token; localStorage.setItem('hr_token', token);
  me = d.user; $('#login').classList.add('hidden'); $('#app').classList.remove('hidden');
  startApp();
}
function logout() {
  token = null; localStorage.removeItem('hr_token'); me = null;
  clearInterval(pollTimer); renderLogin();
}

// ============ 应用启动 ============
async function startApp() {
  try {
    const d = await api('GET', '/api/auth/me');
    me = d.user; companyKey = d.company_key;
  } catch (e) { return; }
  users = (await api('GET', '/api/users')).users;
  $('#userName').textContent = me.name + (me.role === 'admin' ? '（管理员）' : '');
  $('#logoutBtn').onclick = () => { api('POST', '/api/auth/logout').catch(() => {}); logout(); };
  bindNav();
  window.addEventListener('hashchange', route);
  if (!location.hash) location.hash = '#/dashboard';
  route();
  pollTimer = setInterval(() => { if (!$('#modal').classList.contains('hidden')) return; route(true); }, 30000);
}

function bindNav() {
  document.querySelectorAll('.nav a').forEach(a => a.onclick = () => { location.hash = a.getAttribute('href'); });
}
const TITLES = { dashboard: '数据看板', recruitment: '招聘流程', onboarding: '入职办理', talent: '人才库', employees: '员工管理', settings: '系统设置' };
function route(silent) {
  let r = (location.hash || '#/dashboard').replace('#/', '');
  if (!TITLES[r]) r = 'dashboard';
  currentRoute = r;
  document.querySelectorAll('.nav a').forEach(a => a.classList.toggle('active', a.dataset.route === r));
  $('#pageTitle').textContent = TITLES[r];
  const map = { dashboard: renderDashboard, recruitment: renderRecruitment, onboarding: renderOnboarding, talent: renderTalent, employees: renderEmployees, settings: renderSettings };
  map[r]();
}

// ============ 看板 ============
async function renderDashboard() {
  const { stats } = await api('GET', '/api/stats');
  const { activities } = await api('GET', '/api/activities?limit=12');
  const maxFunnel = Math.max(1, ...stats.funnel.map(f => f.count));
  const funnel = stats.funnel.map(f => `<div class="funnel-row"><div class="flabel">${f.label}</div><div class="funnel-bar" style="width:${Math.max(8, f.count / maxFunnel * 320)}px">${f.count}</div></div>`).join('');
  const source = stats.sourceArr.length ? stats.sourceArr.map(s => `<span class="tag">${esc(s.source)} · ${s.count}</span>`).join('') : '<span class="muted">暂无数据</span>';
  const feed = activities.length ? activities.map(a => `<li><div>${esc(a.user_name)} · ${esc(a.action)} · <b>${esc(a.candidate_name || '')}</b></div><div class="t">${fmtTime(a.created_at)} ${esc(a.detail || '')}</div></li>`).join('') : '<div class="empty">暂无动态</div>';
  view().innerHTML = `
    <div class="grid cards4">
      <div class="stat"><div class="num">${stats.active}</div><div class="lbl">招聘中</div><div class="bar" style="background:var(--primary)"></div></div>
      <div class="stat"><div class="num">${stats.hired}</div><div class="lbl">已入职</div><div class="bar" style="background:var(--green)"></div></div>
      <div class="stat"><div class="num">${stats.pool}</div><div class="lbl">人才库</div><div class="bar" style="background:var(--amber)"></div></div>
      <div class="stat"><div class="num">${stats.hireRate}%</div><div class="lbl">录用率</div><div class="bar" style="background:var(--purple)"></div></div>
    </div>
    <div class="grid cards2" style="margin-top:16px">
      <div class="panel"><div class="section-title">招聘漏斗（各环节人数）</div>${funnel}
        <div class="muted" style="font-size:12px;margin-top:8px">本月新增候选人：<b>${stats.newThisMonth}</b> 人 · 已淘汰：${stats.rejected} 人</div>
      </div>
      <div class="panel"><div class="section-title">最近动态</div><ul class="feed">${feed}</ul></div>
    </div>
    <div class="panel" style="margin-top:16px"><div class="section-title">招聘渠道分布</div>${source}</div>`;
}

// ============ 招聘流程 ============
let recFilter = { status: 'active', stage: '', q: '' };
async function renderRecruitment(silent) {
  if (!silent) { /* keep filters */ }
  const qs = new URLSearchParams();
  qs.set('status', recFilter.status);
  if (recFilter.stage !== '') qs.set('stage', recFilter.stage);
  if (recFilter.q) qs.set('q', recFilter.q);
  const { candidates, stages } = await api('GET', '/api/candidates?' + qs.toString());
  const stageTabs = `<select id="fStage"><option value="">全部阶段</option>${STAGES.map((s, i) => `<option value="${i}" ${recFilter.stage === String(i) ? 'selected' : ''}>${s}</option>`).join('')}</select>`;
  const statusTabs = ['active', 'in_pool', 'hired', 'rejected'].map(s => `<button class="btn-sm ${recFilter.status === s ? 'btn' : 'btn-line'}" data-st="${s}">${STATUS_LABEL[s]}</button>`).join(' ');
  const rows = candidates.length ? candidates.map(c => `
    <tr>
      <td><b>${esc(c.name)}</b>${c.gender ? ` <span class="muted">${esc(c.gender)}</span>` : ''}</td>
      <td>${esc(c.position || '—')}</td>
      <td>${stageBadge(c)}</td>
      <td>${statusBadge(c)}</td>
      <td>${esc(c.owner_name || '未分配')}</td>
      <td>${esc(c.source || '—')}</td>
      <td class="row-actions">${actionBtns(c)}</td>
    </tr>`).join('') : `<tr><td colspan="7" class="empty">没有候选人，点右上角「新增候选人」开始</td></tr>`;
  view().innerHTML = `
    <div class="toolbar">
      <input class="grow" id="fQ" placeholder="搜索姓名 / 手机号 / 职位" value="${esc(recFilter.q)}">
      ${stageTabs}
      <button class="btn" id="addC">+ 新增候选人</button>
    </div>
    <div class="toolbar" style="margin-top:-6px">${statusTabs}</div>
    <table><thead><tr><th>姓名</th><th>应聘职位</th><th>阶段</th><th>状态</th><th>负责人</th><th>来源</th><th>操作</th></tr></thead><tbody>${rows}</tbody></table>`;
  $('#fQ').oninput = e => { recFilter.q = e.target.value; clearTimeout(e.target._t); e.target._t = setTimeout(() => renderRecruitment(true), 350); };
  $('#fStage').onchange = e => { recFilter.stage = e.target.value; renderRecruitment(true); };
  $('#addC').onclick = () => openCandidateForm(null);
  document.querySelectorAll('[data-st]').forEach(b => b.onclick = () => { recFilter.status = b.dataset.st; renderRecruitment(true); });
  bindRowActions(candidates);
}
function actionBtns(c) {
  if (c.status === 'active') {
    return `<button class="btn-sm btn-green" data-act="advance" data-id="${c.id}">推进</button>
      <button class="btn-sm btn-line" data-act="edit" data-id="${c.id}">编辑</button>
      <button class="btn-sm btn-amber" data-act="pool" data-id="${c.id}">入库</button>
      <button class="btn-sm btn-red" data-act="reject" data-id="${c.id}">淘汰</button>`;
  }
  if (c.status === 'in_pool' || c.status === 'rejected') {
    return `<button class="btn-sm btn-line" data-act="reactivate" data-id="${c.id}">重新激活</button>
      <button class="btn-sm btn-line" data-act="edit" data-id="${c.id}">编辑</button>
      <button class="btn-sm btn-red" data-act="del" data-id="${c.id}">删除</button>`;
  }
  if (c.status === 'hired') {
    return `<button class="btn-sm btn-line" data-act="edit" data-id="${c.id}">查看</button>`;
  }
  return '';
}
function bindRowActions(list) {
  document.querySelectorAll('[data-act]').forEach(b => b.onclick = async () => {
    const id = b.dataset.id, act = b.dataset.act;
    const c = list.find(x => String(x.id) === id);
    try {
      if (act === 'advance') { await api('POST', `/api/candidates/${id}/advance`); toast('已推进到下一阶段'); renderRecruitment(true); }
      else if (act === 'backward') { await api('POST', `/api/candidates/${id}/backward`); renderRecruitment(true); }
      else if (act === 'pool') { openPoolForm(c); }
      else if (act === 'reject') { if (confirm(`确认淘汰 ${c.name}？`)) { await api('POST', `/api/candidates/${id}/reject`); toast('已淘汰'); renderRecruitment(true); } }
      else if (act === 'reactivate') { await api('POST', `/api/candidates/${id}/reactivate`); toast('已重新激活'); renderRecruitment(true); }
      else if (act === 'hire') { if (confirm(`确认 ${c.name} 已入职？将自动生成入职清单`)) { await api('POST', `/api/candidates/${id}/hire`); toast('已标记入职'); renderRecruitment(true); } }
      else if (act === 'del') { if (confirm(`确认删除 ${c.name}？此操作不可恢复`)) { await api('DELETE', `/api/candidates/${id}`); toast('已删除'); renderRecruitment(true); } }
      else if (act === 'edit') { openCandidateForm(c); }
    } catch (e) { toast(e.message); }
  });
}

// 新增/编辑候选人
function openCandidateForm(c) {
  const isEdit = !!c;
  const v = (k) => c ? esc(c[k] || '') : '';
  openModal(isEdit ? '编辑候选人' : '新增候选人', `
    <div style="background:#f7f8fa;border:1px dashed #d0d5dd;border-radius:8px;padding:10px 12px;margin-bottom:14px">
      <div class="field" style="margin:0"><label>上传简历自动识别</label>
        <div style="display:flex;gap:8px;align-items:center;margin-top:4px">
          <input type="file" id="resumeFile" accept=".pdf,.docx,.txt,.jpg,.jpeg,.png" style="flex:1;padding:6px">
          <button class="btn-sm" id="ruBtn" type="button">识别并填入</button>
        </div>
        <div class="muted" id="ruStatus" style="margin-top:6px;font-size:12px">支持 PDF / Word / TXT / 图片(JPG/PNG)，识别后自动填入下方，请核对修改</div>
        <div id="attBox" class="muted" style="margin-top:6px;font-size:12px">${isEdit && c && c.attachment_name ? `已存附件：<a href="javascript:void(0)" id="dlAtt" style="color:#2563eb">${esc(c.attachment_name)}</a> <span class="muted">· 重新选择文件可替换</span>` : '选择文件并识别后，保存时会自动作为「附件简历」保留'}</div>
      </div>
    </div>
    <div class="row2">
      <div class="field"><label>姓名 *</label><input name="name" value="${v('name')}"></div>
      <div class="field"><label>性别</label><select name="gender"><option value="">不限</option>${['男', '女'].map(g => `<option ${c && c.gender === g ? 'selected' : ''}>${g}</option>`).join('')}</select></div>
    </div>
    <div class="row2">
      <div class="field"><label>手机号</label><input name="phone" value="${v('phone')}"></div>
      <div class="field"><label>邮箱</label><input name="email" value="${v('email')}"></div>
    </div>
    <div class="row2">
      <div class="field"><label>应聘职位</label><input name="position" value="${v('position')}"></div>
      <div class="field"><label>招聘来源</label><select name="source">${SOURCES.map(s => `<option ${c && c.source === s ? 'selected' : ''}>${s}</option>`).join('')}</select></div>
    </div>
    <div class="row2">
      <div class="field"><label>当前阶段</label><select name="stage">${STAGES.map((s, i) => `<option value="${i}" ${c && c.stage === i ? 'selected' : ''}>${s}</option>`).join('')}</select></div>
      <div class="field"><label>负责人</label>${ownerSelect(c ? c.owner_id : me.id)}</div>
    </div>
    <div class="row2">
      <div class="field"><label>期望薪资</label><input name="expected_salary" value="${v('expected_salary')}"></div>
      <div class="field"><label>当前公司</label><input name="current_org" value="${v('current_org')}"></div>
    </div>
    <div class="row2">
      <div class="field"><label>毕业院校</label><input name="school" value="${v('school')}"></div>
      <div class="field"><label>最高学历</label><select name="education">${EDU.map(s => `<option ${c && c.education === s ? 'selected' : ''}>${s}</option>`).join('')}</select></div>
    </div>
    <div class="field"><label>预计入职日期</label><input name="expected_onboard_date" type="date" value="${v('expected_onboard_date')}"></div>
    <div class="field"><label>面试评价</label><textarea name="interview_note">${v('interview_note')}</textarea></div>
    <div class="field"><label>备注</label><textarea name="notes">${v('notes')}</textarea></div>
    <div class="field"><label>履历 / 简历摘要</label><textarea name="resume_text" placeholder="上传简历识别后会自动填入原文，可手动补充候选人的工作履历、项目经历等">${v('resume_text')}</textarea></div>
    <div class="modal-actions"><button class="btn-ghost" onclick="closeModal()">取消</button><button class="btn" id="saveC">保存</button></div>
  `);
  $('#ruBtn').onclick = async () => {
    const f = $('#resumeFile').files[0];
    if (!f) { toast('请先选择简历文件'); return; }
    const st = $('#ruStatus'); st.textContent = '识别中…';
    try {
      const fd = new FormData();
      fd.append('file', f);
      const resp = await fetch('/api/parse-resume', { method: 'POST', headers: { 'Authorization': 'Bearer ' + token }, body: fd });
      const d = await resp.json();
      if (!resp.ok) { st.textContent = '识别失败：' + (d.error || '未知错误'); return; }
      const map = { name: 'name', phone: 'phone', email: 'email', position: 'position', education: 'education', current_org: 'current_org', school: 'school', expected_salary: 'expected_salary' };
      const filled = [];
      for (const [k, sel] of Object.entries(map)) {
        const el = $(`#modal [name="${sel}"]`);
        if (d.fields[k] && el && !el.value.trim()) { el.value = d.fields[k]; filled.push(k); }
      }
      // 履历：把识别出的简历原文填入文本框（供 HR 补充编辑）
      const rtEl = $('#modal [name="resume_text"]');
      if (d.text && rtEl && !rtEl.value.trim()) rtEl.value = d.text;
      const tip = d.usedOcr ? '（图片已OCR识别）' : '';
      const att = $('#attBox'); if (att) att.innerHTML = '已选择文件：<b>' + esc(f.name) + '</b> · 保存时将作为附件简历保留';
      st.textContent = filled.length ? ('已自动填入：' + filled.join('、') + (rtEl && d.text ? '、履历原文' : '') + ' ' + tip + '，请核对') : '未提取到可填字段，请手动输入';
    } catch (e) { st.textContent = '识别出错：' + e.message; }
  };
  if ($('#dlAtt')) $('#dlAtt').onclick = () => downloadAttachment(c.id, c.attachment_name);
  $('#saveC').onclick = async () => {
    const f = $('#modal').querySelectorAll('input,select,textarea');
    const body = {}; f.forEach(el => body[el.name] = el.value.trim());
    if (!body.name) { toast('请填写姓名'); return; }
    try {
      const saved = isEdit ? (await api('PUT', `/api/candidates/${c.id}`, body)).candidate
                           : (await api('POST', '/api/candidates', body)).candidate;
      // 若选择了文件，作为附件简历上传（同时写入履历原文）
      const fileEl = $('#resumeFile');
      if (fileEl && fileEl.files && fileEl.files[0]) {
        const fd = new FormData();
        fd.append('file', fileEl.files[0]);
        fd.append('resume_text', body.resume_text || '');
        await fetch(`/api/candidates/${saved.id}/attachment`, { method: 'POST', headers: { 'Authorization': 'Bearer ' + token }, body: fd });
      }
      closeModal(); toast('已保存'); renderRecruitment(true);
    } catch (e) { toast(e.message); }
  };
}

// 下载候选人附件简历（带登录态）
async function downloadAttachment(id, name) {
  try {
    const resp = await fetch(`/api/candidates/${id}/attachment`, { headers: { 'Authorization': 'Bearer ' + token } });
    if (!resp.ok) { toast('下载失败：' + (resp.status === 404 ? '暂无附件' : '服务异常')); return; }
    const blob = await resp.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name || 'resume'; a.click();
    URL.revokeObjectURL(url);
  } catch (e) { toast('下载出错：' + e.message); }
}
function openPoolForm(c) {
  openModal('转入人才库', `
    <p class="muted">将 <b>${esc(c.name)}</b> 转入人才库，便于日后复用。可添加标签与备注。</p>
    <div class="field"><label>人才标签（用逗号分隔）</label><input name="tags" placeholder="如：Java, 资深, 可复用"></div>
    <div class="field"><label>备注</label><textarea name="notes" placeholder="人才亮点、未录用原因等"></textarea></div>
    <div class="modal-actions"><button class="btn-ghost" onclick="closeModal()">取消</button><button class="btn btn-amber" id="toPool">确认转入</button></div>
  `);
  $('#toPool').onclick = async () => {
    const tags = $('#modal').querySelector('[name=tags]').value.trim();
    const notes = $('#modal').querySelector('[name=notes]').value.trim();
    try { await api('POST', `/api/candidates/${c.id}/pool`, { tags, notes }); closeModal(); toast('已转入人才库'); renderRecruitment(true); }
    catch (e) { toast(e.message); }
  };
}

// ============ 入职办理 ============
async function renderOnboarding(silent) {
  const { onboarding } = await api('GET', '/api/onboarding');
  const rows = onboarding.length ? onboarding.map(o => {
    const items = JSON.parse(o.items || '[]');
    const done = items.filter(i => i.done).length;
    const pct = items.length ? Math.round(done / items.length * 100) : 0;
    const doneFlag = o.completed_at ? '<span class="badge b-hired">已完成</span>' : '<span class="badge b-active">进行中</span>';
    return `<tr><td><b>${esc(o.candidate_name)}</b></td><td>${esc(o.position || '—')}</td><td>${esc(o.handler_name || '未分配')}</td>
      <td><div class="progress"><span style="width:${pct}%"></span></div><div class="muted" style="font-size:11px;margin-top:2px">${pct}%</div></td>
      <td>${doneFlag}</td><td><button class="btn-sm btn-line" data-onb="${o.id}">办理</button></td></tr>`;
  }).join('') : `<tr><td colspan="6" class="empty">暂无入职办理记录（把候选人标记为「入职」后自动生成）</td></tr>`;
  view().innerHTML = `
    <div class="panel" style="margin-bottom:14px"><b>入职办理</b> · 候选人标记为入职后，系统自动生成入职清单，可逐项勾选、指派负责人。</div>
    <table><thead><tr><th>姓名</th><th>职位</th><th>办理人</th><th>进度</th><th>状态</th><th>操作</th></tr></thead><tbody>${rows}</tbody></table>`;
  document.querySelectorAll('[data-onb]').forEach(b => b.onclick = () => openOnboarding(b.dataset.onb));
}
async function openOnboarding(id) {
  const { onboarding: o } = await api('GET', `/api/onboarding/${id}`);
  let items = JSON.parse(o.items || '[]');
  openModal(`入职办理 · ${esc(o.candidate_name)}`, `
    <div class="field"><label>办理负责人</label>${ownerSelect(o.handler_id)}</div>
    <div id="chk">${items.map(i => `<label class="check-item"><input type="checkbox" data-k="${i.key}" ${i.done ? 'checked' : ''}> <span>${esc(i.label)}</span></label>`).join('')}</div>
    <div class="modal-actions">
      <button class="btn-ghost" onclick="closeModal()">取消</button>
      <button class="btn btn-green" id="finishOnb" style="display:${o.completed_at ? 'none' : 'inline-block'}">标记全部完成</button>
      <button class="btn" id="saveOnb">保存进度</button>
    </div>`);
  $('#saveOnb').onclick = async () => {
    items = items.map(i => ({ ...i, done: $(`#chk input[data-k="${i.key}"]`).checked }));
    const handler_id = $('#modal').querySelector('[name=owner_id]').value;
    const handler = users.find(u => String(u.id) === String(handler_id));
    try { await api('PUT', `/api/onboarding/${id}`, { items, handler_id: handler_id || null, handler_name: handler ? handler.name : '' }); closeModal(); toast('已保存'); renderOnboarding(true); }
    catch (e) { toast(e.message); }
  };
  $('#finishOnb').onclick = async () => {
    items = items.map(i => ({ ...i, done: true }));
    try { await api('PUT', `/api/onboarding/${id}`, { items, completed_at: new Date().toISOString() }); closeModal(); toast('入职办理已完成'); renderOnboarding(true); }
    catch (e) { toast(e.message); }
  };
}

// ============ 人才库 ============
let poolQ = '';
async function renderTalent(silent) {
  const qs = new URLSearchParams(); qs.set('status', 'in_pool'); if (poolQ) qs.set('q', poolQ);
  const { candidates } = await api('GET', '/api/candidates?' + qs.toString());
  const rows = candidates.length ? candidates.map(c => {
    const tags = (c.tags || '').split(',').filter(Boolean).map(t => `<span class="tag">${esc(t.trim())}</span>`).join('');
    return `<tr><td><b>${esc(c.name)}</b></td><td>${esc(c.position || '—')}</td><td>${esc(c.current_org || '—')}</td>
      <td>${tags || '<span class="muted">—</span>'}</td><td>${esc(c.notes || '—')}</td>
      <td class="row-actions"><button class="btn-sm btn-line" data-act="reactivate" data-id="${c.id}">重新激活</button>
      <button class="btn-sm btn-line" data-act="edit" data-id="${c.id}">编辑</button>
      <button class="btn-sm btn-red" data-act="del" data-id="${c.id}">删除</button></td></tr>`;
  }).join('') : `<tr><td colspan="6" class="empty">人才库暂无储备人才</td></tr>`;
  view().innerHTML = `
    <div class="toolbar"><input class="grow" id="pQ" placeholder="搜索姓名 / 职位 / 标签" value="${esc(poolQ)}">
      <button class="btn btn-line" id="expPool">导出 CSV</button></div>
    <table><thead><tr><th>姓名</th><th>目标职位</th><th>当前单位</th><th>标签</th><th>备注</th><th>操作</th></tr></thead><tbody>${rows}</tbody></table>`;
  $('#pQ').oninput = e => { poolQ = e.target.value; clearTimeout(e.target._t); e.target._t = setTimeout(() => renderTalent(true), 350); };
  $('#expPool').onclick = () => exportCsv(candidates, '人才库');
  bindRowActions(candidates);
}

// ============ 员工 ============
async function renderEmployees() {
  const { users: us, company_key } = await api('GET', '/api/users');
  const rows = us.map(u => `<tr><td><b>${esc(u.name)}</b></td><td>${esc(u.username)}</td><td>${u.role === 'admin' ? '<span class="badge b-active">管理员</span>' : '成员'}</td><td class="muted">${fmtTime(u.created_at)}</td></tr>`).join('');
  view().innerHTML = `
    <div class="panel" style="margin-bottom:14px">
      <div class="section-title" style="margin-top:0">公司密钥（注册新员工时需要）</div>
      <div style="display:flex;align-items:center;gap:10px"><code style="background:#f4f6fb;padding:8px 14px;border-radius:8px;font-size:15px;letter-spacing:1px">${esc(company_key)}</code>
      <button class="btn-ghost" onclick="navigator.clipboard.writeText('${esc(company_key)}');toast('已复制密钥')">复制</button></div>
      <div class="muted" style="font-size:12px;margin-top:8px">把密钥发给同事，他们在登录页点「注册新员工」即可加入，所有人共享同一份数据。</div>
    </div>
    <table><thead><tr><th>姓名</th><th>用户名</th><th>角色</th><th>加入时间</th></tr></thead><tbody>${rows}</tbody></table>`;
}

// ============ 设置 ============
function renderSettings() {
  view().innerHTML = `
    <div class="panel" style="max-width:560px">
      <div class="section-title" style="margin-top:0">当前账号</div>
      <p>姓名：<b>${esc(me.name)}</b></p>
      <p>用户名：<b>${esc(me.username)}</b> ${me.role === 'admin' ? '（管理员）' : ''}</p>
      <div class="section-title">数据说明</div>
      <p class="muted">所有候选人与入职数据集中存储，团队成员实时共享、协同操作。数据每 30 秒自动刷新。</p>
      <div class="section-title">操作</div>
      <button class="btn btn-red" onclick="logout()">退出登录</button>
    </div>`;
}

// ============ 导出 ============
function exportCsv(list, name) {
  const cols = [['姓名', 'name'], ['性别', 'gender'], ['手机号', 'phone'], ['职位', 'position'], ['来源', 'source'], ['阶段', 'stage'], ['状态', 'status'], ['负责人', 'owner_name'], ['标签', 'tags'], ['备注', 'notes']];
  const head = cols.map(c => c[0]).join(',');
  const body = list.map(c => cols.map(([_, k]) => {
    let v = k === 'stage' ? STAGES[c.stage] : (k === 'status' ? STATUS_LABEL[c.status] : (c[k] || ''));
    v = String(v).replace(/"/g, '""'); return /[",\n]/.test(v) ? '"' + v + '"' : v;
  }).join(',')).join('\n');
  const blob = new Blob(['﻿' + head + '\n' + body], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name + '.csv'; a.click();
  toast('已导出');
}

// ============ Modal ============
function openModal(title, html) {
  $('#modal').innerHTML = `<div class="modal"><h3>${title}</h3>${html}</div>`;
  $('#modal').classList.remove('hidden');
}
function closeModal() { $('#modal').classList.add('hidden'); $('#modal').innerHTML = ''; }

// ============ 启动 ============
if (token) {
  api('GET', '/api/auth/me').then(d => { if (d && d.user) { me = d.user; companyKey = d.company_key; afterAuth({ token, user: d.user }); } else renderLogin(); })
    .catch(() => renderLogin());
} else {
  renderLogin();
}
