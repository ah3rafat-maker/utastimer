const STORE_KEYS = {
  exams: "finalExamTimer.exams",
  password: "finalExamTimer.password",
  lastHall: "finalExamTimer.lastHall",
  preview: "finalExamTimer.previewMode",
  semester: "finalExamTimer.semester",
  academicYear: "finalExamTimer.academicYear",
  fileName: "finalExamTimer.exams.fileName",
  examsMirror: "examTimerData"
};

const DEFAULT_PASSWORD = "1234";
let allExams = [];
let currentHall = "";
let activePeriodExams = [];
let currentPeriod = null;
let timerInterval = null;
let refreshInterval = null;
let endHandled = false;
let halfHandled = false;
let startHandled = false;
let adminInactivityTimer = null;
let adminWarningTimer = null;
let modalResolve = null;
let audioCtx = null;
let pendingExcelRows = null;
let pendingExcelFileName = "";

function pad(n){ return String(n).padStart(2,"0"); }
function clean(v){ return String(v ?? "").trim(); }
function toNumber(v){ const n = Number(String(v ?? "0").replace(/[٠-٩]/g, d => "٠١٢٣٤٥٦٧٨٩".indexOf(d))); return Number.isFinite(n) ? n : 0; }
function unique(arr){ return [...new Set(arr.filter(Boolean))]; }
function toArabicDigits(value){
  // Display western Arabic numerals (0-9), not Eastern Arabic/Indic numerals.
  return String(value)
    .replace(/[٠-٩]/g, d => "٠١٢٣٤٥٦٧٨٩".indexOf(d))
    .replace(/[۰-۹]/g, d => "۰۱۲۳۴۵۶۷۸۹".indexOf(d));
}

function getStoredExams(){
  // مصدر البيانات الأساسي للعرض والإعدادات واحد فقط.
  // نقرأ من المفتاح الأساسي، ثم من مفتاح احتياطي للتوافق مع النسخ السابقة.
  const keys = [STORE_KEYS.exams, STORE_KEYS.examsMirror];
  for (const key of keys) {
    try {
      const raw = localStorage.getItem(key);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          // توحيد المصدر فورًا حتى تقرأ الصفحة الرئيسية نفس البيانات المعدلة.
          if (key !== STORE_KEYS.exams) saveExams(parsed, false);
          return parsed;
        }
      }
    } catch {}
  }

  // أول تشغيل فقط: نستخدم البيانات التجريبية، ثم نحفظها في المفتاح الأساسي.
  const sample = Array.isArray(window.SAMPLE_EXAMS) ? window.SAMPLE_EXAMS : [];
  if (sample.length) saveExams(sample, false);
  return sample;
}
function notifyDataChanged(){
  try {
    window.dispatchEvent(new CustomEvent("exam-data-changed"));
    const bc = new BroadcastChannel("finalExamTimer");
    bc.postMessage({ type:"exam-data-changed", at:Date.now() });
    setTimeout(() => bc.close(), 200);
  } catch {}
}
function saveExams(rows, shouldNotify = true){
  const normalizedRows = Array.isArray(rows) ? rows : [];
  const payload = JSON.stringify(normalizedRows);
  const stamp = String(Date.now());
  // نكتب في مفتاحين لمنع مشكلة قراءة صفحة من مفتاح وصفحة أخرى من مفتاح مختلف.
  localStorage.setItem(STORE_KEYS.exams, payload);
  localStorage.setItem(STORE_KEYS.examsMirror, payload);
  localStorage.setItem("finalExamTimer.exams.updatedAt", stamp);
  localStorage.setItem("examTimerData.updatedAt", stamp);
  if (shouldNotify) notifyDataChanged();
}
function saveExamsWithMeta(rows, fileName = "", shouldNotify = true){
  if (fileName) localStorage.setItem(STORE_KEYS.fileName, fileName);
  saveExams(rows, shouldNotify);
}
function getLastUpdateText(){
  const stamp = localStorage.getItem("finalExamTimer.exams.updatedAt") || localStorage.getItem("examTimerData.updatedAt") || "";
  if (!stamp) return "غير محدد";
  const d = new Date(Number(stamp));
  if (Number.isNaN(d.getTime())) return "غير محدد";
  return toArabicDigits(new Intl.DateTimeFormat("ar-OM-u-nu-latn-ca-gregory", {year:"numeric", month:"2-digit", day:"2-digit", hour:"2-digit", minute:"2-digit"}).format(d));
}
function updateDataFileInfo(){
  const nameEl = document.getElementById("currentFileName");
  const updatedEl = document.getElementById("currentFileUpdated");
  if (nameEl) nameEl.textContent = localStorage.getItem(STORE_KEYS.fileName) || "غير محدد";
  if (updatedEl) updatedEl.textContent = getLastUpdateText();
}
function clearExamStorage(){
  [
    STORE_KEYS.exams,
    STORE_KEYS.examsMirror,
    "finalExamTimer.exams.updatedAt",
    "examTimerData.updatedAt",
    STORE_KEYS.fileName,
    "finalExamTimer.exams.v13",
    "finalExamTimer.exams.v12",
    "finalExamTimer.exams.v11",
    "finalExamTimer.exams.v10",
    "finalExamTimer.exams.v9",
    "finalExamTimer.exams.v8",
    "finalExamTimer.exams.v7",
    "finalExamTimer.exams.v6",
    "finalExamTimer.exams.v5",
    "finalExamTimer.exams.v4",
    "finalExamTimer.exams.v3",
    "finalExamTimer.exams.v2"
  ].forEach(k => localStorage.removeItem(k));
  notifyDataChanged();
}


