/**
 * 课表转日历 · 页面逻辑
 * 只碰 DOM，不做课表计算（计算都在 app.js 里）。
 */
(function () {
  'use strict';

  const C = window.CourseCal;
  const KEY = 'course-to-calendar/v1';
  const $ = function (id) { return document.getElementById(id); };

  const SAMPLE = [
    '高等数学 | 周一 1-2节 | 1-16周 | 教三-201 | 张老师',
    '大学英语 | 周三 3-4节 | 2-17周 | 外语楼302 | 李老师',
    '线性代数 | 周二 5-6节 | 1-15周(单) | 教二101'
  ].join('\n');

  function toISO(d) {
    return '' + d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0');
  }

  /** 本周周一 */
  function mondayISO() {
    const d = new Date();
    const back = (d.getDay() + 6) % 7;
    d.setDate(d.getDate() - back);
    return toISO(d);
  }

  const state = {
    termStart: '',
    totalWeeks: 18,
    remind: 15,
    periods: C.DEFAULT_PERIODS.map(function (p) { return { start: p.start, end: p.end }; }),
    courses: []
  };

  /* ---------------- 存取 ---------------- */

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return;
      const old = JSON.parse(raw);
      if (typeof old.termStart === 'string') state.termStart = old.termStart;
      if (Number(old.totalWeeks) >= 1) state.totalWeeks = Number(old.totalWeeks);
      if (old.remind != null) state.remind = Number(old.remind);
      if (Array.isArray(old.courses)) state.courses = old.courses;
      if (Array.isArray(old.periods) && old.periods.length === C.DEFAULT_PERIODS.length) {
        state.periods = old.periods;
      }
    } catch (e) {
      /* 缓存坏了就当没有，不拦着用户用 */
    }
  }

  function save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
    } catch (e) {
      /* 隐身模式下可能写不进去，不影响导出 */
    }
  }

  /* ---------------- 渲染 ---------------- */

  function renderTerm() {
    $('termStart').value = state.termStart;
    $('totalWeeks').value = state.totalWeeks;
    $('remind').value = String(state.remind);
    checkTerm();
  }

  function isMonday(iso) {
    if (!iso) return false;
    const d = new Date(iso + 'T00:00:00');
    return !isNaN(d.getTime()) && d.getDay() === 1;
  }

  function checkTerm() {
    const hint = $('termHint');
    const ok = isMonday(state.termStart);
    $('downloadBtn').disabled = !ok || !state.courses.length;
    if (!state.termStart) {
      hint.textContent = '先选第 1 周的周一。';
      hint.className = 'hint bad';
    } else if (!ok) {
      hint.textContent = '这一天不是周一，整张课表都会错位，请改选第 1 周的周一。';
      hint.className = 'hint bad';
    } else {
      hint.textContent = '第 1 周从 ' + state.termStart + '（周一）开始，共 ' + state.totalWeeks + ' 周。';
      hint.className = 'hint';
    }
  }

  function renderList() {
    const box = $('list');
    const count = $('count');
    box.textContent = '';
    count.textContent = state.courses.length ? state.courses.length + ' 门' : '';

    if (!state.courses.length) {
      const p = document.createElement('p');
      p.className = 'hint';
      p.textContent = '还没有课程。上面粘一段课表，或者手动添加。';
      box.appendChild(p);
    } else {
      state.courses.forEach(function (c, i) {
        const item = document.createElement('div');
        item.className = 'item';

        const left = document.createElement('div');
        const name = document.createElement('div');
        name.className = 'name';
        name.textContent = c.name;

        const meta = document.createElement('div');
        meta.className = 'meta';
        const parts = [
          c.weekdays.map(function (d) { return C.WEEKDAY_CN[d]; }).join('、'),
          '第' + c.startPeriod + '-' + c.endPeriod + '节',
          C.formatWeeks(c.weeks)
        ];
        if (c.location) parts.push(c.location);
        if (c.teacher) parts.push(c.teacher);
        meta.textContent = parts.join(' · ');
        if (c.note) meta.textContent += '（' + c.note + '）';

        left.appendChild(name);
        left.appendChild(meta);

        const del = document.createElement('button');
        del.className = 'del';
        del.type = 'button';
        del.textContent = '删除';
        del.addEventListener('click', function () {
          state.courses.splice(i, 1);
          save();
          renderList();
          checkTerm();
        });

        item.appendChild(left);
        item.appendChild(del);
        box.appendChild(item);
      });
    }
    checkTerm();
  }

  function renderErrors(errors) {
    const box = $('errors');
    box.textContent = '';
    if (!errors || !errors.length) {
      box.hidden = true;
      return;
    }
    const title = document.createElement('b');
    title.textContent = '这 ' + errors.length + ' 行没看懂，改一下再试：';
    box.appendChild(title);
    errors.forEach(function (e) {
      const p = document.createElement('p');
      p.textContent = '第 ' + e.index + ' 行：' + e.text + ' —— ' + e.reason;
      box.appendChild(p);
    });
    box.hidden = false;
  }

  function renderPeriods() {
    const box = $('periods');
    box.textContent = '';
    state.periods.forEach(function (p, i) {
      const row = document.createElement('div');
      row.className = 'p';

      const label = document.createElement('span');
      label.textContent = '第' + (i + 1) + '节';

      const a = document.createElement('input');
      a.type = 'time';
      a.value = p.start;
      a.addEventListener('change', function () {
        p.start = a.value;
        save();
        refreshPreview();
      });

      const b = document.createElement('input');
      b.type = 'time';
      b.value = p.end;
      b.addEventListener('change', function () {
        p.end = b.value;
        save();
        refreshPreview();
      });

      row.appendChild(label);
      row.appendChild(a);
      row.appendChild(b);
      box.appendChild(row);
    });
  }

  /* ---------------- 生成与导出 ---------------- */

  function build() {
    return C.buildIcs(state.courses, {
      termStart: state.termStart,
      periods: state.periods,
      remindMinutes: state.remind
    });
  }

  function refreshPreview() {
    if (!$('previewWrap').open) return;
    $('preview').textContent = build().split('\r\n').slice(0, 40).join('\n') + '\n…';
  }

  function parse() {
    const result = C.parsePaste($('paste').value, { totalWeeks: state.totalWeeks });
    let added = 0;

    result.courses.forEach(function (c) {
      const dup = state.courses.some(function (x) {
        return x.name === c.name &&
          x.startPeriod === c.startPeriod &&
          x.endPeriod === c.endPeriod &&
          String(x.weekdays) === String(c.weekdays) &&
          String(x.weeks) === String(c.weeks);
      });
      if (!dup) {
        state.courses.push(c);
        added++;
      }
    });

    save();
    renderList();
    renderErrors(result.errors);
    refreshPreview();

    const msg = ['识别 ' + result.courses.length + ' 门', added ? '新增 ' + added + ' 门' : '（都已在列表里）'];
    if (result.errors.length) msg.push(result.errors.length + ' 行没看懂');
    $('status').textContent = msg.join('，');
  }

  /* ---------------- 绑定 ---------------- */

  $('termStart').addEventListener('change', function () {
    state.termStart = this.value;
    save();
    checkTerm();
    refreshPreview();
  });

  $('thisMonday').addEventListener('click', function () {
    state.termStart = mondayISO();
    $('termStart').value = state.termStart;
    save();
    checkTerm();
    refreshPreview();
  });

  $('totalWeeks').addEventListener('change', function () {
    const n = Math.max(1, Math.min(30, Number(this.value) || 18));
    this.value = n;
    state.totalWeeks = n;
    save();
    checkTerm();
  });

  $('remind').addEventListener('change', function () {
    state.remind = Number(this.value);
    save();
    refreshPreview();
  });

  $('parseBtn').addEventListener('click', parse);

  $('sampleBtn').addEventListener('click', function () {
    $('paste').value = SAMPLE;
    parse();
  });

  $('clearBtn').addEventListener('click', function () {
    $('paste').value = '';
    $('paste').focus();
  });

  $('addForm').addEventListener('submit', function (e) {
    e.preventDefault();
    const name = $('fName').value.trim();
    if (!name) return;

    const s = Number($('fStart').value) || 1;
    const en = Number($('fEnd').value) || s;
    const w1 = Number($('fW1').value) || 1;
    const w2 = Number($('fW2').value) || w1;

    state.courses.push({
      name: name,
      weekdays: [Number($('fDay').value) || 1],
      startPeriod: Math.min(s, en),
      endPeriod: Math.max(s, en),
      weeks: C.weeksFromRange(Math.min(w1, w2), Math.max(w1, w2), $('fParity').value),
      location: $('fLoc').value.trim(),
      teacher: $('fTeacher').value.trim(),
      note: ''
    });

    save();
    renderList();
    refreshPreview();
    $('status').textContent = '已添加「' + name + '」。';
    $('addForm').reset();
    $('fDay').value = '1';
    $('fStart').value = '1';
    $('fEnd').value = '2';
    $('fW1').value = '1';
    $('fW2').value = '16';
  });

  $('downloadBtn').addEventListener('click', function () {
    if (!state.courses.length) {
      $('status').textContent = '还没有课程。';
      return;
    }
    const ics = build();
    const blob = new Blob([ics], { type: 'text/calendar;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = '课表.ics';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);

    $('status').textContent = '已生成 ' + C.countEvents(state.courses) +
      ' 节课。导入日历后，课前 ' + (state.remind ? state.remind + ' 分钟' : '（不提醒）') + '会响。';
    refreshPreview();
  });

  $('copyBtn').addEventListener('click', function () {
    if (!state.courses.length) {
      $('status').textContent = '还没有课程。';
      return;
    }
    const ics = build();
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(ics).then(function () {
        $('status').textContent = '已复制到剪贴板，粘贴进日历或发给别人都行。';
      }, function () {
        $('status').textContent = '复制失败，打开「看看生成的内容」手动复制。';
        $('previewWrap').open = true;
        refreshPreview();
      });
    } else {
      $('status').textContent = '这个浏览器不支持自动复制，打开下面的内容手动复制。';
      $('previewWrap').open = true;
      refreshPreview();
    }
  });

  $('previewWrap').addEventListener('toggle', refreshPreview);

  /* ---------------- 启动 ---------------- */

  load();
  renderTerm();
  renderList();
  renderPeriods();
  if (state.courses.length) {
    $('status').textContent = '上次的 ' + state.courses.length + ' 门课还在，可以直接导出。';
  }
})();