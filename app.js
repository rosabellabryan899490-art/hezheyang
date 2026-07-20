/* 打卡计划 PWA 主逻辑：今日 / 日历 / 统计 / 模板 四页 */
/* global buildKaoyanTemplate */
(function () {
  'use strict';

  // ---------- 日期与字符串工具 ----------
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function fmt(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function parse(s) { var a = s.split('-'); return new Date(+a[0], +a[1] - 1, +a[2]); }
  function todayStr() { return fmt(new Date()); }
  function diffDays(a, b) { return Math.round((parse(b) - parse(a)) / 86400000); }
  function addDays(s, n) { var d = parse(s); d.setDate(d.getDate() + n); return fmt(d); }
  function md(s) { var a = s.split('-'); return (+a[1]) + '月' + (+a[2]) + '日'; }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // ---------- 本地存储 ----------
  var LS_TPL = 'daka.templates.v1', LS_PLANS = 'daka.plans.v1', LS_ACTIVE = 'daka.activePlan.v1';
  function load(k, def) {
    try { var v = JSON.parse(localStorage.getItem(k)); return v == null ? def : v; }
    catch (e) { return def; }
  }
  function persist() {
    localStorage.setItem(LS_PLANS, JSON.stringify(plans));
    localStorage.setItem(LS_ACTIVE, JSON.stringify(activeId));
    localStorage.setItem(LS_TPL, JSON.stringify(templates));
  }

  var builtin = buildKaoyanTemplate();
  var templates = load(LS_TPL, []);      // 用户导入的模板
  var plans = load(LS_PLANS, []);        // 已创建的计划（含打卡状态）
  var activeId = load(LS_ACTIVE, null);

  function allTemplates() { return [builtin].concat(templates); }
  function getTemplate(id) {
    var all = allTemplates();
    for (var i = 0; i < all.length; i++) if (all[i].id === id) return all[i];
    return null;
  }
  function activePlan() {
    for (var i = 0; i < plans.length; i++) if (plans[i].id === activeId) return plans[i];
    return plans[0] || null;
  }

  // ---------- 计划与打卡 ----------
  function createPlan(tplId, name, startDate, examDate) {
    var tpl = getTemplate(tplId);
    if (!tpl || !startDate) return null;
    var plan = {
      id: 'p' + Date.now(),
      name: name || tpl.name,
      templateId: tpl.id,
      startDate: startDate,
      examDate: examDate || null,
      createdAt: new Date().toISOString(),
      snapshot: JSON.parse(JSON.stringify(tpl)), // 快照，模板后续改动不影响已建计划
      checks: {} // { 第N天: [ {s:0待定|1完成|2跳过, at:完成时间ISO}, ... ] }
    };
    plans.push(plan);
    activeId = plan.id;
    persist();
    return plan;
  }

  function dayIdxOf(plan, dateStr) { return diffDays(plan.startDate, dateStr) + 1; }
  function dateOfDay(plan, dayIdx) { return addDays(plan.startDate, dayIdx - 1); }

  function dayChecks(plan, day) {
    var c = plan.checks[day];
    var n = plan.snapshot.days[day - 1].tasks.length;
    if (!c || c.length !== n) {
      c = [];
      for (var i = 0; i < n; i++) c.push({ s: 0, at: null });
      plan.checks[day] = c;
    }
    return c;
  }
  // 只读访问，不创建空记录（渲染统计时用，避免存储膨胀）
  function peekState(plan, day, idx) {
    var c = plan.checks[day];
    return (c && c[idx]) || { s: 0, at: null };
  }

  function toggleDone(plan, day, idx) {
    var c = dayChecks(plan, day);
    var st = c[idx];
    if (st.s === 1) { st.s = 0; st.at = null; }
    else { st.s = 1; st.at = new Date().toISOString(); }
    persist();
  }
  function toggleSkip(plan, day, idx) {
    var c = dayChecks(plan, day);
    var st = c[idx];
    st.s = (st.s === 2) ? 0 : 2;
    if (st.s === 2) st.at = null;
    persist();
  }

  // ---------- 统计 ----------
  function computeStats(plan) {
    var todayI = dayIdxOf(plan, todayStr());
    var total = 0, done = 0, skipped = 0, overdue = 0;
    var todayDone = 0, todayTotal = 0;
    var per = {}, checkDates = {};
    plan.snapshot.days.forEach(function (d) {
      d.tasks.forEach(function (tk, i) {
        var st = peekState(plan, d.day, i);
        var subj = tk.subject || '其他';
        if (!per[subj]) per[subj] = { total: 0, done: 0 };
        if (st.s !== 2) { total++; per[subj].total++; }
        else skipped++;
        if (st.s === 1) {
          done++; per[subj].done++;
          if (st.at) checkDates[st.at.slice(0, 10)] = 1;
        }
        if (st.s === 0 && d.day < todayI) overdue++;
        if (d.day === todayI) {
          if (st.s !== 2) todayTotal++;
          if (st.s === 1) todayDone++;
        }
      });
    });
    var checkDayCount = Object.keys(checkDates).length;
    var streak = 0, cursor = todayStr();
    if (!checkDates[cursor]) cursor = addDays(cursor, -1); // 今天还没打不算断
    while (checkDates[cursor]) { streak++; cursor = addDays(cursor, -1); }
    return {
      total: total, done: done, skipped: skipped, overdue: overdue,
      todayDone: todayDone, todayTotal: todayTotal,
      pct: total ? Math.round(done * 100 / total) : 0,
      per: per, checkDayCount: checkDayCount, streak: streak, todayI: todayI
    };
  }

  // ---------- 模板导入校验 ----------
  function normalizeTemplate(obj) {
    if (!obj || typeof obj !== 'object') throw new Error('文件不是有效的 JSON 对象');
    if (!Array.isArray(obj.days) || !obj.days.length) throw new Error('缺少 days 数组（至少要有1天）');
    var subjects = ['政治', '英语二', '333', '862', '其他'];
    if (Array.isArray(obj.subjects)) {
      obj.subjects.forEach(function (s) {
        if (typeof s === 'string' && s && subjects.indexOf(s) < 0) subjects.push(s);
      });
    }
    var days = obj.days.slice().sort(function (a, b) { return (a.day || 0) - (b.day || 0); });
    var outDays = days.map(function (d, i) {
      var tks = Array.isArray(d.tasks) ? d.tasks : [];
      if (!tks.length) throw new Error('第 ' + (d.day || i + 1) + ' 天没有任务');
      return {
        day: i + 1,
        tasks: tks.map(function (tk, j) {
          var title = (tk && tk.title != null) ? String(tk.title).trim() : '';
          if (!title) throw new Error('第 ' + (i + 1) + ' 天第 ' + (j + 1) + ' 个任务缺少 title');
          var subj = String(tk.subject || '其他');
          if (subjects.indexOf(subj) < 0) subj = '其他';
          var minutes = parseInt(tk.minutes, 10);
          return { title: title, subject: subj, minutes: Number.isFinite(minutes) && minutes >= 0 ? minutes : 0 };
        })
      };
    });
    return {
      format: 'daka-template@1',
      id: 'tpl-' + Date.now(),
      name: String(obj.name || '未命名模板').slice(0, 60),
      author: String(obj.author || '导入模板').slice(0, 30),
      totalDays: outDays.length,
      subjects: subjects,
      days: outDays
    };
  }

  // ---------- 小部件 ----------
  function toast(msg) {
    var el = document.createElement('div');
    el.className = 'toast';
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(function () { el.classList.add('show'); }, 10);
    setTimeout(function () {
      el.classList.remove('show');
      setTimeout(function () { el.remove(); }, 300);
    }, 2200);
  }
  function download(filename, text) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  }
  function subjTag(s) { return '<span class="tag tag-' + esc(s) + '">' + esc(s) + '</span>'; }

  function taskRow(plan, day, idx, tk, st, readonly) {
    var done = st.s === 1, skipped = st.s === 2;
    var cls = 'task' + (done ? ' done' : '') + (skipped ? ' skipped' : '');
    var h = '<div class="' + cls + '">';
    h += '<label class="check"><input type="checkbox" class="task-check" data-day="' + day +
      '" data-idx="' + idx + '"' + (done ? ' checked' : '') + (readonly ? ' disabled' : '') +
      '><span class="box"></span></label>';
    h += '<div class="task-body"><div class="task-title">' + esc(tk.title) + '</div>';
    h += '<div class="task-meta">' + subjTag(tk.subject || '其他');
    if (tk.minutes) h += '<span class="mins">' + tk.minutes + '分钟</span>';
    h += '</div></div>';
    if (!readonly) {
      h += '<button class="skip" data-act="skip" data-day="' + day + '" data-idx="' + idx + '">' +
        (skipped ? '恢复' : '跳过') + '</button>';
    }
    return h + '</div>';
  }

  // ---------- 页面：今日 ----------
  function renderToday(plan) {
    if (!plan) return renderPlanForm(null);
    var st = computeStats(plan);
    var t = todayStr();
    var h = '<section class="page">';

    // 头部卡片
    h += '<div class="card hero"><div class="hero-name">' + esc(plan.name) + '</div><div class="hero-row">';
    if (plan.examDate) {
      var left = diffDays(t, plan.examDate);
      h += '<div class="count"><div class="count-num">' + (left >= 0 ? left : 0) + '</div>' +
        '<div class="count-label">' + (left >= 0 ? '天后考试 (' + md(plan.examDate) + ')' : '考试已结束') + '</div></div>';
    }
    if (st.todayI < 1) {
      h += '<div class="hero-side">计划 ' + md(plan.startDate) + ' 开始<br>还有 ' + (1 - st.todayI) + ' 天</div>';
    } else if (st.todayI > plan.snapshot.totalDays) {
      h += '<div class="hero-side">152天计划已结束<br>' + (st.overdue ? '还有 ' + st.overdue + ' 项待补' : '全部完成，稳住！') + '</div>';
    } else {
      h += '<div class="hero-side">第 ' + st.todayI + ' / ' + plan.snapshot.totalDays + ' 天<br>今日 ' +
        st.todayDone + '/' + st.todayTotal + ' 项</div>';
    }
    h += '</div>';
    if (st.todayTotal) {
      var p = Math.round(st.todayDone * 100 / st.todayTotal);
      h += '<div class="bar"><div class="bar-in" style="width:' + p + '%"></div></div>';
    }
    h += '</div>';

    if (st.todayI < 1) {
      h += '<div class="card muted-card">计划还没开始，可以先去「模板」页熟悉内容，或调整开始日期。</div></section>';
      return h;
    }

    // 积压补做区（未完成的任务自动累计到今天）
    if (st.overdue > 0) {
      h += '<div class="sec-title overdue-title">积压补做（' + st.overdue + ' 项）<span class="sec-tip">之前没完成的会自动累计到这里</span></div>';
      var limit = Math.min(st.todayI - 1, plan.snapshot.totalDays);
      for (var d = 1; d <= limit; d++) {
        var dayObj = plan.snapshot.days[d - 1];
        var rows = '';
        dayObj.tasks.forEach(function (tk, i) {
          var s = peekState(plan, d, i);
          if (s.s === 0) rows += taskRow(plan, d, i, tk, s, false);
        });
        if (rows) {
          h += '<div class="day-group"><div class="day-group-title">第 ' + d + ' 天 · ' +
            md(dateOfDay(plan, d)) + '</div>' + rows + '</div>';
        }
      }
    }

    // 今日任务区
    if (st.todayI <= plan.snapshot.totalDays) {
      h += '<div class="sec-title">今日任务 · ' + md(t) + '</div>';
      var todayObj = plan.snapshot.days[st.todayI - 1];
      todayObj.tasks.forEach(function (tk, i) {
        h += taskRow(plan, st.todayI, i, tk, peekState(plan, st.todayI, i), false);
      });
      if (st.todayTotal > 0 && st.todayDone === st.todayTotal && st.overdue === 0) {
        h += '<div class="card praise">今日任务全部完成，太棒了！</div>';
      }
    }
    return h + '</section>';
  }

  // ---------- 页面：日历 ----------
  var ui = { tab: 'today', calY: 0, calM: 0, selDay: null, showNewPlan: false };

  function renderCalendar(plan) {
    if (!plan) return renderPlanForm(null);
    if (!ui.calY) {
      var ref = parse(ui.selDay || todayStr());
      ui.calY = ref.getFullYear(); ui.calM = ref.getMonth() + 1;
    }
    var first = new Date(ui.calY, ui.calM - 1, 1);
    var startWeekday = (first.getDay() + 6) % 7; // 周一开头
    var daysInMonth = new Date(ui.calY, ui.calM, 0).getDate();
    var t = todayStr();

    var h = '<section class="page"><div class="card"><div class="cal-head">';
    h += '<button class="cal-nav" data-act="cal-nav" data-dir="-1">‹</button>';
    h += '<div class="cal-title">' + ui.calY + ' 年 ' + ui.calM + ' 月</div>';
    h += '<button class="cal-nav" data-act="cal-nav" data-dir="1">›</button></div>';
    h += '<div class="cal-grid">';
    ['一', '二', '三', '四', '五', '六', '日'].forEach(function (w) {
      h += '<div class="cal-wd">' + w + '</div>';
    });
    for (var i = 0; i < startWeekday; i++) h += '<div class="cal-cell empty"></div>';
    for (var dd = 1; dd <= daysInMonth; dd++) {
      var ds = fmt(new Date(ui.calY, ui.calM - 1, dd));
      var di = dayIdxOf(plan, ds);
      var cls = 'cal-cell', mark = '';
      if (di >= 1 && di <= plan.snapshot.totalDays) {
        var dayObj = plan.snapshot.days[di - 1];
        var dn = 0, eff = 0;
        dayObj.tasks.forEach(function (tk, k) {
          var s2 = peekState(plan, di, k).s;
          if (s2 !== 2) eff++;
          if (s2 === 1) dn++;
        });
        if (eff > 0 && dn === eff) cls += ' full';
        else if (dn > 0) cls += ' part';
        else if (ds <= t) cls += ' miss';
        mark = '<span class="cal-dot"></span>';
      }
      if (ds === t) cls += ' today';
      if (ds === ui.selDay) cls += ' sel';
      h += '<div class="' + cls + '" data-act="cal-day" data-date="' + ds + '">' + dd + mark + '</div>';
    }
    h += '</div><div class="cal-legend">' +
      '<span><i class="lg full"></i>全完成</span><span><i class="lg part"></i>部分完成</span>' +
      '<span><i class="lg miss"></i>缺卡</span></div></div>';

    // 选中日详情
    var sel = ui.selDay || t;
    var selI = dayIdxOf(plan, sel);
    if (selI >= 1 && selI <= plan.snapshot.totalDays) {
      var readonly = selI > dayIdxOf(plan, t); // 未来不可打卡
      h += '<div class="sec-title">' + md(sel) + ' · 第 ' + selI + ' 天' +
        (readonly ? '（未到，不可打卡）' : '') + '</div>';
      plan.snapshot.days[selI - 1].tasks.forEach(function (tk, k) {
        h += taskRow(plan, selI, k, tk, peekState(plan, selI, k), readonly);
      });
    } else {
      h += '<div class="card muted-card">这一天不在计划范围内。</div>';
    }
    return h + '</section>';
  }

  // ---------- 页面：统计（按 Stitch 设计稿 Breezy Mint 布局） ----------
  var ICONS = {
    fire: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2c.8 3.8-4.5 5.3-4.5 10a4.5 4.5 0 0 0 9 0c0-1.4-.5-2.4-1-3.3-.7.9-1.4 1.4-1.4 1.4C14.5 7 13.2 4.2 12 2z"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm-1.3 14.3-4-4 1.4-1.4 2.6 2.6 5.6-5.6 1.4 1.4-7 7z"/></svg>',
    hour: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 3h10v3.6L13.8 10l3.2 3.4V17H7v-3.6L10.2 10 7 6.6V3zm2.4 12.4V15l2.6-2.8 2.6 2.8v.4H9.4z"/></svg>',
    cal: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M5 4h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zm2 3v2h10V7H7z"/></svg>'
  };
  function statMini(icon, label, num, unit) {
    return '<div class="card mini"><div class="mini-head"><span class="mini-ic">' + icon + '</span>' + label + '</div>' +
      '<div class="mini-num">' + num + '<span class="mini-unit">' + unit + '</span></div></div>';
  }
  function renderStats(plan) {
    if (!plan) return renderPlanForm(null);
    var st = computeStats(plan);
    var C = 282.7; // 2πr, r=45（同 Stitch 稿）
    var off = (C * (1 - st.pct / 100)).toFixed(1);
    var h = '<section class="page">';
    h += '<div class="stats-head"><h2>打卡计划统计</h2><p>保持专注，持续进步</p></div>';

    // 总进度圆环
    h += '<div class="card ring-card"><h3 class="card-title">总计进度</h3>' +
      '<div class="ring-wrap"><svg viewBox="0 0 100 100">' +
      '<circle class="ring-bg" cx="50" cy="50" r="45"></circle>' +
      '<circle class="ring-fg" cx="50" cy="50" r="45" stroke-dasharray="' + C + '" stroke-dashoffset="' + off + '"></circle>' +
      '</svg><div class="ring-center"><b>' + st.pct + '%</b><span>已完成</span></div></div>' +
      '<p class="ring-note">' + st.done + ' / ' + st.total + ' 项任务' +
      (st.skipped ? ' · 已跳过 ' + st.skipped + ' 项' : '') + '</p>' +
      (st.overdue ? '<p class="ring-note warn">积压待补 ' + st.overdue + ' 项</p>'
                  : '<p class="ring-note ok">无积压，保持！</p>') +
      '</div>';

    // 2×2 数据卡
    h += '<div class="grid2">' +
      statMini(ICONS.fire, '连续打卡', st.streak, '天') +
      statMini(ICONS.check, '累计打卡', st.checkDayCount, '天') +
      statMini(ICONS.hour, '距考试', plan.examDate ? Math.max(diffDays(todayStr(), plan.examDate), 0) : '—', '天') +
      statMini(ICONS.cal, '计划剩余', Math.max(plan.snapshot.totalDays - st.todayI + 1, 0), '天') +
      '</div>';

    // 科目进度（pastel 进度条）
    h += '<div class="card"><h3 class="card-title">科目进度</h3>';
    Object.keys(st.per).forEach(function (subj) {
      var p = st.per[subj];
      var pct = p.total ? Math.round(p.done * 100 / p.total) : 0;
      h += '<div class="subj-row"><div class="subj-head"><span>' + esc(subj) + '</span>' +
        '<span class="muted">' + pct + '% · ' + p.done + '/' + p.total + '</span></div>' +
        '<div class="bar"><div class="bar-in subj-' + esc(subj) + '" style="width:' + pct + '%"></div></div></div>';
    });
    return h + '</div></section>';
  }

  // ---------- 页面：模板 / 计划管理 ----------
  function renderTplPage(plan) {
    var h = '<section class="page">';

    // 我的计划
    h += '<div class="sec-title">我的计划</div>';
    if (!plans.length) h += '<div class="card muted-card">还没有计划，点击下方「新建计划」开始。</div>';
    plans.forEach(function (p) {
      var st = computeStats(p);
      var on = activePlan() === p;
      h += '<div class="card plan-row"><div class="plan-info"><b>' + esc(p.name) + '</b>' +
        '<span class="muted">' + md(p.startDate) + ' 开始 · ' + st.pct + '%</span></div>' +
        '<div class="plan-btns">' +
        (on ? '<span class="badge">当前</span>' :
          '<button class="btn small" data-act="plan-activate" data-id="' + p.id + '">启用</button>') +
        '<button class="btn small danger" data-act="plan-delete" data-id="' + p.id + '">删除</button>' +
        '</div></div>';
    });
    h += '<button class="btn primary block" data-act="newplan-toggle">＋ 新建计划</button>';
    if (ui.showNewPlan) h += renderPlanFormInner(null);

    // 模板库
    h += '<div class="sec-title">模板库</div>';
    allTemplates().forEach(function (tp) {
      var isBuiltin = tp.id === builtin.id;
      h += '<div class="card plan-row"><div class="plan-info"><b>' + esc(tp.name) + '</b>' +
        '<span class="muted">' + esc(tp.author || '') + ' · ' + tp.totalDays + ' 天 · ' +
        tp.days.reduce(function (s, d) { return s + d.tasks.length; }, 0) + ' 个任务</span></div>' +
        '<div class="plan-btns">' +
        '<button class="btn small" data-act="tpl-export" data-id="' + tp.id + '">导出</button>' +
        (isBuiltin ? '' : '<button class="btn small danger" data-act="tpl-delete" data-id="' + tp.id + '">删除</button>') +
        '</div></div>';
    });
    h += '<label class="btn block ghost">导入模板文件（.json）' +
      '<input type="file" id="fileTpl" accept=".json,application/json" hidden></label>';

    // 模板制作说明
    h += '<details class="card help"><summary>如何制作模板发给别人？</summary>' +
      '<p>模板是一个 JSON 文件，<b>只存"第N天"，不存具体日期</b>——别人导入后选自己的开始日期即可铺开。</p>' +
      '<p>先用 Excel 列四列：<code>第几天 | 任务内容 | 科目 | 预计分钟</code>，然后让 AI 转成下面的格式：</p>' +
      '<pre>{\n  "name": "模板名",\n  "author": "你的名字",\n  "days": [\n    { "day": 1, "tasks": [\n      { "title": "背单词40分钟", "subject": "英语二", "minutes": 40 }\n    ] }\n  ]\n}</pre>' +
      '<p>做好后把 .json 文件微信发给对方，她在「模板库 → 导入模板文件」里选择即可。</p></details>';

    // 数据备份
    h += '<div class="sec-title">数据备份</div>';
    h += '<div class="row-btns"><button class="btn ghost" data-act="backup-export">导出打卡数据</button>' +
      '<label class="btn ghost">导入打卡数据<input type="file" id="fileBackup" accept=".json,application/json" hidden></label></div>';
    h += '<p class="muted small-note">打卡数据只存在本机浏览器里，清除浏览器数据会丢失，建议每月导出备份一次。</p>';

    return h + '</section>';
  }

  // ---------- 新建计划表单 ----------
  function renderPlanFormInner(plan) {
    var opts = allTemplates().map(function (tp) {
      return '<option value="' + tp.id + '"' + (tp.id === builtin.id ? ' selected' : '') + '>' +
        esc(tp.name) + '（' + tp.totalDays + '天）</option>';
    }).join('');
    return '<div class="card form-card">' +
      '<div class="form-row"><label>选择模板</label><select id="fTpl">' + opts + '</select></div>' +
      '<div class="form-row"><label>计划名称</label><input id="fName" type="text" placeholder="默认用模板名"></div>' +
      '<div class="form-row"><label>开始日期</label><input id="fStart" type="date" value="' +
      (builtin.startDateHint || todayStr()) + '"></div>' +
      '<div class="form-row"><label>考试/目标日期</label><input id="fExam" type="date" value="' +
      (builtin.examDateHint || '') + '"></div>' +
      '<button class="btn primary block" data-act="plan-create">创建计划</button></div>';
  }
  function renderPlanForm(plan) {
    return '<section class="page"><div class="card hero"><div class="hero-name">欢迎使用打卡计划</div>' +
      '<div class="muted">选一个模板、定个开始日期，系统会把任务铺到每一天。<br>' +
      '没完成的任务会自动累计到后面，补完为止。</div></div>' + renderPlanFormInner(plan) + '</section>';
  }

  // ---------- 渲染入口 ----------
  var view = document.getElementById('view');
  function render() {
    var plan = activePlan();
    if (ui.tab === 'today') view.innerHTML = renderToday(plan);
    else if (ui.tab === 'cal') view.innerHTML = renderCalendar(plan);
    else if (ui.tab === 'stats') view.innerHTML = renderStats(plan);
    else view.innerHTML = renderTplPage(plan);
    var btns = document.querySelectorAll('#tabs button');
    btns.forEach(function (b) { b.classList.toggle('on', b.dataset.tab === ui.tab); });
    window.scrollTo(0, 0);
  }

  // ---------- 事件（全部委托） ----------
  document.getElementById('tabs').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-tab]');
    if (!b) return;
    ui.tab = b.dataset.tab;
    render();
  });

  view.addEventListener('change', function (e) {
    var plan = activePlan();
    if (e.target.classList.contains('task-check')) {
      if (!plan) return;
      toggleDone(plan, +e.target.dataset.day, +e.target.dataset.idx);
      render();
      return;
    }
    if (e.target.id === 'fileTpl' && e.target.files[0]) {
      var fr = new FileReader();
      fr.onload = function () {
        try {
          var tp = normalizeTemplate(JSON.parse(fr.result));
          templates.push(tp);
          persist();
          toast('模板「' + tp.name + '」导入成功（' + tp.totalDays + '天）');
        } catch (err) { toast('导入失败：' + err.message); }
        render();
      };
      fr.readAsText(e.target.files[0]);
      return;
    }
    if (e.target.id === 'fileBackup' && e.target.files[0]) {
      var fr2 = new FileReader();
      fr2.onload = function () {
        try {
          var data = JSON.parse(fr2.result);
          if (!data || !Array.isArray(data.plans)) throw new Error('不是有效的备份文件');
          if (!confirm('导入会覆盖当前全部打卡数据，确定吗？')) return;
          plans = data.plans;
          activeId = data.activeId || (plans[0] && plans[0].id) || null;
          persist();
          toast('打卡数据已恢复');
          render();
        } catch (err) { toast('导入失败：' + err.message); }
      };
      fr2.readAsText(e.target.files[0]);
    }
  });

  view.addEventListener('click', function (e) {
    var el = e.target.closest('[data-act]');
    if (!el) return;
    var act = el.dataset.act;
    var plan = activePlan();

    if (act === 'skip') {
      toggleSkip(plan, +el.dataset.day, +el.dataset.idx);
      render();
    } else if (act === 'cal-nav') {
      var m = ui.calM + (+el.dataset.dir);
      ui.calY += m < 1 ? -1 : m > 12 ? 1 : 0;
      ui.calM = ((m + 11) % 12) + 1;
      render();
    } else if (act === 'cal-day') {
      ui.selDay = el.dataset.date;
      render();
    } else if (act === 'plan-activate') {
      activeId = el.dataset.id;
      persist();
      ui.tab = 'today';
      render();
    } else if (act === 'plan-delete') {
      if (confirm('确定删除这个计划吗？打卡记录会一起删除。')) {
        plans = plans.filter(function (p) { return p.id !== el.dataset.id; });
        if (activeId === el.dataset.id) activeId = plans[0] ? plans[0].id : null;
        persist();
        render();
      }
    } else if (act === 'newplan-toggle') {
      ui.showNewPlan = !ui.showNewPlan;
      render();
    } else if (act === 'plan-create') {
      var tplId = document.getElementById('fTpl').value;
      var name = document.getElementById('fName').value.trim();
      var start = document.getElementById('fStart').value;
      var exam = document.getElementById('fExam').value;
      if (!start) { toast('请选择开始日期'); return; }
      var p = createPlan(tplId, name, start, exam);
      if (!p) { toast('创建失败，请重试'); return; }
      ui.showNewPlan = false;
      ui.tab = 'today';
      ui.calY = 0; ui.selDay = null;
      toast('计划已创建，开始打卡吧！');
      render();
    } else if (act === 'tpl-export') {
      var tp = getTemplate(el.dataset.id);
      if (tp) download(tp.name + '.json', JSON.stringify(tp, null, 2));
    } else if (act === 'tpl-delete') {
      if (confirm('删除这个模板？已创建的计划不受影响。')) {
        templates = templates.filter(function (x) { return x.id !== el.dataset.id; });
        persist();
        render();
      }
    } else if (act === 'backup-export') {
      download('打卡数据备份-' + todayStr() + '.json',
        JSON.stringify({ plans: plans, activeId: activeId }, null, 2));
    }
  });

  // ---------- PWA ----------
  if ('serviceWorker' in navigator &&
    (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
    navigator.serviceWorker.register('sw.js').catch(function () { /* 离线增强，失败无碍 */ });
  }

  render();
})();