function formatTopDate(date = new Date()){
  const greg = new Intl.DateTimeFormat("ar-OM-u-nu-latn-ca-gregory", { weekday:"long", year:"numeric", month:"long", day:"numeric" }).format(date);
  let hijri = "";
  try { hijri = new Intl.DateTimeFormat("ar-SA-u-nu-latn-ca-islamic-umalqura", { day:"numeric", month:"long", year:"numeric" }).format(date); }
  catch { hijri = new Intl.DateTimeFormat("ar-SA-u-nu-latn-ca-islamic", { day:"numeric", month:"long", year:"numeric" }).format(date); }
  return `${toArabicDigits(greg)}<br>${toArabicDigits(hijri)}`;
}
function updateTopDate(){
  document.querySelectorAll("#dateLine,.date-line").forEach(el => el.innerHTML = formatTopDate());
}
function updateCopyright(){
  document.querySelectorAll(".copyright").forEach(el => { el.textContent = `Dr. Ahmed Arafat © ${toArabicDigits(new Date().getFullYear())}`; });
}
function updateFullscreenButtons(){
  const isFull = !!document.fullscreenElement;
  document.body.classList.toggle("is-fullscreen", isFull);
  document.querySelectorAll(".fullscreen-btn").forEach(btn => {
    const label = isFull ? "تصغير الشاشة" : "ملء الشاشة";
    btn.title = label;
    btn.setAttribute("aria-label", label);
    btn.querySelector(".fs-open")?.classList.toggle("hidden", isFull);
    btn.querySelector(".fs-close")?.classList.toggle("hidden", !isFull);
  });
}
function unlockAudio(){
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") audioCtx.resume();
  } catch {}
}
function playBeep(durationSeconds = 1){
  try {
    unlockAudio();
    if (!audioCtx || audioCtx.state === "suspended") return;
    const now = audioCtx.currentTime;
    const pulse = 0.45;
    let t = now;
    while (t < now + durationSeconds) {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(900, t);
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.35, t + 0.03);
      gain.gain.setValueAtTime(0.35, Math.min(t + 0.26, now + durationSeconds));
      gain.gain.exponentialRampToValueAtTime(0.0001, Math.min(t + 0.34, now + durationSeconds));
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start(t);
      osc.stop(Math.min(t + 0.36, now + durationSeconds) + 0.03);
      t += pulse;
    }
  } catch {}
}
function bindAudioUnlock(){
  ["pointerdown", "keydown", "touchstart"].forEach(evt => {
    document.addEventListener(evt, unlockAudio, { once:false, passive:true });
  });
}
function bindFullscreenButton(){
  bindAudioUnlock();
  document.querySelectorAll("#fullScreenBtn,.fullscreen-btn").forEach(btn => {
    btn.addEventListener("click", async () => {
      unlockAudio();
      try {
        if (document.fullscreenElement) await document.exitFullscreen();
        else await document.documentElement.requestFullscreen();
        updateFullscreenButtons();
      } catch {}
    });
  });
  document.addEventListener("fullscreenchange", updateFullscreenButtons);
  updateFullscreenButtons();
}

function getExamSeason(date = new Date()){
  const y = date.getFullYear();
  const m = date.getMonth() + 1;
  const d = date.getDate();
  if ((m === 12 && d >= 16) || (m === 1 && d <= 15)) {
    const semYear = m === 1 ? y - 1 : y;
    return { active:true, semester:`خريف ${semYear}`, academicYear:`${semYear} - ${semYear + 1}` };
  }
  if ((m === 5 && d >= 16) || (m === 6 && d <= 15)) {
    return { active:true, semester:`ربيع ${y}`, academicYear:`${y - 1} - ${y}` };
  }
  if ((m === 8 && d >= 16) || (m === 9 && d <= 7)) {
    return { active:true, semester:`صيف ${y}`, academicYear:`${y - 1} - ${y}` };
  }
  return { active:false };
}

function getDisplayTerm(){
  const fallback = getExamSeason();
  const storedSemester = localStorage.getItem(STORE_KEYS.semester);
  const storedAcademicYear = localStorage.getItem(STORE_KEYS.academicYear);
  if (storedSemester && storedAcademicYear) {
    const yearInTerm = (storedAcademicYear.match(/\d{4}/g) || []).pop() || new Date().getFullYear();
    return { active:true, semester:`${storedSemester} ${yearInTerm}`, academicYear: storedAcademicYear };
  }
  return fallback;
}

function setTitles(){
  const season = getDisplayTerm();
  const title = document.getElementById("pageTitle");
  const year = document.getElementById("academicYearTitle");
  if (!title) return;
  if (season.active) {
    title.textContent = `الامتحانات النهائية للفصل الدراسي (${season.semester})`;
    year.textContent = `للعام الأكاديمي ${season.academicYear}`;
  } else {
    title.textContent = "لا توجد امتحانات نهائية في الوقت الحالي";
    year.textContent = "";
  }
}

function normalizeDate(value){
  const raw = clean(value);
  if (!raw) return "";
  const arabicDigits = raw.replace(/[٠-٩]/g, d => "٠١٢٣٤٥٦٧٨٩".indexOf(d));
  const parts = arabicDigits.split(/[\/\-\.]/).map(p => p.trim()).filter(Boolean);
  if (parts.length === 3) {
    let [a,b,c] = parts.map(Number);
    if (a > 31) return `${a}-${pad(b)}-${pad(c)}`;
    return `${c}-${pad(b)}-${pad(a)}`;
  }
  const dt = new Date(raw);
  if (!isNaN(dt)) return `${dt.getFullYear()}-${pad(dt.getMonth()+1)}-${pad(dt.getDate())}`;
  return raw;
}

function parseTimePart(part){
  let s = clean(part).replace(/[٠-٩]/g, d => "٠١٢٣٤٥٦٧٨٩".indexOf(d));
  s = s.replace(/ص|صباحا|صباحًا/gi, " AM").replace(/م|مساء|مساءً/gi, " PM");
  const pm = /PM/i.test(s);
  const am = /AM/i.test(s);
  s = s.replace(/AM|PM/ig, "").trim();
  const m = s.match(/(\d{1,2})(?::(\d{1,2}))?/);
  if (!m) return null;
  let h = Number(m[1]);
  let min = Number(m[2] || 0);
  const explicitMeridiem = pm || am;
  if (pm && h < 12) h += 12;
  if (am && h === 12) h = 0;
  return { h, min, explicitMeridiem };
}

