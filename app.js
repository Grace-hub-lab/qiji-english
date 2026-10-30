(function () {
  "use strict";

  // ---------- 存储 ----------
  function load(key, fallback) {
    try { var v = JSON.parse(localStorage.getItem(key)); return v == null ? fallback : v; } catch (e) { return fallback; }
  }
  function save(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { /* 隐私模式下忽略 */ } }

  var favs = new Set(load("eng_favs", []));
  var sfavs = new Set(load("eng_sfavs", [])); // 收藏的每日一句（按英文原句）
  var mastered = new Set(load("eng_mastered", []));
  var days = load("eng_days", []);
  var prefs = Object.assign({ accent: "en-US", rate: 1, autoSpeak: false }, load("eng_prefs", {}));
  var best = load("eng_quiz_best", 0);

  // ---------- 日期 ----------
  var now = new Date();
  var WEEK = ["日", "一", "二", "三", "四", "五", "六"];
  function ymd(d) { return d.getFullYear() + "-" + (d.getMonth() + 1) + "-" + d.getDate(); }
  var TODAY = ymd(now);
  var dayOfYear = Math.floor((now - new Date(now.getFullYear(), 0, 0)) / 86400000);

  function checkIn() {
    if (days[days.length - 1] !== TODAY) { days.push(TODAY); if (days.length > 400) days = days.slice(-400); save("eng_days", days); renderStats(); }
  }
  function streak() {
    var set = new Set(days), n = 0, d = new Date(now);
    if (!set.has(ymd(d))) d.setDate(d.getDate() - 1); // 今天还没学，从昨天算起
    while (set.has(ymd(d))) { n++; d.setDate(d.getDate() - 1); }
    return n;
  }

  // ---------- 状态 ----------
  var GROUPS = Object.keys(RAW);
  var state = { mode: "learn", group: "全部", favOnly: false, idx: 0, revealed: false, queue: [], quiz: null, score: { right: 0, total: 0, run: 0 }, dayOffset: 0 };

  function pool() {
    var list = WORDS.filter(function (x) { return state.group === "全部" || x.g === state.group; });
    if (state.favOnly) list = list.filter(function (x) { return favs.has(x.w); });
    return list;
  }

  // ---------- 发音 ----------
  var tts = "speechSynthesis" in window;
  var voices = [];
  function loadVoices() { if (tts) voices = speechSynthesis.getVoices(); }
  if (tts) { loadVoices(); speechSynthesis.onvoiceschanged = loadVoices; }
  function speak(text, rate) {
    if (!tts) return;
    speechSynthesis.cancel();
    var u = new SpeechSynthesisUtterance(text.replace(/\s\/\s/g, ", "));
    u.lang = prefs.accent;
    u.rate = rate || Number(prefs.rate) || 1;
    var v = voices.filter(function (x) { return x.lang.replace("_", "-") === prefs.accent; })[0] ||
            voices.filter(function (x) { return /^en/i.test(x.lang); })[0];
    if (v) u.voice = v;
    speechSynthesis.speak(u);
  }

  // ---------- 小工具 ----------
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function shuffle(a) { a = a.slice(); for (var i = a.length - 1; i > 0; i--) { var j = Math.floor(Math.random() * (i + 1)); var t = a[i]; a[i] = a[j]; a[j] = t; } return a; }
  var stage = document.getElementById("stage");

  // 拆解片段刚好拼成单词时，给单词分段上色
  function wordHtml(x) {
    var joined = x.parts.map(function (p) { return p[0]; }).join("");
    var cls = x.w.length > 11 ? "word long" : "word";
    if (joined.toLowerCase() === x.w.toLowerCase() && x.parts.length > 1) {
      return '<span class="' + cls + '">' + x.parts.map(function (p, i) { return '<span class="s' + (i % 4) + '">' + esc(p[0]) + "</span>"; }).join("") + "</span>";
    }
    return '<span class="' + cls + '">' + esc(x.w) + "</span>";
  }
  function partsHtml(x) {
    return '<div class="parts">' + x.parts.map(function (p, i) {
      return (i ? '<span class="plus" aria-hidden="true">+</span>' : "") +
        '<div class="part p' + (i % 4) + '"><b>' + esc(p[0]) + "</b>" + (p[1] ? "<small>" + esc(p[1]) + "</small>" : "") + "</div>";
    }).join("") + "</div>";
  }
  function speakBtn(text, small) {
    if (!tts) return "";
    return '<button class="speak' + (small ? " small" : "") + '" data-say="' + esc(text) + '" aria-label="朗读 ' + esc(text) + '">🔊</button>';
  }
  function meaningHtml(x) { return '<div class="meaning"><span class="pos">' + esc(x.pos) + "</span>" + esc(x.cn) + "</div>"; }
  function detailHtml(x) {
    return partsHtml(x) +
      '<p class="story">' + esc(x.story) + "</p>" +
      '<div class="example">' + speakBtn(x.ex, true) + '<div><div class="en">' + esc(x.ex) + '</div><div class="zh">' + esc(x.exCn) + "</div></div></div>";
  }
  function topHtml(x, extra) {
    var tags = '<span class="tag">' + esc(x.g) + "</span>" + (extra || "") + (mastered.has(x.w) ? '<span class="tag done">已掌握</span>' : "");
    return '<div class="card-top"><div class="tags">' + tags + '</div><button class="star' + (favs.has(x.w) ? " on" : "") + '" data-fav="' + esc(x.w) + '" aria-label="收藏" aria-pressed="' + favs.has(x.w) + '">' + (favs.has(x.w) ? "★" : "☆") + "</button></div>";
  }
  function emptyHtml(msg) {
    return '<div class="card empty"><div class="big">' + (state.favOnly ? "☆" : "📭") + "</div><p>" + msg + "</p></div>";
  }

  // ---------- 学习模式 ----------
  function dailyIndex(list) { return list.length ? dayOfYear % list.length : 0; }

  function renderLearn() {
    var list = pool();
    if (!list.length) { stage.innerHTML = emptyHtml(state.favOnly ? "这里还没有收藏，点卡片右上角的 ☆ 收藏单词" : "暂无内容"); return; }
    if (state.idx >= list.length) state.idx = 0;
    var x = list[state.idx];
    var isToday = !state.favOnly && state.idx === dailyIndex(list);
    stage.innerHTML =
      '<article class="card" id="card">' + topHtml(x, isToday ? '<span class="tag today">今日单词</span>' : "") +
        '<div class="word-row">' + wordHtml(x) + speakBtn(x.w) + "</div>" +
        '<div class="ipa">/' + esc(x.ipa) + "/</div>" + meaningHtml(x) + detailHtml(x) +
        '<button class="mark-btn' + (mastered.has(x.w) ? " on" : "") + '" data-master="' + esc(x.w) + '">' + (mastered.has(x.w) ? "✓ 已掌握" : "标记为已掌握") + "</button>" +
      "</article>" +
      '<div class="nav"><button data-go="-1">← 上一个</button><button class="dice" data-go="rand" aria-label="随机一个">🎲</button><button data-go="1">下一个 →</button></div>' +
      '<div class="counter">' + (state.idx + 1) + " / " + list.length + " · 左右滑动切换</div>";
    bindSwipe();
  }

  function go(step) {
    var list = pool();
    if (!list.length) return;
    if (step === "rand") { var n; do { n = Math.floor(Math.random() * list.length); } while (list.length > 1 && n === state.idx); state.idx = n; }
    else state.idx = (state.idx + step + list.length) % list.length;
    render();
    checkIn();
    if (prefs.autoSpeak) speak(list[state.idx].w);
  }

  function bindSwipe() {
    var card = document.getElementById("card");
    if (!card) return;
    var sx = 0, sy = 0;
    card.addEventListener("touchstart", function (e) { sx = e.touches[0].clientX; sy = e.touches[0].clientY; }, { passive: true });
    card.addEventListener("touchend", function (e) {
      var dx = e.changedTouches[0].clientX - sx, dy = e.changedTouches[0].clientY - sy;
      if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) {
        if (state.mode === "daily") goDay(dx < 0 ? 1 : -1); else go(dx < 0 ? 1 : -1);
      }
    }, { passive: true });
  }

  // ---------- 抽背模式 ----------
  function buildQueue() {
    state.queue = shuffle(pool().filter(function (x) { return !mastered.has(x.w); }).map(function (x) { return x.w; }));
    state.revealed = false;
  }
  function findWord(w) { return WORDS.filter(function (x) { return x.w === w; })[0]; }

  function renderRecall() {
    var list = pool();
    if (!list.length) { stage.innerHTML = emptyHtml(state.favOnly ? "还没有收藏的单词" : "暂无内容"); return; }
    state.queue = state.queue.filter(function (w) { var x = findWord(w); return x && list.indexOf(x) >= 0 && !mastered.has(w); });
    if (!state.queue.length) {
      var all = list.every(function (x) { return mastered.has(x.w); });
      if (!all) { buildQueue(); return renderRecall(); }
      stage.innerHTML = '<div class="card empty"><div class="big">🎉</div><p>这一组 ' + list.length + ' 个词你都掌握了</p><button class="primary" data-restart="1">重新抽背这一组</button></div>';
      return;
    }
    var x = findWord(state.queue[0]);
    var left = state.queue.length;
    var html = '<article class="card" id="card">' + topHtml(x) +
      '<div class="word-row">' + wordHtml(x) + speakBtn(x.w) + "</div>" +
      '<div class="ipa">/' + esc(x.ipa) + "/</div>";
    if (!state.revealed) {
      html += '<p class="hint">先在心里想想它的意思，再看答案</p><button class="reveal-btn" data-reveal="1">显示答案</button>';
    } else {
      html += meaningHtml(x) + detailHtml(x) +
        '<div class="judge"><button class="no" data-judge="0">😵 还不熟</button><button class="yes" data-judge="1">😎 记住了</button></div>';
    }
    html += "</article>" + '<div class="counter">本组还剩 ' + left + " 个没掌握</div>";
    stage.innerHTML = html;
    if (prefs.autoSpeak && !state.revealed) speak(x.w);
  }

  function judge(ok) {
    var w = state.queue.shift();
    if (ok) { mastered.add(w); save("eng_mastered", Array.from(mastered)); }
    else { var pos = Math.min(state.queue.length, 3 + Math.floor(Math.random() * 3)); state.queue.splice(pos, 0, w); } // 不熟的过几张再出现
    state.revealed = false;
    checkIn();
    render();
    renderStats();
  }

  // ---------- 测验模式 ----------
  function newQuestion() {
    var list = pool();
    if (!list.length) { state.quiz = null; return; }
    var x = list[Math.floor(Math.random() * list.length)];
    if (state.quiz && list.length > 1) { var guard = 0; while (x.w === state.quiz.x.w && guard++ < 10) x = list[Math.floor(Math.random() * list.length)]; }
    var dir = x.g === "易混" ? "en2zh" : (Math.random() < 0.5 ? "en2zh" : "zh2en");
    var key = dir === "en2zh" ? "cn" : "w";
    // 干扰项优先同组，不够再从全部词里补
    var same = shuffle(WORDS.filter(function (y) { return y.g === x.g && y.w !== x.w; }));
    var others = shuffle(WORDS.filter(function (y) { return y.g !== x.g; }));
    var opts = [x[key]];
    same.concat(others).some(function (y) { if (opts.indexOf(y[key]) < 0) opts.push(y[key]); return opts.length >= 4; });
    state.quiz = { x: x, dir: dir, opts: shuffle(opts), answer: x[key], picked: null };
  }

  function renderQuiz() {
    if (!state.quiz || pool().indexOf(state.quiz.x) < 0) newQuestion();
    var q = state.quiz;
    if (!q) { stage.innerHTML = emptyHtml(state.favOnly ? "还没有收藏的单词，先去收藏几个吧" : "暂无内容"); return; }
    var x = q.x, s = state.score;
    var html = '<article class="card" id="card">' +
      '<div class="score"><span>本轮 ' + s.right + " / " + s.total + "</span><span>连对 " + s.run + " · 最高 " + best + "</span></div>";
    if (q.dir === "en2zh") {
      html += '<p class="q-prompt">这个词是什么意思？</p><div class="word-row"><span class="q-main">' + esc(x.w) + "</span>" + speakBtn(x.w) + '</div><div class="ipa">/' + esc(x.ipa) + "/</div>";
    } else {
      html += '<p class="q-prompt">哪个单词是这个意思？</p><div class="q-main zh">' + esc(x.cn) + "</div>";
    }
    html += '<div class="options">' + q.opts.map(function (o, i) {
      var cls = "opt";
      if (q.picked != null) { if (o === q.answer) cls += " right"; else if (i === q.picked) cls += " wrong"; }
      return '<button class="' + cls + '" data-opt="' + i + '"' + (q.picked != null ? " disabled" : "") + ">" + String.fromCharCode(65 + i) + ". " + esc(o) + "</button>";
    }).join("") + "</div>";
    if (q.picked != null) {
      var ok = q.opts[q.picked] === q.answer;
      html += '<div class="explain"><p class="hint">' + (ok ? "✅ 答对了" : "❌ 正确答案是 " + esc(q.answer)) + "</p>" +
        (q.dir === "zh2en" ? '<div class="word-row">' + wordHtml(x) + speakBtn(x.w) + '</div><div class="ipa">/' + esc(x.ipa) + "/</div>" : meaningHtml(x)) +
        detailHtml(x) + '<button class="primary" data-next="1">下一题</button></div>';
    }
    html += "</article>";
    stage.innerHTML = html;
  }

  function pick(i) {
    var q = state.quiz;
    if (!q || q.picked != null) return;
    q.picked = i;
    var ok = q.opts[i] === q.answer, s = state.score;
    s.total++;
    if (ok) { s.right++; s.run++; if (s.run > best) { best = s.run; save("eng_quiz_best", best); } }
    else { s.run = 0; if (mastered.delete(q.x.w)) save("eng_mastered", Array.from(mastered)); } // 答错的词退回「没掌握」
    checkIn();
    render();
    renderStats();
    if (prefs.autoSpeak) speak(q.x.w);
  }

  // ---------- 每日一句 ----------
  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function dateAt(offset) { var d = new Date(now.getFullYear(), now.getMonth(), now.getDate()); d.setDate(d.getDate() + offset); return d; }
  // 按「距 1970 年的天数」取句子，跨年也不会断档；每个日期固定对应一句
  function sentenceIndex(d) { return Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400000) % SENTENCES.length; }

  function sentenceCard(i, d, offset) {
    var s = SENTENCES[i], on = sfavs.has(s[0]);
    var dayLabel = offset === 0 ? "今天" : offset === -1 ? "昨天" : (-offset) + " 天前";
    return '<article class="card daily" id="card">' +
      '<div class="d-banner"><div class="d-num">' + d.getDate() + '</div><div class="d-meta"><b>' + MONTHS[d.getMonth()] + " · " + d.getFullYear() +
        "</b><span>星期" + WEEK[d.getDay()] + " · " + dayLabel + "</span></div>" +
        '<button class="star' + (on ? " on" : "") + '" data-sfav="' + i + '" aria-label="收藏这句" aria-pressed="' + on + '">' + (on ? "★" : "☆") + "</button></div>" +
      '<div class="d-body"><p class="d-label">每日一句 · DAILY</p>' +
        '<p class="d-en" lang="en">' + esc(s[0]) + "</p>" +
        '<p class="d-zh">' + esc(s[1]) + "</p>" +
        '<p class="d-src">—— ' + esc(s[2]) + "</p>" +
        '<div class="d-actions">' +
          (tts ? '<button data-say="' + esc(s[0]) + '">🔊 朗读</button><button data-slow="' + i + '">🐢 慢读</button>' : "") +
          '<button data-copy="' + i + '"' + (tts ? "" : ' style="grid-column:1/-1"') + ">📋 复制</button></div>" +
        '<div class="d-note"><b>📝 学一学：</b>' + esc(s[3]) + "</div>" +
      "</div></article>";
  }

  function renderDaily() {
    if (state.favOnly) {
      var list = SENTENCES.map(function (s, i) { return i; }).filter(function (i) { return sfavs.has(SENTENCES[i][0]); });
      if (!list.length) { stage.innerHTML = emptyHtml("还没有收藏的句子，点日期旁边的 ☆ 收藏"); return; }
      stage.innerHTML = '<div class="s-list">' + list.map(function (i) {
        var s = SENTENCES[i];
        return '<div class="s-item"><p class="d-en" lang="en">' + esc(s[0]) + '</p><p class="d-zh">' + esc(s[1]) + "</p>" +
          '<div class="s-row"><p class="d-src">—— ' + esc(s[2]) + "</p><span>" + speakBtn(s[0], true) +
          '<button class="star on" data-sfav="' + i + '" aria-label="取消收藏" aria-pressed="true">★</button></span></div></div>';
      }).join("") + "</div>";
      return;
    }
    var d = dateAt(state.dayOffset);
    var i = sentenceIndex(d);
    stage.innerHTML = sentenceCard(i, d, state.dayOffset) +
      '<div class="nav"><button data-day="-1">← 前一天</button><button class="dice" data-day="0" aria-label="回到今天"' + (state.dayOffset === 0 ? " disabled" : "") + '>今</button>' +
      '<button data-day="1"' + (state.dayOffset >= 0 ? " disabled" : "") + ">后一天 →</button></div>" +
      '<div class="counter">共 ' + SENTENCES.length + " 句，每天一句 · 可以往前翻看往期</div>";
    bindSwipe();
  }

  function goDay(step) {
    var next = step === 0 ? 0 : Math.min(0, state.dayOffset + step);
    if (next === state.dayOffset) return;
    state.dayOffset = next;
    render();
    checkIn();
    if (prefs.autoSpeak) speak(SENTENCES[sentenceIndex(dateAt(next))][0]);
  }

  var toastTimer;
  function toast(msg) {
    var t = document.getElementById("toast");
    t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.hidden = true; }, 1600);
  }
  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(function () { toast("已复制"); }, fallback);
    } else fallback();
    function fallback() {
      var ta = document.createElement("textarea");
      ta.value = text; ta.setAttribute("readonly", ""); ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); toast("已复制"); } catch (e) { toast("复制失败，请长按文字复制"); }
      document.body.removeChild(ta);
    }
  }

  // ---------- 总渲染 ----------
  function renderChips() {
    var el = document.getElementById("chips");
    el.innerHTML = ["全部"].concat(GROUPS).map(function (g) {
      return '<button class="chip' + (g === state.group ? " active" : "") + '" data-group="' + g + '" aria-pressed="' + (g === state.group) + '">' + g + "</button>";
    }).join("");
    var n = pool().length;
    document.getElementById("groupDesc").textContent =
      (state.favOnly ? "★ 我的收藏 · " : "") + (state.group === "全部" ? "全部分类" : GROUP_DESC[state.group]) + " · " + n + " 个词";
  }

  function renderStats() {
    var total = WORDS.length;
    document.getElementById("stats").innerHTML =
      "<span>已掌握 <b>" + mastered.size + "</b> / " + total + "</span>" +
      "<span>收藏 <b>" + (favs.size + sfavs.size) + "</b></span>" +
      "<span>连续打卡 <b>" + streak() + "</b> 天</span>";
  }

  function render() {
    var daily = state.mode === "daily";
    document.getElementById("filters").hidden = daily; // 每日一句不分类
    if (daily) return renderDaily();
    renderChips();
    if (state.mode === "learn") renderLearn();
    else if (state.mode === "recall") renderRecall();
    else renderQuiz();
  }

  function resetForGroup() {
    var list = pool();
    state.idx = state.favOnly ? 0 : dailyIndex(list);
    buildQueue();
    state.quiz = null;
  }

  // ---------- 事件 ----------
  document.addEventListener("click", function (e) {
    var t = e.target.closest("button");
    if (!t) return;
    var d = t.dataset;
    if (d.say) { speak(d.say); checkIn(); return; }
    if (d.slow) { speak(SENTENCES[Number(d.slow)][0], 0.65); checkIn(); return; }
    if (d.copy) { var s = SENTENCES[Number(d.copy)]; copyText(s[0] + "\n" + s[1] + "\n—— " + s[2]); return; }
    if (d.day) { goDay(Number(d.day)); return; }
    if (d.sfav) {
      var en = SENTENCES[Number(d.sfav)][0];
      if (sfavs.has(en)) sfavs.delete(en); else sfavs.add(en);
      save("eng_sfavs", Array.from(sfavs));
      render(); renderStats(); return;
    }
    if (d.fav) {
      if (favs.has(d.fav)) favs.delete(d.fav); else favs.add(d.fav);
      save("eng_favs", Array.from(favs));
      if (state.favOnly && state.mode === "learn" && state.idx >= pool().length) state.idx = Math.max(0, pool().length - 1);
      render(); renderStats(); return;
    }
    if (d.master) {
      if (mastered.has(d.master)) mastered.delete(d.master); else mastered.add(d.master);
      save("eng_mastered", Array.from(mastered));
      checkIn(); render(); renderStats(); return;
    }
    if (d.go) { go(d.go === "rand" ? "rand" : Number(d.go)); return; }
    if (d.group) { state.group = d.group; resetForGroup(); render(); return; }
    if (d.mode) {
      state.mode = d.mode;
      document.querySelectorAll(".mode").forEach(function (b) { var on = b.dataset.mode === d.mode; b.classList.toggle("active", on); b.setAttribute("aria-selected", on); });
      render(); return;
    }
    if (d.reveal) { state.revealed = true; render(); return; }
    if (d.judge) { judge(d.judge === "1"); return; }
    if (d.restart) {
      pool().forEach(function (x) { mastered.delete(x.w); });
      save("eng_mastered", Array.from(mastered));
      buildQueue(); render(); renderStats(); return;
    }
    if (d.opt) { pick(Number(d.opt)); return; }
    if (d.next) { newQuestion(); render(); return; }
  });

  document.getElementById("favViewBtn").addEventListener("click", function () {
    state.favOnly = !state.favOnly;
    this.setAttribute("aria-pressed", state.favOnly);
    resetForGroup(); render();
  });

  // 键盘：左右键切换（电脑上用）
  document.addEventListener("keydown", function (e) {
    if (!document.getElementById("settings").hidden) return;
    var step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    if (state.mode === "learn") go(step); else if (state.mode === "daily") goDay(step);
  });

  // ---------- 设置 ----------
  var modal = document.getElementById("settings");
  function openSettings() {
    document.querySelectorAll('input[name="accent"]').forEach(function (r) { r.checked = r.value === prefs.accent; });
    document.querySelectorAll('input[name="rate"]').forEach(function (r) { r.checked = Number(r.value) === Number(prefs.rate); });
    document.getElementById("autoSpeak").checked = !!prefs.autoSpeak;
    document.getElementById("ttsNote").textContent = tts ? "发音使用手机自带的语音引擎，不同手机音色会不一样。" : "当前浏览器不支持朗读，发音按钮已隐藏。";
    modal.hidden = false;
    document.getElementById("closeSettings").focus();
  }
  function closeSettings() {
    var a = document.querySelector('input[name="accent"]:checked'), r = document.querySelector('input[name="rate"]:checked');
    prefs.accent = a ? a.value : "en-US";
    prefs.rate = r ? Number(r.value) : 1;
    prefs.autoSpeak = document.getElementById("autoSpeak").checked;
    save("eng_prefs", prefs);
    modal.hidden = true;
    document.getElementById("settingsBtn").focus();
  }
  document.getElementById("settingsBtn").addEventListener("click", openSettings);
  document.getElementById("closeSettings").addEventListener("click", closeSettings);
  modal.addEventListener("click", function (e) { if (e.target === modal) closeSettings(); });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape" && !modal.hidden) closeSettings(); });
  document.getElementById("resetBtn").addEventListener("click", function () {
    if (confirm("确定清空所有「已掌握」记录吗？收藏不受影响。")) {
      mastered.clear(); save("eng_mastered", []); buildQueue(); render(); renderStats();
    }
  });

  // ---------- 启动 ----------
  document.getElementById("date").textContent = (now.getMonth() + 1) + "月" + now.getDate() + "日 星期" + WEEK[now.getDay()];
  document.getElementById("quote").textContent = QUOTES[dayOfYear % QUOTES.length];
  resetForGroup();
  render();
  renderStats();

  if ("serviceWorker" in navigator && location.protocol !== "file:") {
    navigator.serviceWorker.register("sw.js").then(function (reg) { reg.update(); }).catch(function () {});
    var hadController = !!navigator.serviceWorker.controller, reloaded = false;
    // 只有「旧版本被新版本替换」时才刷新，首次安装不刷新
    navigator.serviceWorker.addEventListener("controllerchange", function () { if (hadController && !reloaded) { reloaded = true; location.reload(); } });
  }
})();
