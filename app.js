/**
 * 课表转日历 · 核心逻辑（纯函数，浏览器和 Node 共用）
 *
 * 浏览器：<script src="app.js"></script> 之后用 window.CourseCal
 * Node：  const C = require('./app.js')
 *
 * 这里不碰 DOM，所以 node test.js 能直接测。
 *
 * 两个 iCalendar 的坑，都在这里处理了：
 * 1. 文本字段里的 , ; 和换行必须转义，否则 SUMMARY 会被切成两段；
 * 2. 一行不能超过 75 字节，中文一个字 3 字节，必须按字节折行，
 *    而且不能把一个汉字拆成两半——拆了就是乱码。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CourseCal = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const TZID = 'Asia/Shanghai';
  const CRLF = '\r\n';

  const CN_NUM = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7, 七: 7 };
  const WEEKDAY_CN = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];

  // 默认作息，和常见高校一致；页面里可以改。
  const DEFAULT_PERIODS = [
    { start: '08:00', end: '08:45' },
    { start: '08:55', end: '09:40' },
    { start: '10:00', end: '10:45' },
    { start: '10:55', end: '11:40' },
    { start: '14:00', end: '14:45' },
    { start: '14:55', end: '15:40' },
    { start: '16:00', end: '16:45' },
    { start: '16:55', end: '17:40' },
    { start: '19:00', end: '19:45' },
    { start: '19:55', end: '20:40' },
    { start: '20:50', end: '21:35' },
    { start: '21:45', end: '22:30' }
  ];

  /* ---------------- 小工具 ---------------- */

  function pad2(n) {
    return n < 10 ? '0' + n : String(n);
  }

  /** 一个字符在 UTF-8 下占几个字节（for...of 按码点遍历） */
  function utf8Len(ch) {
    const c = ch.codePointAt(0);
    if (c < 0x80) return 1;
    if (c < 0x800) return 2;
    if (c < 0x10000) return 3;
    return 4;
  }

  /** 全角转半角：中文输入法下的 ｜ （ ） ， ～ 都能认 */
  function normalize(s) {
    return String(s == null ? '' : s)
      .replace(/[\uFF01-\uFF5E]/g, function (ch) {
        return String.fromCharCode(ch.charCodeAt(0) - 0xFEE0);
      })
      .replace(/\u3000/g, ' ')
      .replace(/、/g, ',');
  }

  function range(a, b) {
    const out = [];
    for (let i = a; i <= b; i++) out.push(i);
    return out;
  }

  /* ---------------- 解析一行课表 ---------------- */

  function pullWeekdays(text) {
    const re = /(?:周|星期|礼拜)\s*([一二三四五六日天]|[1-7])/g;
    const days = [];
    let m;
    while ((m = re.exec(text))) {
      const d = CN_NUM[m[1]] || Number(m[1]);
      if (d >= 1 && d <= 7 && days.indexOf(d) < 0) days.push(d);
    }
    return {
      days: days.sort(function (a, b) { return a - b; }),
      rest: text.replace(/(?:周|星期|礼拜)\s*([一二三四五六日天]|[1-7])/g, ' ')
    };
  }

  function pullWeeks(text) {
    // 1-16周 / 1-16周(单) / 1-16周单周 / 2-16双周
    let m = text.match(/(\d{1,2})\s*[-~至到]\s*(\d{1,2})\s*周\s*(?:\(\s*(单|双)\s*周?\s*\)|(单|双)\s*周)?/);
    if (m) {
      return { start: +m[1], end: +m[2], parity: m[3] || m[4] || '', rest: text.replace(m[0], ' ') };
    }
    m = text.match(/(\d{1,2})\s*周\s*(?:\(\s*(单|双)\s*周?\s*\)|(单|双)\s*周)?/);
    if (m) {
      return { start: +m[1], end: +m[1], parity: m[2] || m[3] || '', rest: text.replace(m[0], ' ') };
    }
    return null;
  }

  function pullPeriods(text) {
    let m = text.match(/(\d{1,2})\s*[-~至到]\s*(\d{1,2})\s*节/);
    if (m) return { start: +m[1], end: +m[2], rest: text.replace(m[0], ' ') };

    m = text.match(/(\d{1,2})\s*,\s*(\d{1,2})\s*节/);
    if (m) return { start: +m[1], end: +m[2], rest: text.replace(m[0], ' ') };

    m = text.match(/第?\s*(\d{1,2})\s*节/);
    if (m) return { start: +m[1], end: +m[1], rest: text.replace(m[0], ' ') };

    return null;
  }

  function pullTeacher(text) {
    const m = text.match(/([^\s|,]{1,8}?)\s*(?:老师|教师)/);
    if (!m) return { teacher: '', rest: text };
    return { teacher: m[1] + '老师', rest: text.replace(m[0], ' ') };
  }

  function weeksFromRange(start, end, parity) {
    const out = [];
    let s = start;
    if (parity === '单' && s % 2 === 0) s += 1;
    if (parity === '双' && s % 2 === 1) s += 1;
    const step = parity ? 2 : 1;
    for (let w = s; w <= end; w += step) out.push(w);
    return out;
  }

  /**
   * 解析一行。返回 { course } 或 { error }。
   * 例：高等数学 | 周一 1-2节 | 1-16周 | 教三-201 | 张老师
   */
  function parseLine(raw, opts) {
    const line = normalize(raw).trim();
    if (!line) return null;

    const wd = pullWeekdays(line);
    if (!wd.days.length) return { error: '没找到星期，比如「周一」' };

    let rest = wd.rest;

    const wk = pullWeeks(rest);
    if (wk) rest = wk.rest;

    let pd = pullPeriods(rest);
    if (pd) {
      rest = pd.rest;
    } else if (wk) {
      // 没写「节」，但周次已经抽走了，剩下的 1-2 大概率就是节次
      const m = rest.match(/(\d{1,2})\s*[-~]\s*(\d{1,2})/);
      if (m) {
        pd = { start: +m[1], end: +m[2] };
        rest = rest.replace(m[0], ' ');
      }
    }
    if (!pd) return { error: '没找到节次，比如「1-2节」' };

    const tr = pullTeacher(rest);
    rest = tr.rest;

    let pieces = rest
      .split(/[|,\t]+|\s{2,}/)
      .map(function (t) { return t.trim(); })
      .filter(function (t) { return t && !/^[\/\\\-·,]+$/.test(t); });

    if (pieces.length === 1) {
      pieces = pieces[0].split(/\s+/).filter(Boolean);
    }

    const name = pieces[0] || '';
    if (!name) return { error: '没找到课程名' };

    const total = (opts && opts.totalWeeks) || 18;
    let weeks;
    let note = '';
    if (wk) {
      weeks = weeksFromRange(wk.start, wk.end, wk.parity);
    } else {
      weeks = range(1, total);
      note = '没写周次，按 1-' + total + ' 周处理';
    }

    return {
      course: {
        name: name,
        weekdays: wd.days,
        startPeriod: pd.start,
        endPeriod: pd.end,
        weeks: weeks,
        location: pieces.slice(1).join(' ') || '',
        teacher: tr.teacher || '',
        note: note
      }
    };
  }

  /** 整段粘贴文本 -> { courses, errors } */
  function parsePaste(text, opts) {
    const courses = [];
    const errors = [];
    String(text == null ? '' : text).split(/\r?\n/).forEach(function (raw, i) {
      const line = raw.trim();
      if (!line) return;
      if (/^(#|\/\/)/.test(line)) return; // 注释行
      const r = parseLine(line, opts);
      if (!r) return;
      if (r.error) errors.push({ index: i + 1, text: line, reason: r.error });
      else courses.push(r.course);
    });
    return { courses: courses, errors: errors };
  }

  /* ---------------- 日期 ---------------- */

  /** 第 week 周、星期 weekday（1=周一）对应的日期（本地时区） */
  function weekToDate(termStart, week, weekday) {
    const p = String(termStart).split('-').map(Number);
    const d = new Date(p[0], p[1] - 1, p[2]);
    d.setDate(d.getDate() + (week - 1) * 7 + (weekday - 1));
    return d;
  }

  function fmtLocal(d) {
    return '' + d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) +
      'T' + pad2(d.getHours()) + pad2(d.getMinutes()) + '00';
  }

  function fmtUtc(d) {
    return '' + d.getUTCFullYear() + pad2(d.getUTCMonth() + 1) + pad2(d.getUTCDate()) +
      'T' + pad2(d.getUTCHours()) + pad2(d.getUTCMinutes()) + pad2(d.getUTCSeconds()) + 'Z';
  }

  /* ---------------- iCalendar ---------------- */

  function escapeText(v) {
    return String(v == null ? '' : v)
      .replace(/\\/g, '\\\\')
      .replace(/;/g, '\\;')
      .replace(/,/g, '\\,')
      .replace(/\r\n|\r|\n/g, '\\n');
  }

  /** 按 75 字节折行；续行以空格开头，空格也算字节；不切开汉字 */
  function foldLine(line) {
    const LIMIT = 75;
    const s = String(line);
    if (!s) return '';

    const out = [];
    let cur = '';
    let bytes = 0;
    let first = true;

    for (const ch of s) {
      const b = utf8Len(ch);
      const limit = first ? LIMIT : LIMIT - 1;
      if (cur && bytes + b > limit) {
        out.push(cur);
        cur = '';
        bytes = 0;
        first = false;
      }
      cur += ch;
      bytes += b;
    }
    if (cur) out.push(cur);
    return out.join(CRLF + ' ');
  }

  /** 周次 -> 一个 RRULE 能表达的几段；表达不了就一周一个事件 */
  function groupRuns(weeks) {
    if (weeks.length <= 1) return [{ weeks: weeks.slice(), step: 1 }];

    const diffs = [];
    for (let i = 1; i < weeks.length; i++) diffs.push(weeks[i] - weeks[i - 1]);

    const uniform = diffs.every(function (d) { return d === diffs[0]; });
    if (uniform && (diffs[0] === 1 || diffs[0] === 2)) {
      return [{ weeks: weeks.slice(), step: diffs[0] }];
    }
    return weeks.map(function (w) { return { weeks: [w], step: 1 }; });
  }

  function formatWeeks(weeks) {
    if (!weeks || !weeks.length) return '';
    if (weeks.length === 1) return weeks[0] + '周';

    const step = weeks[1] - weeks[0];
    const last = weeks[weeks.length - 1];

    if (step === 1 && last - weeks[0] + 1 === weeks.length) {
      return weeks[0] + '-' + last + '周';
    }
    if (step === 2) {
      return weeks[0] + '-' + last + '周(' + (weeks[0] % 2 === 1 ? '单' : '双') + ')';
    }
    return weeks.join(',') + '周';
  }

  function hashStr(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  }

  function makeEvent(course, weekday, run, termStart, periods, remind, stamp) {
    const sp = periods[course.startPeriod - 1];
    const ep = periods[course.endPeriod - 1];
    if (!sp || !ep || !termStart) return null;

    const first = run.weeks[0];
    const d1 = weekToDate(termStart, first, weekday);
    const d2 = weekToDate(termStart, first, weekday);
    const sh = sp.start.split(':');
    const eh = ep.end.split(':');
    d1.setHours(+sh[0], +sh[1], 0, 0);
    d2.setHours(+eh[0], +eh[1], 0, 0);

    const desc = [];
    if (course.teacher) desc.push('教师：' + course.teacher);
    desc.push('周次：' + formatWeeks(run.weeks));

    const uid = 'cc-' + hashStr(
      course.name + '|' + weekday + '|' + course.startPeriod + '-' + course.endPeriod + '|' + run.weeks.join(',')
    ) + '@course-to-calendar';

    const out = [];
    out.push('BEGIN:VEVENT');
    out.push('UID:' + uid);
    out.push('DTSTAMP:' + stamp);
    out.push('DTSTART;TZID=' + TZID + ':' + fmtLocal(d1));
    out.push('DTEND;TZID=' + TZID + ':' + fmtLocal(d2));
    out.push('SUMMARY:' + escapeText(course.name));
    if (course.location) out.push('LOCATION:' + escapeText(course.location));
    out.push('DESCRIPTION:' + escapeText(desc.join('\n')));

    if (run.weeks.length > 1) {
      if (run.step === 2) {
        out.push('RRULE:FREQ=WEEKLY;INTERVAL=2;COUNT=' + run.weeks.length + ';WKST=MO');
      } else {
        out.push('RRULE:FREQ=WEEKLY;COUNT=' + run.weeks.length + ';WKST=MO');
      }
    }

    if (remind > 0) {
      out.push('BEGIN:VALARM');
      out.push('TRIGGER:-PT' + remind + 'M');
      out.push('ACTION:DISPLAY');
      out.push('DESCRIPTION:' + escapeText(course.name));
      out.push('END:VALARM');
    }
    out.push('END:VEVENT');
    return out;
  }

  /**
   * 生成 .ics 文本。
   * opts: { termStart:'YYYY-MM-DD', periods, remindMinutes, calendarName }
   */
  function buildIcs(courses, opts) {
    opts = opts || {};
    const termStart = opts.termStart;
    const periods = opts.periods && opts.periods.length ? opts.periods : DEFAULT_PERIODS;
    const remind = opts.remindMinutes == null ? 15 : Number(opts.remindMinutes);

    const lines = [];
    lines.push('BEGIN:VCALENDAR');
    lines.push('VERSION:2.0');
    lines.push('PRODID:-//course-to-calendar//zh-CN');
    lines.push('CALSCALE:GREGORIAN');
    lines.push('METHOD:PUBLISH');
    lines.push('X-WR-CALNAME:' + escapeText(opts.calendarName || '课表'));
    lines.push('X-WR-TIMEZONE:' + TZID);
    lines.push('BEGIN:VTIMEZONE');
    lines.push('TZID:' + TZID);
    lines.push('BEGIN:STANDARD');
    lines.push('DTSTART:19700101T000000');
    lines.push('TZOFFSETFROM:+0800');
    lines.push('TZOFFSETTO:+0800');
    lines.push('TZNAME:CST');
    lines.push('END:STANDARD');
    lines.push('END:VTIMEZONE');

    const stamp = fmtUtc(new Date());

    (courses || []).forEach(function (course) {
      const weeks = (course.weeks || []).slice().sort(function (a, b) { return a - b; });
      if (!weeks.length) return;
      const days = course.weekdays && course.weekdays.length ? course.weekdays : [];
      days.forEach(function (wd) {
        groupRuns(weeks).forEach(function (run) {
          const ev = makeEvent(course, wd, run, termStart, periods, remind, stamp);
          if (ev) lines.push.apply(lines, ev);
        });
      });
    });

    lines.push('END:VCALENDAR');
    return lines.map(foldLine).join(CRLF) + CRLF;
  }

  /** 这门课在日历里会占多少个事件（含 RRULE 展开的） */
  function countEvents(courses) {
    let n = 0;
    (courses || []).forEach(function (c) {
      const days = (c.weekdays || []).length;
      n += days * (c.weeks || []).length;
    });
    return n;
  }

  return {
    TZID: TZID,
    DEFAULT_PERIODS: DEFAULT_PERIODS,
    WEEKDAY_CN: WEEKDAY_CN,
    normalize: normalize,
    parseLine: parseLine,
    parsePaste: parsePaste,
    weeksFromRange: weeksFromRange,
    weekToDate: weekToDate,
    formatWeeks: formatWeeks,
    escapeText: escapeText,
    foldLine: foldLine,
    buildIcs: buildIcs,
    countEvents: countEvents
  };
});