function parsePeriod(period){
  const raw = clean(period).replace(/[–—−]/g, "-");
  const parts = raw.split("-").map(s => s.trim());
  if (parts.length < 2) return null;
  const start = parseTimePart(parts[0]);
  const end = parseTimePart(parts[1]);
  if (!start || !end) return null;

  // Exam schedules often write afternoon periods as 1 - 3 instead of 13:00 - 15:00.
  // If there is no AM/PM and the start hour is 1-7, treat it as afternoon.
  if (!start.explicitMeridiem && start.h >= 1 && start.h <= 7) start.h += 12;
  if (!end.explicitMeridiem && start.h >= 12 && end.h >= 1 && end.h <= 7) end.h += 12;

  let sMin = start.h * 60 + start.min;
  let eMin = end.h * 60 + end.min;
  if (eMin <= sMin) eMin += 12 * 60;
  if (eMin <= sMin) eMin += 12 * 60;
  return { startMinutes:sMin, endMinutes:eMin, startText:formatMinutes(sMin), endText:formatMinutes(eMin) };
}
function formatMinutes(total){
  total = ((total % 1440) + 1440) % 1440;
  return `${pad(Math.floor(total/60))}:${pad(total%60)}`;
}
function combineDateTime(dateStr, minutes){
  const [y,m,d] = normalizeDate(dateStr).split("-").map(Number);
  const dt = new Date(y, m - 1, d, 0, 0, 0, 0);
  dt.setMinutes(minutes);
  return dt;
}
function getSectionValue(row){
  return row && Object.prototype.hasOwnProperty.call(row, "الشعبة") ? row["الشعبة"] : row.section;
}
function getStudentsValue(row){
  return row && Object.prototype.hasOwnProperty.call(row, "عدد الطلاب") ? row["عدد الطلاب"] : row.students;
}
function setSectionValue(row, value){
  row["الشعبة"] = value;
}
function setStudentsValue(row, value){
  row["عدد الطلاب"] = value;
}

function normalizeExam(row){
  const period = parsePeriod(row["الفترة"] || row.period || "");
  return {
    courseCode: clean(row["رمز المقرر"] || row.courseCode),
    courseName: clean(row["اسم المقرر"] || row.courseName),
    section: clean(getSectionValue(row)),
    day: clean(row["اليوم"] || row.day),
    date: normalizeDate(row["التاريخ"] || row.examDate),
    periodRaw: clean(row["الفترة"] || row.period),
    students: toNumber(getStudentsValue(row)),
    hall: clean(row["القاعة"] || row.hall),
    period
  };
}
function refreshAllExams(){
  const rawRows = getStoredExams();
  allExams = rawRows.map(normalizeExam).filter(e => e.hall && e.date && e.period);
  return allExams;
}
function isSameDay(a,b){ return a.getFullYear()===b.getFullYear() && a.getMonth()===b.getMonth() && a.getDate()===b.getDate(); }
function isExamAvailable(exam, now = new Date()){
  if (!exam.period || !exam.date || !exam.hall) return false;
  const start = combineDateTime(exam.date, exam.period.startMinutes);
  const end = combineDateTime(exam.date, exam.period.endMinutes);
  const gate = new Date(start.getTime() - 15 * 60 * 1000);
  return now >= gate && now <= end;
}
function isPreviewMode(){ return localStorage.getItem(STORE_KEYS.preview) === "1"; }
function getAvailableHalls(){
  const now = new Date();
  if (isPreviewMode()) return unique(allExams.map(e => e.hall)).sort((a,b)=>a.localeCompare(b,"ar"));
  return unique(allExams.filter(e => isExamAvailable(e, now)).map(e => e.hall)).sort((a,b)=>a.localeCompare(b,"ar"));
}
function getExamsForHall(hall){
  const now = new Date();
  const halls = allExams.filter(e => e.hall === hall && e.period);
  if (isPreviewMode()) {
    const today = halls.find(e => isSameDay(combineDateTime(e.date, e.period.startMinutes), now));
    const selectedDate = today ? today.date : (halls[0] && halls[0].date);
    const selectedPeriod = today ? today.periodRaw : (halls[0] && halls[0].periodRaw);
    return halls.filter(e => e.date === selectedDate && e.periodRaw === selectedPeriod);
  }
  return halls.filter(e => isExamAvailable(e, now));
}
function chooseCurrentPeriod(exams){
  if (!exams.length) return null;
  const e = exams[0];
  const start = combineDateTime(e.date, e.period.startMinutes);
  const end = combineDateTime(e.date, e.period.endMinutes);
  return { start, end, startText:e.period.startText, endText:e.period.endText, durationMs:end-start };
}
function groupCourses(exams){
  const map = new Map();
  exams.forEach(e => {
    const key = `${e.courseCode}|${e.courseName}`;
    if (!map.has(key)) map.set(key, { courseCode:e.courseCode, courseName:e.courseName, sections:[] });
    map.get(key).sections.push({ section:e.section, students:e.students });
  });
  return [...map.values()].map(c => ({ ...c, sections:c.sections.sort((a,b)=>String(a.section).localeCompare(String(b.section),"ar",{numeric:true})) }));
}
function fitCourseColumns(count){
  const cards = document.getElementById("courseCards");
  if (!cards) return;
  if (count <= 1) cards.style.gridTemplateColumns = "1fr";
  else if (count === 2) cards.style.gridTemplateColumns = "repeat(2, minmax(0, 1fr))";
  else if (count === 3) cards.style.gridTemplateColumns = "repeat(3, minmax(0, 1fr))";
  else cards.style.gridTemplateColumns = "repeat(4, minmax(0, 1fr))";
  cards.style.gridAutoFlow = "row";
}
function renderHall(hall){
  refreshAllExams();
  currentHall = hall;
  localStorage.setItem(STORE_KEYS.lastHall, hall);
  activePeriodExams = getExamsForHall(hall);
  currentPeriod = chooseCurrentPeriod(activePeriodExams);
  const setup = document.getElementById("setupPanel");
  const view = document.getElementById("examView");
  const empty = document.getElementById("emptyState");
  if (!activePeriodExams.length || !currentPeriod) {
    view.classList.add("hidden"); empty.classList.remove("hidden"); return;
  }
  setup.classList.add("hidden"); empty.classList.add("hidden"); view.classList.remove("hidden");
  document.body.classList.remove("display-running", "single-course", "multi-course", "many-courses");
  document.getElementById("hallName").textContent = hall;
  document.getElementById("totalStudents").textContent = toArabicDigits(activePeriodExams.reduce((s,e)=>s+e.students,0));
  document.getElementById("periodText").textContent = `من ${currentPeriod.startText} إلى ${currentPeriod.endText}`;
  const groups = groupCourses(activePeriodExams);
  document.body.classList.toggle("single-course", groups.length === 1);
  document.body.classList.toggle("multi-course", groups.length > 1);
  document.body.classList.toggle("many-courses", groups.length >= 4);
  fitCourseColumns(groups.length);
  document.getElementById("courseCards").innerHTML = groups.map(course => `
    <article class="course-card ${groups.length === 1 ? 'single' : ''}">
      <div class="course-info">
        <div class="info-row">
          <span class="info-label">اسم المقرر:</span>
          <span class="info-value course-name">${escapeHtml(course.courseName)}</span>
        </div>
        <div class="info-row">
          <span class="info-label">كود المقرر:</span>
          <span class="info-value course-code">${escapeHtml(course.courseCode)}</span>
        </div>
        <div class="sections-list">
          ${course.sections.map(s => `
            <div class="section-line">
              <div class="info-row">
                <span class="info-label">الشعبة:</span>
                <span class="info-value">${toArabicDigits(escapeHtml(s.section))}</span>
              </div>
              <div class="info-row">
                <span class="info-label">عدد الطلبة:</span>
                <span class="info-value">${toArabicDigits(s.students)}</span>
              </div>
            </div>`).join("")}
        </div>
      </div>
    </article>`).join("");
  // تهيئة أعلام التنبيهات حسب لحظة فتح القاعة؛
  // حتى لا يعمل الصوت عند التنقل أو اختيار قاعة اختبار بدأ سابقًا.
  const nowForFlags = new Date();
  startHandled = nowForFlags >= currentPeriod.start;
  halfHandled = nowForFlags >= new Date(currentPeriod.start.getTime() + currentPeriod.durationMs / 2);
  endHandled = nowForFlags >= currentPeriod.end;
  document.getElementById("homeBtn")?.classList.remove("hidden");
  document.getElementById("timer")?.classList.remove("timer-ended", "timer-waiting");
  startTimer();
}
function escapeHtml(s){ return String(s).replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;"}[c])); }

function showConfirmModal(message, title="تأكيد", options={}){
  const modal = document.getElementById("confirmModal");
  const titleEl = document.getElementById("confirmModalTitle");
  const msgEl = document.getElementById("confirmModalMessage");
  const yesBtn = document.getElementById("confirmYesBtn");
  const noBtn = document.getElementById("confirmNoBtn");
  if (!modal || !titleEl || !msgEl || !yesBtn || !noBtn) {
    return Promise.resolve(window.confirm(message));
  }
  if (modalResolve) modalResolve(false);
  modalResolve = null;
  titleEl.textContent = title;
  msgEl.textContent = message;
  yesBtn.textContent = options.yesText || "نعم";
  noBtn.textContent = options.noText || "لا";
  modal.classList.remove("hidden");
  return new Promise(resolve => {
    modalResolve = resolve;
    let autoTimer = null;
    const cleanup = (answer) => {
      if (autoTimer) clearTimeout(autoTimer);
      yesBtn.removeEventListener("click", onYes);
      noBtn.removeEventListener("click", onNo);
      modal.classList.add("hidden");
      modalResolve = null;
      resolve(answer);
    };
    const onYes = () => cleanup(true);
    const onNo = () => cleanup(false);
    yesBtn.addEventListener("click", onYes);
    noBtn.addEventListener("click", onNo);
    if (options.autoYesAfterMs) autoTimer = setTimeout(() => cleanup(true), options.autoYesAfterMs);
  });
}

function isExamViewVisible(){
  const view = document.getElementById("examView");
  return !!currentHall || (view && !view.classList.contains("hidden"));
}

async function handleHomeRequest(event){
  if (event) {
    event.preventDefault();
    event.stopPropagation();
  }
  if (isExamViewVisible()) {
    const ok = await showConfirmModal("هل تريد الذهاب إلى الصفحة الرئيسية؟", "تأكيد الخروج");
    if (!ok) return;
  }
  if (document.fullscreenElement) {
    try { await document.exitFullscreen(); } catch {}
  }
  location.hash = "display";
  localStorage.removeItem(STORE_KEYS.lastHall);
  goHome(false);
}

function adminLogout(){
  sessionStorage.removeItem("finalExamTimer.adminLoggedIn");
  const login = document.getElementById("loginPanel");
  const settings = document.getElementById("settingsPanel");
  if (login) login.classList.remove("hidden");
  if (settings) settings.classList.add("hidden");
  const pw = document.getElementById("passwordInput");
  if (pw) pw.value = "";
  clearAdminInactivityTimers();
}
function clearAdminInactivityTimers(){
  if (adminInactivityTimer) clearTimeout(adminInactivityTimer);
  if (adminWarningTimer) clearTimeout(adminWarningTimer);
  adminInactivityTimer = null;
  adminWarningTimer = null;
}
function resetAdminInactivity(){
  if (location.hash !== "#admin" || sessionStorage.getItem("finalExamTimer.adminLoggedIn") !== "true") return;
  clearAdminInactivityTimers();
  adminInactivityTimer = setTimeout(showAdminInactivityWarning, 120000);
}
async function showAdminInactivityWarning(){
  if (location.hash !== "#admin" || sessionStorage.getItem("finalExamTimer.adminLoggedIn") !== "true") return;
  const logout = await showConfirmModal("سيتم تسجيل الخروج بسبب الخمول. هل تريد تسجيل الخروج؟", "تنبيه الخصوصية", { yesText:"نعم", noText:"لا", autoYesAfterMs:20000 });
  if (logout) adminLogout();
  else resetAdminInactivity();
}
function attachAdminActivityWatchers(){
  ["mousemove","mousedown","keydown","touchstart","click","input","change"].forEach(ev => {
    document.addEventListener(ev, (e) => {
      const adminPage = document.getElementById("adminPage");
      if (adminPage && !adminPage.classList.contains("hidden")) resetAdminInactivity();
    }, { passive:true });
  });
}

function startTimer(){
  clearInterval(timerInterval);
  updateTimer();
  timerInterval = setInterval(updateTimer, 1000);
}
function updateTimer(){
  if (!currentPeriod) return;
  const now = new Date();
  const timerEl = document.getElementById("timer");

  if (endHandled) {
    timerEl.textContent = "انتهى الوقت";
    timerEl.classList.add("timer-ended");
    document.body.classList.remove("display-running", "single-course", "multi-course", "many-courses");
    document.getElementById("homeBtn")?.classList.remove("hidden");
    return;
  }

  if (now < currentPeriod.start) {
    document.body.classList.remove("display-running", "single-course", "multi-course", "many-courses");
    timerEl.textContent = "لم يبدأ الوقت";
    timerEl.classList.add("timer-waiting");
    return;
  }

  if (!startHandled) {
    startHandled = true;
    playBeep(3);
  }
  document.body.classList.add("display-running");
  timerEl.classList.remove("timer-waiting");
  const rawRemaining = currentPeriod.end - now;
  const remaining = Math.max(0, rawRemaining);
  const elapsed = now - currentPeriod.start;

  if (!halfHandled && elapsed >= currentPeriod.durationMs / 2 && rawRemaining > 0) {
    halfHandled = true;
    playBeep(3);
  }

  if (!endHandled && rawRemaining <= 0) {
    endHandled = true;
    timerEl.textContent = "انتهى الوقت";
    timerEl.classList.add("timer-ended");
    playBeep(10);
    document.body.classList.remove("display-running", "single-course", "multi-course", "many-courses");
    document.getElementById("homeBtn")?.classList.remove("hidden");
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    }
    return;
  }

  const h = Math.floor(remaining / 3600000);
  const m = Math.floor((remaining % 3600000) / 60000);
  const s = Math.floor((remaining % 60000) / 1000);
  timerEl.classList.remove("timer-ended");
  timerEl.textContent = toArabicDigits(`${pad(h)}:${pad(m)}:${pad(s)}`);
}
function goHome(restoreLastHall = true){
  clearInterval(timerInterval);
  currentHall = "";
  activePeriodExams = [];
  currentPeriod = null;
  endHandled = false;
  halfHandled = false;
  startHandled = false;
  document.body.classList.remove("display-running", "single-course", "multi-course", "many-courses");
  document.getElementById("examView")?.classList.add("hidden");
  document.getElementById("emptyState")?.classList.add("hidden");
  document.getElementById("setupPanel")?.classList.remove("hidden");
  document.getElementById("timer")?.classList.remove("timer-ended", "timer-waiting");
  const select = document.getElementById("hallSelect");
  if (select) select.value = "";
  populateHalls(restoreLastHall);
}
function populateHalls(restoreLastHall = true){
  refreshAllExams();
  const select = document.getElementById("hallSelect"); if (!select) return;
  const halls = getAvailableHalls();
  const previous = restoreLastHall ? (select.value || localStorage.getItem(STORE_KEYS.lastHall) || "") : "";
  select.innerHTML = `<option value="">اختر القاعة</option>` + halls.map(h => `<option value="${escapeHtml(h)}">${escapeHtml(h)}</option>`).join("");
  if (previous && halls.includes(previous)) { select.value = previous; renderHall(previous); }
  const note = document.getElementById("setupNote");
  if (note) note.textContent = halls.length ? "تظهر القاعات التي لديها اختبار حالي أو يبدأ خلال 15 دقيقة فقط." : "لا توجد قاعات متاحة الآن وفق وقت الجهاز الحالي.";
}
function initDisplay(){
  updateTopDate();
  updateCopyright();
  bindFullscreenButton();
  setTitles();
  refreshAllExams();
  const season = getDisplayTerm();
  if (!season.active) {
    document.getElementById("setupPanel").classList.add("hidden");
    document.getElementById("emptyState").classList.remove("hidden");
    return;
  }
  populateHalls();
  document.getElementById("hallSelect")?.addEventListener("change", e => { unlockAudio(); if(e.target.value) renderHall(e.target.value); });
  document.getElementById("homeBtn")?.addEventListener("click", handleHomeRequest);
  document.getElementById("topHomeBtn")?.addEventListener("click", handleHomeRequest);
  document.addEventListener("click", (event) => {
    const btn = event.target.closest?.("#homeBtn,#topHomeBtn");
    if (btn) handleHomeRequest(event);
  });
  const reloadDisplayData = () => { if (currentHall) renderHall(currentHall); else populateHalls(); };
  window.addEventListener("storage", e => {
    if (!e.key || e.key.startsWith("finalExamTimer.exams")) reloadDisplayData();
  });
  window.addEventListener("exam-data-changed", reloadDisplayData);
  try {
    const bc = new BroadcastChannel("finalExamTimer");
    bc.onmessage = (event) => { if (event.data?.type === "exam-data-changed") reloadDisplayData(); };
  } catch {}
  let lastSeenUpdate = localStorage.getItem("finalExamTimer.exams.updatedAt") || "";
  window.addEventListener("focus", () => { reloadDisplayData(); });
  refreshInterval = setInterval(() => {
    const currentUpdate = localStorage.getItem("finalExamTimer.exams.updatedAt") || "";
    if (currentUpdate !== lastSeenUpdate) { lastSeenUpdate = currentUpdate; reloadDisplayData(); return; }
    if (!currentHall) populateHalls();
  }, 5000);
}

function initTermSettings(){
  const semesterSelect = document.getElementById("semesterSelect");
  const academicYearInput = document.getElementById("academicYearInput");
  const saveBtn = document.getElementById("saveTermBtn");
  if (!semesterSelect || !academicYearInput || !saveBtn) return;
  const fallback = getExamSeason();
  const fallbackSemester = fallback.active ? String(fallback.semester).split(" ")[0] : "ربيع";
  const fallbackAcademicYear = fallback.active ? fallback.academicYear : `${new Date().getFullYear()} - ${new Date().getFullYear()+1}`;
  semesterSelect.value = localStorage.getItem(STORE_KEYS.semester) || fallbackSemester;
  academicYearInput.value = localStorage.getItem(STORE_KEYS.academicYear) || fallbackAcademicYear;
  saveBtn.addEventListener("click", () => {
    const sem = semesterSelect.value;
    const ay = academicYearInput.value.trim();
    if (!sem || !ay) return alert("يرجى اختيار الفصل الدراسي وإدخال العام الأكاديمي.");
    localStorage.setItem(STORE_KEYS.semester, sem);
    localStorage.setItem(STORE_KEYS.academicYear, ay);
    setTitles();
    alert("تم حفظ إعدادات الفصل الدراسي.");
  });
}

function initAdmin(){
  updateTopDate();
  updateCopyright();
  bindFullscreenButton();
  setTitles();
  initTermSettings();
  const login = document.getElementById("loginPanel"); const settings = document.getElementById("settingsPanel");
  document.getElementById("loginBtn")?.addEventListener("click", () => {
    const pw = localStorage.getItem(STORE_KEYS.password) || DEFAULT_PASSWORD;
    if (document.getElementById("passwordInput").value === pw) { sessionStorage.setItem("finalExamTimer.adminLoggedIn","true"); login.classList.add("hidden"); settings.classList.remove("hidden"); updateStats(); resetAdminInactivity(); }
    else alert("رمز الدخول غير صحيح");
  });
  updateDataFileInfo();
  document.getElementById("excelFile")?.addEventListener("change", handleExcelUpload);
  document.getElementById("replaceDataBtn")?.addEventListener("click", replaceCurrentData);
  document.getElementById("savePasswordBtn")?.addEventListener("click", () => {
    const current = document.getElementById("currentPassword")?.value || "";
    const np = document.getElementById("newPassword")?.value.trim() || "";
    const cp = document.getElementById("confirmPassword")?.value.trim() || "";
    const oldPw = localStorage.getItem(STORE_KEYS.password) || DEFAULT_PASSWORD;
    if (current !== oldPw) return alert("الرقم السري الحالي غير صحيح.");
    if (np.length < 3) return alert("يرجى إدخال رقم سري جديد من 3 خانات على الأقل.");
    if (np !== cp) return alert("الرقم السري الجديد وتأكيده غير متطابقين.");
    localStorage.setItem(STORE_KEYS.password, np);
    ["currentPassword","newPassword","confirmPassword"].forEach(id => { const el = document.getElementById(id); if (el) el.value = ""; });
    alert("تم حفظ الرقم السري الجديد.");
  });
  initEditTools();
}

function getEditableRows(){
  const rawRows = getStoredExams();
  return rawRows.map((row, index) => ({ index, row, exam: normalizeExam(row) })).filter(x => x.exam.hall && x.exam.date);
}
function initEditTools(){
  const dateSel = document.getElementById("editDateSelect");
  const hallSel = document.getElementById("editHallSelect");
  const saveBtn = document.getElementById("saveEditsBtn");
  if (!dateSel || !hallSel || !saveBtn) return;
  populateEditDates();
  dateSel.addEventListener("change", () => { populateEditHalls(); renderEditRows(); });
  hallSel.addEventListener("change", renderEditRows);
  saveBtn.addEventListener("click", saveEditedRows);
}
function populateEditDates(){
  const dateSel = document.getElementById("editDateSelect");
  if (!dateSel) return;
  const dates = unique(getEditableRows().map(x => x.exam.date)).sort();
  dateSel.innerHTML = `<option value="">اختر التاريخ</option>` + dates.map(d => `<option value="${escapeHtml(d)}">${escapeHtml(d)}</option>`).join("");
  populateEditHalls();
}
function populateEditHalls(){
  const dateSel = document.getElementById("editDateSelect");
  const hallSel = document.getElementById("editHallSelect");
  if (!dateSel || !hallSel) return;
  const date = dateSel.value;
  const halls = unique(getEditableRows().filter(x => !date || x.exam.date === date).map(x => x.exam.hall)).sort((a,b)=>a.localeCompare(b,"ar"));
  hallSel.innerHTML = `<option value="">اختر القاعة</option>` + halls.map(h => `<option value="${escapeHtml(h)}">${escapeHtml(h)}</option>`).join("");
}
function renderEditRows(){
  const container = document.getElementById("editRows");
  const status = document.getElementById("editStatus");
  const date = document.getElementById("editDateSelect")?.value || "";
  const hall = document.getElementById("editHallSelect")?.value || "";
  if (!container) return;
  if (!date || !hall) {
    container.innerHTML = "";
    if (status) status.textContent = "اختر التاريخ والقاعة لعرض السجلات القابلة للتعديل.";
    return;
  }
  const rows = getEditableRows().filter(x => x.exam.date === date && x.exam.hall === hall);
  if (!rows.length) {
    container.innerHTML = "";
    if (status) status.textContent = "لا توجد سجلات مطابقة.";
    return;
  }
  container.innerHTML = rows.map((x, n) => `
    <article class="edit-row-card" data-index="${x.index}">
      <div class="edit-row-title">سجل ${n + 1}</div>
      <div class="edit-row-grid">
        <label>رمز المقرر<input data-field="رمز المقرر" value="${escapeHtml(x.exam.courseCode)}"></label>
        <label>اسم المقرر<input data-field="اسم المقرر" value="${escapeHtml(x.exam.courseName)}"></label>
        <label>الشعبة<input data-field="__section" value="${escapeHtml(x.exam.section)}"></label>
        <label>عدد الطلاب<input data-field="__students" value="${escapeHtml(x.exam.students)}"></label>
        <label>القاعة<input data-field="القاعة" value="${escapeHtml(x.exam.hall)}"></label>
        <label>التاريخ<input data-field="التاريخ" value="${escapeHtml(x.exam.date)}"></label>
        <label>الفترة<input data-field="الفترة" value="${escapeHtml(x.exam.periodRaw)}"></label>
        <label>اليوم<input data-field="اليوم" value="${escapeHtml(x.exam.day)}"></label>
      </div>
    </article>`).join("");
  if (status) status.textContent = `تم عرض ${toArabicDigits(rows.length)} سجل للتعديل.`;
}
function saveEditedRows(){
  const cards = [...document.querySelectorAll(".edit-row-card")];
  if (!cards.length) return alert("لا توجد سجلات معروضة للحفظ.");
  const rows = getStoredExams();
  cards.forEach(card => {
    const idx = Number(card.dataset.index);
    if (!rows[idx]) return;
    card.querySelectorAll("input[data-field]").forEach(input => {
      const field = input.dataset.field;
      const value = clean(input.value);
      if (field === "__section") setSectionValue(rows[idx], value);
      else if (field === "__students") setStudentsValue(rows[idx], value);
      else rows[idx][field] = value;
    });
  });
  const previousDate = document.getElementById("editDateSelect")?.value || "";
  const previousHall = document.getElementById("editHallSelect")?.value || "";
  saveExams(rows);
  refreshAllExams();
  populateHalls();
  updateStats("تم حفظ التعديلات في مصدر البيانات الأساسي. ستظهر في صفحة العرض مباشرة إذا كانت ضمن تاريخ ووقت الاختبار.");
  populateEditDates();
  const dateSel = document.getElementById("editDateSelect");
  const hallSel = document.getElementById("editHallSelect");
  if (dateSel && [...dateSel.options].some(o => o.value === previousDate)) dateSel.value = previousDate;
  populateEditHalls();
  if (hallSel && [...hallSel.options].some(o => o.value === previousHall)) hallSel.value = previousHall;
  renderEditRows();
  const savedCount = getStoredExams().length;
  document.getElementById("editStatus").textContent = `تم حفظ التعديلات بنجاح في مصدر البيانات المشترك. عدد السجلات المحفوظة: ${toArabicDigits(savedCount)}. افتح صفحة العرض أو حدّثها لرؤية القاعات المطابقة للتاريخ والوقت.`;
}

function parseExcelEventFile(file, callback){
  const reader = new FileReader();
  reader.onload = event => {
    const data = new Uint8Array(event.target.result);
    const wb = XLSX.read(data, { type:"array", cellDates:false });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const raw = XLSX.utils.sheet_to_json(sheet, { header:1, defval:"", raw:false });
    const headerRowIndex = raw.findIndex(row => row.includes("رمز المقرر") && row.includes("القاعة"));
    if (headerRowIndex < 0) return alert("لم يتم العثور على صف العناوين المطلوب.");
    const headers = raw[headerRowIndex].map(clean);
    const rows = raw.slice(headerRowIndex + 1).filter(r => r.some(cell => clean(cell))).map(r => {
      const obj = {}; headers.forEach((h,i)=> obj[h] = clean(r[i])); return obj;
    });
    callback(rows);
  };
  reader.readAsArrayBuffer(file);
}
function handleExcelUpload(e){
  const file = e.target.files[0]; if(!file) return;
  parseExcelEventFile(file, rows => {
    pendingExcelRows = rows;
    pendingExcelFileName = file.name || "ملف Excel";
    const exams = rows.map(normalizeExam).filter(x => x.hall && x.date && x.period);
    const summary = document.getElementById("pendingFileSummary");
    if (summary) {
      summary.textContent = `تم اختيار الملف: ${pendingExcelFileName} — يحتوي على ${toArabicDigits(rows.length)} صف، ${toArabicDigits(unique(exams.map(e=>e.hall)).length)} قاعة، ${toArabicDigits(uniqueExamGroups(exams).length)} مقرر. اضغط «استبدال البيانات الحالية» لاعتماده.`;
    }
  });
}
async function replaceCurrentData(){
  if (!pendingExcelRows) return alert("يرجى اختيار ملف Excel جديد أولًا.");
  const ok = await showConfirmModal("سيتم استبدال جميع البيانات الحالية بالملف الجديد. هل تريد المتابعة؟", "استبدال بيانات الامتحانات");
  if (!ok) return;
  saveExamsWithMeta(pendingExcelRows, pendingExcelFileName);
  pendingExcelRows = null;
  pendingExcelFileName = "";
  const input = document.getElementById("excelFile");
  if (input) input.value = "";
  const summary = document.getElementById("pendingFileSummary");
  if (summary) summary.textContent = "تم استبدال البيانات الحالية بنجاح.";
  refreshAllExams();
  populateHalls();
  populateEditDates();
  updateDataFileInfo();
  updateStats("تم استبدال بيانات الامتحانات بنجاح.");
}
function setStat(id, value){
  const el = document.getElementById(id);
  if (el) el.textContent = toArabicDigits(value);
}
function getExamTiming(exam){
  if (!exam || !exam.period || !exam.date) return null;
  const start = combineDateTime(exam.date, exam.period.startMinutes);
  const end = combineDateTime(exam.date, exam.period.endMinutes);
  return { start, end };
}
function sumStudents(exams){
  return exams.reduce((sum, e) => sum + (Number(e.students) || 0), 0);
}
function examGroupKey(e){
  return [e.date, e.periodRaw || `${e.period?.startMinutes}-${e.period?.endMinutes}`, e.hall, e.courseCode, e.courseName].join("|");
}
function uniqueExamGroups(exams){
  const map = new Map();
  exams.forEach(e => {
    const key = examGroupKey(e);
    if (!map.has(key)) map.set(key, e);
  });
  return [...map.values()];
}
function sectionDigitCount(section){
  return toArabicDigits(section).replace(/\D/g, "").length;
}
function renderTodayHallStudents(todayExams){
  const box = document.getElementById("todayHallStudents");
  if (!box) return;
  const map = new Map();
  todayExams.forEach(e => map.set(e.hall, (map.get(e.hall) || 0) + (Number(e.students) || 0)));
  const entries = [...map.entries()].sort((a,b)=>b[1]-a[1] || a[0].localeCompare(b[0], "ar", {numeric:true}));
  if (!entries.length) {
    box.innerHTML = `<div class="empty-mini-stat">لا توجد اختبارات اليوم</div>`;
    return;
  }
  box.innerHTML = entries.map(([hall, students]) => `
    <div class="hall-student-row">
      <span>${escapeHtml(hall)}</span>
      <strong>${toArabicDigits(students)}</strong>
    </div>`).join("");
}

function courseIdentity(e){
  const code = clean(e.courseCode || e["رمز المقرر"] || "");
  if (code) return code.toUpperCase();
  return clean(e.courseName || e["اسم المقرر"] || "").toUpperCase();
}
function uniqueCourseCount(exams){
  return new Set(exams.map(courseIdentity).filter(Boolean)).size;
}

function maxExamEndDate(exams){
  let max = null;
  exams.forEach(e => {
    const t = getExamTiming(e);
    if (t && (!max || t.end > max)) max = t.end;
  });
  return max;
}
function daysRemainingToLastExam(exams, now = new Date()){
  const last = maxExamEndDate(exams);
  if (!last) return "0 يوم";
  const diff = last.getTime() - now.getTime();
  if (diff <= 0) return "0 يوم";
  return `${toArabicDigits(Math.ceil(diff / 86400000))} يوم`;
}
function updateStats(message=""){
  updateDataFileInfo();
  const rows = getStoredExams();
  const exams = rows.map(normalizeExam).filter(e => e.hall && e.date && e.period);
  const now = new Date();

  const todayExams = exams.filter(e => isSameDay(combineDateTime(e.date, e.period.startMinutes), now));

  const completedRows = exams.filter(e => { const t = getExamTiming(e); return t && now > t.end; });
  const runningRows = exams.filter(e => { const t = getExamTiming(e); return t && now >= t.start && now <= t.end; });
  const remainingRows = exams.filter(e => { const t = getExamTiming(e); return t && now < t.start; });

  const todayCompletedRows = todayExams.filter(e => now > getExamTiming(e).end);
  const todayRemainingRows = todayExams.filter(e => now < getExamTiming(e).start);
  const todayRunningRows = todayExams.filter(e => { const t = getExamTiming(e); return now >= t.start && now <= t.end; });

  const courseCount = uniqueCourseCount(exams);
  const completedCourseCount = uniqueCourseCount(completedRows);
  const runningCourseCount = uniqueCourseCount(runningRows);
  const remainingCourseCount = uniqueCourseCount(remainingRows);
  const todayCourseCount = uniqueCourseCount(todayExams);
  const todayCompletedCourseCount = uniqueCourseCount(todayCompletedRows);
  const todayRunningCourseCount = uniqueCourseCount(todayRunningRows);
  const todayRemainingCourseCount = uniqueCourseCount(todayRemainingRows);

  const sections = exams.map(e => clean(e.section)).filter(Boolean);
  const cimsSections = sections.filter(sec => sectionDigitCount(sec) === 1);
  const sisSections = sections.filter(sec => sectionDigitCount(sec) > 1);
  const todaySections = todayExams.map(e => clean(e.section)).filter(Boolean);

  setStat("statCourses", courseCount);
  setStat("statCourseTotal", courseCount);
  setStat("statSections", sections.length);
  setStat("statCimsSections", cimsSections.length);
  setStat("statSisSections", sisSections.length);
  setStat("statHalls", unique(exams.map(e=>e.hall)).length);

  setStat("statCompleted", completedCourseCount);
  setStat("statRunning", runningCourseCount);
  setStat("statRemaining", remainingCourseCount);

  setStat("statTodayExams", todayCourseCount);
  setStat("statTodaySections", todaySections.length);
  setStat("statTodayHalls", unique(todayExams.map(e=>e.hall)).length);
  setStat("statTodayStudents", sumStudents(todayExams));
  setStat("statTodayCompleted", todayCompletedCourseCount);
  setStat("statTodayRunning", todayRunningCourseCount);
  setStat("statTodayRemaining", todayRemainingCourseCount);
  renderTodayHallStudents(todayExams);

  const lastUpdate = document.getElementById("statLastUpdate");
  if (lastUpdate) lastUpdate.textContent = getLastUpdateText();
  const days = document.getElementById("statDaysRemaining");
  if (days) days.textContent = daysRemainingToLastExam(exams, now);

  const status = document.getElementById("adminStatus");
  if (status) status.textContent = message;
}

function showAppPage(){
  const isAdmin = location.hash === "#admin";
  document.body.classList.toggle("admin-mode", isAdmin);
  document.body.classList.toggle("display-mode", !isAdmin);
  const display = document.getElementById("displayPage");
  const admin = document.getElementById("adminPage");
  if (display) display.classList.toggle("hidden", isAdmin);
  if (admin) admin.classList.toggle("hidden", !isAdmin);
  updateTopDate();
  updateCopyright();
  if (!isAdmin) {
    adminLogout();
    refreshAllExams();
    if (currentHall) renderHall(currentHall);
    else populateHalls();
  } else {
    const login = document.getElementById("loginPanel");
    const settings = document.getElementById("settingsPanel");
    if (sessionStorage.getItem("finalExamTimer.adminLoggedIn") === "true") {
      if (login) login.classList.add("hidden");
      if (settings) settings.classList.remove("hidden");
      resetAdminInactivity();
    } else {
      if (login) login.classList.remove("hidden");
      if (settings) settings.classList.add("hidden");
    }
    populateEditDates();
    updateStats();
  }
}

document.addEventListener("DOMContentLoaded", () => {
  attachAdminActivityWatchers();
  initDisplay();
  initAdmin();
  showAppPage();
  window.addEventListener("hashchange", showAppPage);
});
