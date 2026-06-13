const STORE_KEYS = {
  exams: "finalExamTimer.exams",
  password: "finalExamTimer.password",
  lastHall: "finalExamTimer.lastHall",
  preview: "finalExamTimer.previewMode",
  semester: "finalExamTimer.semester",
  academicYear: "finalExamTimer.academicYear",
  fileName: "finalExamTimer.exams.fileName",
  examsMirror: "examTimerData",
  supportCode: "finalExamTimer.supportCode",
  attendanceTime: "finalExamTimer.attendanceTime",
  supportChairName: "finalExamTimer.supportChairName",
  supportChairTitle: "finalExamTimer.supportChairTitle",
  beepStartDuration: "finalExamTimer.beepStartDuration",
  beepHalfDuration: "finalExamTimer.beepHalfDuration",
  beepFifteenDuration: "finalExamTimer.beepFifteenDuration",
  beepEndDuration: "finalExamTimer.beepEndDuration",
  beepStartEnabled: "finalExamTimer.beepStartEnabled",
  beepHalfEnabled: "finalExamTimer.beepHalfEnabled",
  beepFifteenEnabled: "finalExamTimer.beepFifteenEnabled",
  beepEndEnabled: "finalExamTimer.beepEndEnabled",
  timerPosition: "finalExamTimer.timerPosition",
  operationLog: "finalExamTimer.operationLog"
};

const DEFAULT_PASSWORD = "1234";
const FIRESTORE_DOCS = {
  settings: ["settings", "config"],
  exams: ["examData", "main"]
};

const PRIMARY_ADMIN_EMAIL = "ah.3rafat@gmail.com";

let cloudDb = null;
let cloudReady = false;
let cloudListenersAttached = false;
let cloudInitialLoadDone = false;
let suppressCloudSave = false;
let cloudStatusText = "";
let cloudSettingsCache = {};
let cloudRowsCache = null;
let cloudFirstSyncResolved = false;
let pendingCloudUploadAfterInit = false;
let cloudAuth = null;
let cloudAuthReady = false;
let adminUserEmail = "";
let adminAuthorized = false;
let adminsUnsubscribe = null;
let wakeLock = null;
let wakeLockRequested = false;
let supportRequestsUnsubscribe = null;
let hallRequestsUnsubscribe = null;
let supportKnownRequestIds = new Set();
let currentSupportDraft = null;
let attendanceModalShown = false;
let attendanceSubmitted = false;
let attendanceSubmitInProgress = false;
let supportAbsenceRequestsCache = [];
let supportAttendanceReportsCache = [];
let attendanceReportsUnsubscribe = null;
let supportRequestsCache = [];
let earlyFinishDraft = null;
let supportWakeInterval = null;
let currentHallLockId = "";
let currentHallLockKey = "";
let currentSessionId = sessionStorage.getItem("finalExamTimer.sessionId") || `${Date.now()}_${Math.random().toString(36).slice(2)}`;
sessionStorage.setItem("finalExamTimer.sessionId", currentSessionId);
let hallLockHeartbeatTimer = null;
let hallLocksUnsubscribe = null;
let currentHallLockUnsubscribe = null;
let hallLockPollTimer = null;
let suppressHallLockForceClose = false;
let currentHallLockOpenedAt = 0;
let lastForceReleaseHandledSerial = "";

function hasFirebaseConfig(){
  const cfg = window.FIREBASE_CONFIG;
  return !!(cfg && cfg.apiKey && cfg.projectId && cfg.appId);
}
function firestoreDoc(pathParts){
  if (!cloudDb || !window.firebase || !window.firebase.firestore) return null;
  return cloudDb.collection(pathParts[0]).doc(pathParts[1]);
}

function hasFirebaseAuth(){
  return !!(window.firebase && window.firebase.auth);
}
function normalizeEmail(email){
  return String(email || "").trim().toLowerCase();
}
function adminDoc(email){
  if (!cloudDb) return null;
  return cloudDb.collection("admins").doc(normalizeEmail(email));
}
function supportRequestsCollection(){
  if (!cloudDb) return null;
  return cloudDb.collection("supportRequests");
}

function operationLogsCollection(){
  if (!cloudDb) return null;
  return cloudDb.collection("operationLogs");
}

async function deleteCollectionDocs(collectionRef, chunkSize = 450){
  if (!collectionRef || !window.firebase || !window.firebase.firestore) return 0;
  let deleted = 0;
  while (true) {
    const snap = await collectionRef.limit(chunkSize).get();
    if (snap.empty) break;
    const batch = cloudDb.batch();
    snap.docs.forEach(doc => batch.delete(doc.ref));
    await batch.commit();
    deleted += snap.size;
    if (snap.size < chunkSize) break;
  }
  return deleted;
}

function clearLocalExamRelatedStorage(){
  const prefixes = [
    'finalExamTimer.attendanceSubmitted.',
    'finalExamTimer.absenceTotal.',
    'finalExamTimer.earlyFinished.',
    'finalExamTimer.hallLock.',
    'finalExamTimer.supportRequest.'
  ];
  const exact = [STORE_KEYS.exams, STORE_KEYS.examsMirror, STORE_KEYS.fileName, 'finalExamTimer.exams.updatedAt', 'examTimerData.updatedAt'];
  try {
    exact.forEach(k => localStorage.removeItem(k));
    Object.keys(localStorage).forEach(k => { if (prefixes.some(p => k.startsWith(p))) localStorage.removeItem(k); });
  } catch {}
}
function getCurrentAdminLabel(){
  return adminUserEmail || sessionStorage.getItem("finalExamTimer.firebaseAuthUser") || "مسؤول";
}
function pushLocalOperationLog(entry){
  try {
    const rows = JSON.parse(localStorage.getItem(STORE_KEYS.operationLog) || "[]");
    rows.unshift(entry);
    localStorage.setItem(STORE_KEYS.operationLog, JSON.stringify(rows.slice(0, 100)));
  } catch {}
}
function logAdminOperation(action, details=""){
  const entry = { action, details, user:getCurrentAdminLabel(), atMs:Date.now(), at:new Date().toISOString() };
  pushLocalOperationLog(entry);
  if (operationLogsCollection()) operationLogsCollection().add(entry).catch(()=>{});
  renderOperationLog();
}
async function renderOperationLog(){
  const box = document.getElementById("operationLogList");
  if (!box) return;
  let rows = [];
  if (operationLogsCollection()) {
    try {
      const snap = await operationLogsCollection().orderBy("atMs", "desc").limit(80).get();
      snap.forEach(doc => rows.push(doc.data() || {}));
    } catch {}
  }
  if (!rows.length) { try { rows = JSON.parse(localStorage.getItem(STORE_KEYS.operationLog) || "[]"); } catch { rows = []; } }
  const body = rows.map(r => {
    const d = r.atMs ? new Intl.DateTimeFormat("ar-OM-u-nu-latn-ca-gregory", { dateStyle:"short", timeStyle:"short" }).format(new Date(Number(r.atMs))) : "";
    return `<tr><td>${escapeHtml(toArabicDigits(d))}</td><td>${escapeHtml(r.user||"")}</td><td>${escapeHtml(r.action||"")}</td><td>${escapeHtml(r.details||"")}</td></tr>`;
  }).join("");
  box.innerHTML = `<table class="support-hall-table"><thead><tr><th>التاريخ</th><th>المستخدم</th><th>العملية</th><th>التفاصيل</th></tr></thead><tbody>${body || '<tr><td colspan="4">لا توجد عمليات مسجلة بعد.</td></tr>'}</tbody></table>`;
}
function getSupportCode(){
  return String((cloudSettingsCache && cloudSettingsCache.supportCode) || localStorage.getItem(STORE_KEYS.supportCode) || "2026");
}
function getAttendanceTimeMinutes(){
  const raw = (cloudSettingsCache && cloudSettingsCache.attendanceTime) || localStorage.getItem(STORE_KEYS.attendanceTime) || "30";
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 30;
}
function getBeepDurationSetting(kind){
  const map = { start: [STORE_KEYS.beepStartDuration, "beepStartDuration", 3], half: [STORE_KEYS.beepHalfDuration, "beepHalfDuration", 3], fifteen: [STORE_KEYS.beepFifteenDuration, "beepFifteenDuration", 1], end: [STORE_KEYS.beepEndDuration, "beepEndDuration", 10] };
  const item = map[kind] || map.half;
  const raw = (cloudSettingsCache && cloudSettingsCache[item[1]]) || localStorage.getItem(item[0]) || String(item[2]);
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : item[2];
}
function isBeepEnabled(kind){
  const map = { start: [STORE_KEYS.beepStartEnabled, "beepStartEnabled"], half: [STORE_KEYS.beepHalfEnabled, "beepHalfEnabled"], fifteen: [STORE_KEYS.beepFifteenEnabled, "beepFifteenEnabled"], end: [STORE_KEYS.beepEndEnabled, "beepEndEnabled"] };
  const item = map[kind] || map.half;
  const cloudVal = cloudSettingsCache ? cloudSettingsCache[item[1]] : undefined;
  const localVal = localStorage.getItem(item[0]);
  const raw = cloudVal !== undefined ? String(cloudVal) : (localVal !== null ? localVal : "true");
  return raw !== "false" && raw !== "0";
}
function playConfiguredBeep(kind){
  if (isBeepEnabled(kind)) playBeep(getBeepDurationSetting(kind));
}
function attendanceReportsCollection(){
  if (!cloudDb) return null;
  return cloudDb.collection("attendanceReports");
}
function hallLocksCollection(){
  if (!cloudDb) return null;
  return cloudDb.collection("hallLocks");
}
function isSupportLoggedIn(){
  return sessionStorage.getItem("finalExamTimer.supportLoggedIn") === "true";
}
function setAdminSupportButtonVisible(visible){
  const btn = document.getElementById("adminOpenSupportBtn");
  if (btn) btn.classList.toggle("hidden", !visible);
}
async function ensurePrimaryAdminDoc(){
  if (!cloudDb) return false;
  return true;
}
async function isAuthorizedAdmin(email){
  const normalized = normalizeEmail(email);
  if (!normalized || !cloudDb) return false;
  if (normalized === PRIMARY_ADMIN_EMAIL) {
    await ensurePrimaryAdminDoc();
    return true;
  }
  try {
    const snap = await adminDoc(normalized).get();
    return snap.exists;
  } catch (err) {
    console.error(err);
    return false;
  }
}
function initCloudAuth(){
  if (!hasFirebaseConfig() || !hasFirebaseAuth()) return;
  try {
    cloudAuth = window.firebase.auth();
    cloudAuthReady = true;
    cloudAuth.onAuthStateChanged(async user => {
      adminUserEmail = user && user.email ? normalizeEmail(user.email) : "";
      adminAuthorized = false;
      if (user) {
        sessionStorage.setItem("finalExamTimer.firebaseAuthUser", user.email || "authenticated");
        adminAuthorized = await isAuthorizedAdmin(user.email);
        if (!adminAuthorized) {
          setCloudStatus(`تم تسجيل الدخول بحساب غير مصرح له: ${user.email}`);
          if (location.hash === "#admin") alert("هذا الحساب غير مصرح له بالدخول إلى الإعدادات.");
          await cloudAuth.signOut();
          return;
        }
        setCloudStatus(`متصل بالمزامنة السحابية كمسؤول: ${user.email}`);
        if (location.hash === "#admin" && sessionStorage.getItem("finalExamTimer.adminLoggedIn") === "true") {
          loadAdminsList();
        }
      } else {
        sessionStorage.removeItem("finalExamTimer.firebaseAuthUser");
        adminAuthorized = false;
        setCloudStatus(cloudStatusText || "متصل بالمزامنة السحابية عبر Firestore.");
      }
    });
  } catch (err) {
    console.error(err);
    cloudAuthReady = false;
  }
}
function isAdminAuthenticatedForWrite(){
  if (!cloudAuthReady) return true;
  return !!(cloudAuth && cloudAuth.currentUser && adminAuthorized);
}
function cloudValueToArray(value){
  if (Array.isArray(value)) return value.filter(Boolean);
  if (value && typeof value === "object") {
    return Object.keys(value)
      .sort((a,b) => Number(a) - Number(b))
      .map(k => value[k])
      .filter(Boolean);
  }
  return null;
}
function extractRowsFromCloudDoc(data){
  if (!data) return null;
  const rowsDirect = cloudValueToArray(data.rows);
  if (rowsDirect) return rowsDirect;
  const rowsData = cloudValueToArray(data.examsData);
  if (rowsData) return rowsData;
  if (typeof data.rowsJson === "string" && data.rowsJson.trim()) {
    try { const parsed = JSON.parse(data.rowsJson); return Array.isArray(parsed) ? parsed : null; } catch { return null; }
  }
  if (typeof data.examsJson === "string" && data.examsJson.trim()) {
    try { const parsed = JSON.parse(data.examsJson); return Array.isArray(parsed) ? parsed : null; } catch { return null; }
  }
  return null;
}
function isCloudEnabled(){ return cloudReady && hasFirebaseConfig(); }
function getAdminPassword(){
  return String((cloudSettingsCache && cloudSettingsCache.password) || localStorage.getItem(STORE_KEYS.password) || DEFAULT_PASSWORD);
}
function requireCloudForSharedSave(){
  if (!isCloudEnabled()) {
    alert("المزامنة السحابية غير مفعلة. لن تنتقل التعديلات بين الأجهزة. تأكد من firebase-config.js وقواعد Firestore.");
    return false;
  }
  if (!isAdminAuthenticatedForWrite()) {
    alert("يجب تسجيل الدخول بحساب Google مصرح له قبل حفظ التعديلات.");
    return false;
  }
  return true;
}
function isCloudStatusOnlineMessage(message){
  const text = String(message || "");
  if (!text) return !!cloudReady;
  if (/تعذر|غير مفعّل|غير مفعل|خطأ|تحقق|تنبيه|لم يتم|غير مصرح|فشل/.test(text)) return false;
  return /متصل|تم حفظ|مزامنة|سحابي|مسؤول/.test(text) || !!cloudReady;
}
function setCloudStatus(message){
  cloudStatusText = message || "";
  const online = isCloudStatusOnlineMessage(cloudStatusText);
  document.querySelectorAll("#cloudStatus,.cloud-status,.cloud-status-dot").forEach(el => {
    el.textContent = "";
    el.title = cloudStatusText || (online ? "متصل بالمزامنة السحابية" : "غير متصل بالمزامنة السحابية");
    el.setAttribute("aria-label", el.title);
    el.classList.toggle("cloud-online", online);
    el.classList.toggle("cloud-offline", !online);
  });
}

function shouldApplyForceRelease(settings){
  return false;
}
function applyForceReleaseFromSettings(settings){
  return;
}

function applyCloudRows(rows, stamp){
  rows = cloudValueToArray(rows);
  if (!Array.isArray(rows)) return false;
  cloudRowsCache = rows;
  suppressCloudSave = true;
  localStorage.setItem(STORE_KEYS.exams, JSON.stringify(rows));
  localStorage.setItem(STORE_KEYS.examsMirror, JSON.stringify(rows));
  localStorage.setItem("finalExamTimer.exams.updatedAt", String(stamp || Date.now()));
  localStorage.setItem("examTimerData.updatedAt", String(stamp || Date.now()));
  suppressCloudSave = false;
  cloudInitialLoadDone = true;
  refreshAllExams();
  if (currentHall) renderHall(currentHall); else populateHalls();
  updateStats();
  populateEditDates();
  updateDataFileInfo();
  return true;
}
function parseCloudRowsFromSettings(settings){
  return extractRowsFromCloudDoc(settings);
}
function initCloudSync(){
  if (cloudListenersAttached) return;
  if (!hasFirebaseConfig()) {
    cloudFirstSyncResolved = true;
    setCloudStatus("تنبيه: Firebase غير مفعّل. البيانات وكلمة المرور محفوظة محليًا فقط ولن تنتقل بين المتصفحات.");
    return;
  }
  if (!window.firebase || !window.firebase.firestore) {
    cloudFirstSyncResolved = true;
    setCloudStatus("تعذر تحميل Firestore. تحقق من اتصال الإنترنت أو إعدادات السكربت.");
    return;
  }
  try {
    if (!window.firebase.apps.length) window.firebase.initializeApp(window.FIREBASE_CONFIG);
    initCloudAuth();
    cloudDb = window.firebase.firestore();
    cloudReady = true;
    cloudListenersAttached = true;
    setCloudStatus("متصل بالمزامنة السحابية عبر Firestore.");

    firestoreDoc(FIRESTORE_DOCS.exams).onSnapshot(snap => {
      if (snap.exists) {
        const data = snap.data() || {};
        const rows = extractRowsFromCloudDoc(data);
        if (rows) applyCloudRows(rows, data.updatedAt || Date.now());
      } else {
        // أول تشغيل: ارفع البيانات المحلية/التجريبية إلى Firestore حتى تصبح مشتركة.
        const localRows = getStoredExams();
        if (Array.isArray(localRows) && localRows.length && !pendingCloudUploadAfterInit) {
          pendingCloudUploadAfterInit = true;
          saveCloudExams(localRows).finally(() => pendingCloudUploadAfterInit = false);
        }
      }
      cloudFirstSyncResolved = true;
    }, err => {
      console.error(err);
      cloudFirstSyncResolved = true;
      setCloudStatus("تعذر قراءة بيانات Firestore. تحقق من Rules أو إعدادات المشروع.");
    });

    firestoreDoc(FIRESTORE_DOCS.settings).onSnapshot(snap => {
      const settings = snap.exists ? (snap.data() || {}) : {};
      if (!snap.exists) saveCloudSettings({ password: DEFAULT_PASSWORD, supportCode: localStorage.getItem(STORE_KEYS.supportCode) || "2026", attendanceTime: localStorage.getItem(STORE_KEYS.attendanceTime) || "30", supportChairName: localStorage.getItem(STORE_KEYS.supportChairName) || "", supportChairTitle: localStorage.getItem(STORE_KEYS.supportChairTitle) || "", beepStartDuration: localStorage.getItem(STORE_KEYS.beepStartDuration) || "3", beepHalfDuration: localStorage.getItem(STORE_KEYS.beepHalfDuration) || "3", beepFifteenDuration: localStorage.getItem(STORE_KEYS.beepFifteenDuration) || "1", beepEndDuration: localStorage.getItem(STORE_KEYS.beepEndDuration) || "10", beepStartEnabled: localStorage.getItem(STORE_KEYS.beepStartEnabled) || "true", beepHalfEnabled: localStorage.getItem(STORE_KEYS.beepHalfEnabled) || "true", beepFifteenEnabled: localStorage.getItem(STORE_KEYS.beepFifteenEnabled) || "true", beepEndEnabled: localStorage.getItem(STORE_KEYS.beepEndEnabled) || "true", semester: localStorage.getItem(STORE_KEYS.semester) || "ربيع", academicYear: localStorage.getItem(STORE_KEYS.academicYear) || "2025 - 2026", createdAt: Date.now() });
      cloudSettingsCache = settings;
      applyForceReleaseFromSettings(settings);
      suppressCloudSave = true;
      if (settings.password) localStorage.setItem(STORE_KEYS.password, String(settings.password));
      if (settings.semester) localStorage.setItem(STORE_KEYS.semester, String(settings.semester));
      if (settings.academicYear) localStorage.setItem(STORE_KEYS.academicYear, String(settings.academicYear));
      if (settings.fileName) localStorage.setItem(STORE_KEYS.fileName, String(settings.fileName));
      if (settings.supportCode) localStorage.setItem(STORE_KEYS.supportCode, String(settings.supportCode));
      if (settings.attendanceTime) localStorage.setItem(STORE_KEYS.attendanceTime, String(settings.attendanceTime));
      if (settings.supportChairName) localStorage.setItem(STORE_KEYS.supportChairName, String(settings.supportChairName));
      if (settings.supportChairTitle) localStorage.setItem(STORE_KEYS.supportChairTitle, String(settings.supportChairTitle));
      if (settings.beepStartDuration) localStorage.setItem(STORE_KEYS.beepStartDuration, String(settings.beepStartDuration));
      if (settings.beepHalfDuration) localStorage.setItem(STORE_KEYS.beepHalfDuration, String(settings.beepHalfDuration));
      if (settings.beepFifteenDuration) localStorage.setItem(STORE_KEYS.beepFifteenDuration, String(settings.beepFifteenDuration));
      if (settings.beepEndDuration) localStorage.setItem(STORE_KEYS.beepEndDuration, String(settings.beepEndDuration));
      if (settings.timerPosition) localStorage.setItem(STORE_KEYS.timerPosition, String(settings.timerPosition));
      ["Start","Half","Fifteen","End"].forEach(k => { const prop = "beep" + k + "Enabled"; const key = STORE_KEYS["beep" + k + "Enabled"]; if (settings[prop] !== undefined && key) localStorage.setItem(key, String(settings[prop])); });
      if (settings.updatedAt) localStorage.setItem("finalExamTimer.exams.updatedAt", String(settings.updatedAt));
      suppressCloudSave = false;
      const cloudRows = parseCloudRowsFromSettings(settings);
      if (cloudRows) applyCloudRows(cloudRows, settings.updatedAt || Date.now());
      setTitles();
      applyTimerPositionSetting();
      updateDataFileInfo();
      updateStats();
      populateEditDates();
      if (!currentHall) populateHalls();
    }, err => {
      console.error(err);
      setCloudStatus("تعذر قراءة إعدادات Firestore. تحقق من Rules أو إعدادات المشروع.");
    });
  } catch (err) {
    console.error(err);
    cloudReady = false;
    cloudFirstSyncResolved = true;
    setCloudStatus("خطأ في الاتصال بالمزامنة السحابية. تحقق من firebase-config.js وقواعد Firestore.");
  }
}
function saveCloudExams(rows){
  if (!cloudReady || suppressCloudSave) return Promise.resolve(false);
  try {
    const safeRows = Array.isArray(rows) ? rows : [];
    const stamp = Date.now();
    const fileName = localStorage.getItem(STORE_KEYS.fileName) || (cloudSettingsCache && cloudSettingsCache.fileName) || "";
    return firestoreDoc(FIRESTORE_DOCS.exams).set({ rows: safeRows, rowsJson: JSON.stringify(safeRows), updatedAt: stamp, fileName }, { merge: true })
      .then(() => firestoreDoc(FIRESTORE_DOCS.settings).set({ updatedAt: stamp, fileName }, { merge: true }))
      .then(() => { setCloudStatus("تم حفظ البيانات سحابيًا ومزامنتها."); return true; })
      .catch(err => { console.error(err); setCloudStatus("تعذر حفظ البيانات في Firestore. تحقق من Rules."); alert("لم يتم حفظ البيانات سحابيًا. تحقق من قواعد Firestore."); return false; });
  }
  catch (err) { console.error(err); setCloudStatus("تعذر حفظ البيانات في Firestore."); return Promise.resolve(false); }
}
function saveCloudSettings(partial){
  if (!cloudReady || suppressCloudSave) return Promise.resolve(false);
  try {
    const payload = { ...(partial || {}), settingsUpdatedAt: Date.now() };
    cloudSettingsCache = { ...(cloudSettingsCache || {}), ...payload };
    return firestoreDoc(FIRESTORE_DOCS.settings).set(payload, { merge: true }).then(() => true).catch(err => {
      console.error(err);
      setCloudStatus("تعذر حفظ الإعدادات في Firestore.");
      alert("لم يتم حفظ الإعدادات سحابيًا. تحقق من Firestore Rules.");
      return false;
    });
  }
  catch (err) { console.error(err); setCloudStatus("تعذر حفظ الإعدادات في Firestore."); return Promise.resolve(false); }
}
let allExams = [];
let currentHall = "";
let activePeriodExams = [];
let currentPeriod = null;
let timerInterval = null;
let refreshInterval = null;
let endHandled = false;
let halfHandled = false;
let fifteenMinuteHandled = false;
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
async function saveExams(rows, shouldNotify = true){
  const normalizedRows = Array.isArray(rows) ? rows : [];
  const payload = JSON.stringify(normalizedRows);
  const stamp = String(Date.now());
  // نكتب في مفتاحين لمنع مشكلة قراءة صفحة من مفتاح وصفحة أخرى من مفتاح مختلف.
  localStorage.setItem(STORE_KEYS.exams, payload);
  localStorage.setItem(STORE_KEYS.examsMirror, payload);
  localStorage.setItem("finalExamTimer.exams.updatedAt", stamp);
  localStorage.setItem("examTimerData.updatedAt", stamp);

  let cloudSaved = true;
  if (cloudReady && !suppressCloudSave) {
    const examsSaved = await saveCloudExams(normalizedRows);
    const settingsSaved = await saveCloudSettings({ updatedAt: stamp });
    cloudSaved = !!(examsSaved && settingsSaved);
  }

  if (shouldNotify) notifyDataChanged();
  return cloudSaved;
}
async function saveExamsWithMeta(rows, fileName = "", shouldNotify = true){
  let metaSaved = true;
  if (fileName) {
    localStorage.setItem(STORE_KEYS.fileName, fileName);
    if (cloudReady && !suppressCloudSave) metaSaved = await saveCloudSettings({ fileName });
  }
  const rowsSaved = await saveExams(rows, shouldNotify);
  return !!(metaSaved && rowsSaved);
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

async function enableWakeLock(){
  if (wakeLockRequested || wakeLock) return;
  if (!("wakeLock" in navigator)) return;
  try {
    wakeLockRequested = true;
    wakeLock = await navigator.wakeLock.request("screen");
    wakeLock.addEventListener("release", () => { wakeLock = null; wakeLockRequested = false; });
  } catch (err) {
    wakeLock = null;
    wakeLockRequested = false;
    console.warn("Wake Lock unavailable", err);
  }
}
async function disableWakeLock(){
  try {
    if (wakeLock) await wakeLock.release();
  } catch {}
  wakeLock = null;
  wakeLockRequested = false;
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && currentPeriod) {
    const now = new Date();
    if (now >= currentPeriod.start && now < currentPeriod.end && !endHandled) enableWakeLock();
  }
});

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

function getExamStart(exam){ return combineDateTime(exam.date, exam.period.startMinutes); }
function getExamEnd(exam){ return combineDateTime(exam.date, exam.period.endMinutes); }
function formatShortDateTime(date){
  const day = new Intl.DateTimeFormat("ar-OM-u-nu-latn-ca-gregory", { weekday:"long" }).format(date);
  const d = `${pad(date.getDate())} / ${pad(date.getMonth()+1)} / ${date.getFullYear()}`;
  const t = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return { day: toArabicDigits(day), date: toArabicDigits(d), time: toArabicDigits(t) };
}
function getNearestFutureExam(now = new Date()){
  return allExams
    .filter(e => e.period && getExamStart(e) > now)
    .sort((a,b) => getExamStart(a) - getExamStart(b))[0] || null;
}
function getLastExamEnd(){
  const ends = allExams.filter(e => e.period).map(getExamEnd).filter(d => !isNaN(d));
  if (!ends.length) return null;
  return new Date(Math.max(...ends.map(d => d.getTime())));
}
function getCurrentTermText(){
  const term = getDisplayTerm();
  if (term && term.active) return term;
  const fallback = getExamSeason(new Date());
  return fallback && fallback.active ? fallback : { active:true, semester:"الحالي", academicYear: localStorage.getItem(STORE_KEYS.academicYear) || "" };
}
function renderNoExamState(){
  const setup = document.getElementById("setupPanel");
  const view = document.getElementById("examView");
  const empty = document.getElementById("emptyState");
  if (!empty) return;
  setup?.classList.add("hidden");
  view?.classList.add("hidden");
  try { const select = document.getElementById("hallSelect"); if (select) select.value = ""; } catch {}
  empty.classList.remove("hidden");
  const now = new Date();
  const lastEnd = getLastExamEnd();
  if (lastEnd && now > lastEnd) {
    const term = getCurrentTermText();
    empty.innerHTML = `<h2>انتهت الامتحانات النهائية للفصل الدراسي (${escapeHtml(term.semester)})</h2><p>للعام الأكاديمي ${escapeHtml(term.academicYear || "")}</p>`;
    return;
  }
  const next = getNearestFutureExam(now);
  if (next) {
    const start = getExamStart(next);
    const f = formatShortDateTime(start);
    empty.innerHTML = `<h2>لا يوجد امتحانات حاليًا</h2><p>أقرب امتحان سيكون بتاريخ ${escapeHtml(f.day)} ${escapeHtml(f.date)}</p><p>الساعة ${escapeHtml(f.time)}</p>`;
  } else {
    empty.innerHTML = `<h2>لا توجد امتحانات حاليًا</h2>`;
  }
}
function getExamsForHall(hall){
  const now = new Date();
  const halls = allExams.filter(e => e.hall === hall && e.period && !isSectionFinished(e));
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

function getSectionTypeLabel(section){
  const digits = toArabicDigits(section).replace(/\D/g, "");
  if (!digits) return String(section || "");
  return `${digits.length > 1 ? "SIS" : "CIMS"}(${digits})`;
}
function safeDocId(value){
  return String(value || "").replace(/[^A-Za-z0-9_؀-ۿ-]/g, "_").slice(0, 500);
}
function sectionExamKey(e){
  if (!e) return "";
  return [e.date, e.periodRaw, e.hall, e.courseCode, e.courseName, e.section].map(x => String(x || "").trim()).join("|");
}
function finishedSectionsKey(){
  return "finalExamTimer.finishedSections";
}
function getFinishedSectionsSet(){
  try { return new Set(JSON.parse(localStorage.getItem(finishedSectionsKey()) || "[]")); } catch { return new Set(); }
}
function saveFinishedSectionsSet(set){
  localStorage.setItem(finishedSectionsKey(), JSON.stringify([...set]));
}
function isSectionFinished(e){
  return getFinishedSectionsSet().has(sectionExamKey(e));
}
function attendanceKeyForCurrentPeriod(){
  if (!currentHall || !currentPeriod || !activePeriodExams.length) return "";
  const first = activePeriodExams[0];
  return `finalExamTimer.attendanceSubmitted.${first.date}.${currentPeriod.startText}-${currentPeriod.endText}.${currentHall}`;
}
function getStoredAbsenceTotal(){
  const key = attendanceKeyForCurrentPeriod();
  if (!key) return 0;
  return Number(localStorage.getItem(key + ".total") || 0) || 0;
}
function updateAbsenceSummaryCard(total){
  const card = document.getElementById("absenceSummaryCard");
  const value = document.getElementById("absenceTotalValue");
  if (!card || !value) return;
  const n = Number(total || 0);
  value.textContent = toArabicDigits(n);
  card.classList.toggle("hidden", !attendanceSubmitted && n <= 0);
}
function computeCommitteeCount(exams){
  const set = new Set();
  (exams || []).forEach(e => set.add(`${e.date}|${e.periodRaw}|${e.hall}`));
  return set.size;
}
function getAbsenceRequestsForToday(){
  const now = new Date();
  return supportAbsenceRequestsCache.filter(r => {
    const d = r.createdAtMs ? new Date(r.createdAtMs) : null;
    return d && isSameDay(d, now);
  });
}
function attendanceReportDate(report){
  if (report && report.date) return normalizeDate(report.date);
  const ms = Number(report?.submittedAtMs || report?.examEndMs || 0);
  if (!ms) return "";
  const d = new Date(ms);
  return normalizeDate(`${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`);
}
function attendanceReportPeriodMatches(report, periodText){
  if (!periodText) return true;
  return periodMatchesFilter({ periodText: report?.periodText || "" }, periodText);
}
function getAttendanceReportTotalForExams(exams){
  const list = Array.isArray(exams) ? exams : [];
  if (!list.length) return 0;
  const keys = new Set(list.map(e => sectionExamKey(e)));
  const examDates = new Set(list.map(e => e.date));
  const periods = new Set(list.map(e => periodKeyForExam(e)).map(normalizePeriodFilterText));
  let total = 0;
  (supportAttendanceReportsCache || []).forEach(report => {
    const reportDate = attendanceReportDate(report);
    if (reportDate && !examDates.has(reportDate)) return;
    const periodOk = !periods.size || [...periods].some(p => attendanceReportPeriodMatches(report, p));
    if (!periodOk) return;
    if (Array.isArray(report.details) && report.details.length) {
      report.details.forEach(d => {
        const key = d.examKey || makeExamKey({
          "التاريخ": d.examDate || reportDate,
          "الفترة": d.periodText || report.periodText || "",
          "القاعة": d.hall || report.hall || "",
          "رمز المقرر": d.courseCode || "",
          "الشعبة": d.section || ""
        });
        if (keys.has(key)) total += Number(d.absenceCount || 0) || 0;
      });
    } else if (report.hall) {
      const hallMatch = list.some(e => clean(e.hall) === clean(report.hall) && attendanceReportPeriodMatches(report, periodKeyForExam(e)));
      if (hallMatch) total += Number(report.totalAbsence || 0) || 0;
    }
  });
  return total;
}
function getAbsenceTotalForExams(exams){
  const fromReports = getAttendanceReportTotalForExams(exams);
  if (fromReports > 0) return fromReports;
  const keys = new Set((exams || []).map(e => sectionExamKey(e)));
  return getAbsenceRequestsForToday().filter(r => keys.has(r.examKey)).reduce((s,r)=>s+(Number(r.absenceCount)||0),0);
}

function updateSupportCallButtonVisibility(){
  const btn = document.getElementById("supportCallBtn");
  if (!btn) return;
  const now = new Date();
  const active = !!(currentHall && currentPeriod && now <= currentPeriod.end && activePeriodExams.length);
  btn.classList.toggle("hidden", !active);
}
function updateEarlyEndButtonVisibility(){
  const btn = document.getElementById("earlyEndBtn");
  if (!btn) return;
  const now = new Date();
  const half = currentPeriod ? new Date(currentPeriod.start.getTime() + currentPeriod.durationMs / 2) : null;
  const active = !!(currentHall && currentPeriod && activePeriodExams.length && half && now >= half && now < currentPeriod.end);
  btn.classList.toggle("hidden", !active);
}
function buildSupportRequestLabel(req){
  if (req && req.kind === "absence") return req.message || "تنبيه غياب";
  if (req && req.kind === "earlyFinish") return req.message || "انتهى اختبار";
  const type = req.type || "استدعاء";
  if (type === "استدعاء مدرس المقرر") {
    const course = `${req.courseName || ""}${req.courseCode ? " - " + req.courseCode : ""}`;
    const reason = req.teacherReason ? ` — ${req.teacherReason}` : "";
    return `${type} (${course})${reason}`;
  }
  if (type === "دورة مياه" || type === "حالة مرضية") return `${type} (${req.gender || ""})`;
  return type;
}
function closeSupportRequestModal(){
  document.getElementById("supportRequestModal")?.classList.add("hidden");
  currentSupportDraft = null;
}
function setSupportRequestContentStep(step, data={}){
  const box = document.getElementById("supportRequestContent");
  const submit = document.getElementById("supportRequestSubmit");
  if (!box || !submit) return;
  currentSupportDraft = { ...(currentSupportDraft || {}), ...data };
  submit.classList.add("hidden");
  if (step === "confirm") {
    box.innerHTML = `<p class="support-question">هل تريد استدعاء لجنة دعم المراقبة والامتحانات؟</p>
      <div class="support-options-grid"><button data-step="types" class="secondary-btn" type="button">نعم</button><button data-close="1" class="secondary-btn" type="button">لا</button></div>`;
  } else if (step === "types") {
    box.innerHTML = `<div class="support-options-grid support-types">
      <button data-type="حالة غش" class="secondary-btn" type="button">حالة غش</button>
      <button data-type="استدعاء مدرس المقرر" class="secondary-btn" type="button">استدعاء مدرس المقرر</button>
      <button data-type="دورة مياه" class="secondary-btn" type="button">دورة مياه</button>
      <button data-type="حالة مرضية" class="secondary-btn" type="button">حالة مرضية</button>
      <button data-type="استفسار" class="secondary-btn" type="button">استفسار</button>
    </div>`;
  } else if (step === "course") {
    const courses = groupCourses(activePeriodExams);
    box.innerHTML = `<p class="support-question">اختر المقرر المطلوب استدعاء مدرسه</p><div class="support-options-grid">${courses.map(c => `<button class="secondary-btn" data-course-code="${escapeHtml(c.courseCode)}" data-course-name="${escapeHtml(c.courseName)}" type="button">${escapeHtml(c.courseName)}<br><small>${escapeHtml(c.courseCode)}</small></button>`).join("")}</div>`;
  } else if (step === "teacherReason") {
    box.innerHTML = `<p class="support-question">اختر سبب استدعاء مدرس المقرر</p><div class="support-options-grid"><button data-teacher-reason="التعرف على طالب" class="secondary-btn" type="button">التعرف على طالب</button><button data-teacher-reason="استفسار متعلق بالامتحان" class="secondary-btn" type="button">استفسار متعلق بالامتحان</button></div>`;
  } else if (step === "gender") {
    box.innerHTML = `<p class="support-question">اختر الفئة</p><div class="support-options-grid"><button data-gender="طالب" class="secondary-btn" type="button">طالب</button><button data-gender="طالبة" class="secondary-btn" type="button">طالبة</button></div>`;
  } else if (step === "ready") {
    const label = buildSupportRequestLabel(currentSupportDraft);
    box.innerHTML = `<p class="support-question">نوع الاستدعاء: <strong>${escapeHtml(label)}</strong></p><p class="soft-note">سيتم إرسال الطلب من قاعة ${escapeHtml(currentHall)} إلى لجنة الدعم.</p>`;
    submit.classList.remove("hidden");
  }
}
function showAppToast(message, duration=3000){
  let toast = document.getElementById("appToast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "appToast";
    toast.className = "app-toast hidden";
    document.body.appendChild(toast);
  }
  toast.textContent = message || "تم";
  toast.classList.remove("hidden");
  clearTimeout(showAppToast._timer);
  showAppToast._timer = setTimeout(() => toast.classList.add("hidden"), duration);
}

function openSupportRequestModal(){
  if (!currentHall || !currentPeriod || !activePeriodExams.length) return;
  currentSupportDraft = { hall: currentHall };
  document.getElementById("supportRequestModal")?.classList.remove("hidden");
  setSupportRequestContentStep("confirm");
}
async function submitSupportRequest(){
  if (!currentSupportDraft || !currentHall || !currentPeriod) return;
  if (!isCloudEnabled() || !supportRequestsCollection()) return alert("لا يمكن إرسال الاستدعاء بدون اتصال Firestore.");
  const req = {
    hall: currentHall,
    type: currentSupportDraft.type || "استدعاء",
    courseName: currentSupportDraft.courseName || "",
    courseCode: currentSupportDraft.courseCode || "",
    gender: currentSupportDraft.gender || "",
    teacherReason: currentSupportDraft.teacherReason || "",
    createdAtMs: Date.now(),
    examEndMs: currentPeriod.end.getTime(),
    periodText: `${currentPeriod.startText} - ${currentPeriod.endText}`,
    status: "pending",
    acknowledged: false,
    acknowledgedAtMs: 0,
    displaySeenAck: false
  };
  try {
    await supportRequestsCollection().add(req);
    closeSupportRequestModal();
    showAppToast("تم إرسال طلب الاستدعاء إلى لجنة الدعم.");
  } catch (err) {
    console.error(err);
    alert("تعذر إرسال طلب الاستدعاء. تحقق من قواعد Firestore.");
  }
}
function initSupportRequestModal(){
  document.getElementById("supportCallBtn")?.addEventListener("click", openSupportRequestModal);
  document.getElementById("supportRequestCancel")?.addEventListener("click", closeSupportRequestModal);
  document.getElementById("supportRequestSubmit")?.addEventListener("click", submitSupportRequest);
  document.getElementById("supportRequestContent")?.addEventListener("click", event => {
    const btn = event.target.closest("button"); if (!btn) return;
    if (btn.dataset.close) return closeSupportRequestModal();
    if (btn.dataset.step === "types") return setSupportRequestContentStep("types");
    if (btn.dataset.type) {
      const type = btn.dataset.type;
      currentSupportDraft = { ...(currentSupportDraft || {}), type };
      if (type === "استدعاء مدرس المقرر" && groupCourses(activePeriodExams).length > 1) return setSupportRequestContentStep("course");
      if (type === "استدعاء مدرس المقرر") {
        const c = groupCourses(activePeriodExams)[0] || {};
        currentSupportDraft.courseName = c.courseName || ""; currentSupportDraft.courseCode = c.courseCode || "";
        return setSupportRequestContentStep("teacherReason");
      }
      if (type === "دورة مياه" || type === "حالة مرضية") return setSupportRequestContentStep("gender");
      return setSupportRequestContentStep("ready");
    }
    if (btn.dataset.courseCode) {
      currentSupportDraft.courseCode = btn.dataset.courseCode;
      currentSupportDraft.courseName = btn.dataset.courseName || "";
      return setSupportRequestContentStep("teacherReason");
    }
    if (btn.dataset.teacherReason) {
      currentSupportDraft.teacherReason = btn.dataset.teacherReason;
      return setSupportRequestContentStep("ready");
    }
    if (btn.dataset.gender) {
      currentSupportDraft.gender = btn.dataset.gender;
      return setSupportRequestContentStep("ready");
    }
  });
  document.getElementById("ackModalClose")?.addEventListener("click", () => document.getElementById("ackModal")?.classList.add("hidden"));
}
function watchHallSupportAcks(){
  if (hallRequestsUnsubscribe) { try { hallRequestsUnsubscribe(); } catch {} hallRequestsUnsubscribe = null; }
  if (!currentHall || !supportRequestsCollection()) return;
  hallRequestsUnsubscribe = supportRequestsCollection().where("hall", "==", currentHall).onSnapshot(snap => {
    const now = Date.now();
    snap.docChanges().forEach(change => {
      const data = change.doc.data() || {};
      if (data.acknowledged && !data.displaySeenAck && Number(data.examEndMs || 0) >= now - 60000) {
        const ackMsg = data.kind === "absence"
          ? "تم استلام الغياب من قبل اللجنة"
          : (data.kind === "earlyFinish" ? "تم علم اللجنة بانتهاء الاختبار المحدد" : "تم استلام طلبك من لجنة الدعم.");
        showAppToast(ackMsg, 3000);
        supportRequestsCollection().doc(change.doc.id).set({ displaySeenAck: true }, { merge:true }).catch(()=>{});
      }
    });
  });
}
function stopHallSupportAcks(){
  if (hallRequestsUnsubscribe) { try { hallRequestsUnsubscribe(); } catch {} hallRequestsUnsubscribe = null; }
}
function supportRequestHtml(id, req){
  const label = buildSupportRequestLabel(req);
  const time = req.createdAtMs ? new Intl.DateTimeFormat("ar-OM-u-nu-latn-ca-gregory", { hour:"2-digit", minute:"2-digit" }).format(new Date(req.createdAtMs)) : "";
  return `<article class="support-notification ${req.acknowledged ? 'is-acknowledged' : ''} ${req.kind === 'absence' ? 'is-absence' : ''} ${req.kind === 'earlyFinish' ? 'is-early-finish' : ''}">
    <div><strong>قاعة ${escapeHtml(req.hall || "")}</strong><span>${escapeHtml(label)}</span><small>${escapeHtml(toArabicDigits(time))} — ${escapeHtml(req.periodText || "")}</small></div>
    ${req.acknowledged ? '<span class="received-badge">تم الاستلام</span>' : `<button type="button" class="ack-btn" data-ack-id="${escapeHtml(id)}" title="استلام">✓</button>`}
  </article>`;
}
function initSupportPage(){
  document.getElementById("supportLoginBtn")?.addEventListener("click", () => {
    const code = document.getElementById("supportAccessCode")?.value.trim() || "";
    if (code !== getSupportCode()) return alert("رمز دخول لجنة الدعم غير صحيح.");
    sessionStorage.setItem("finalExamTimer.supportLoggedIn", "true");
    location.hash = "support";
  });
  document.getElementById("supportNotifications")?.addEventListener("click", async e => {
    const btn = e.target.closest("[data-ack-id]"); if (!btn || !supportRequestsCollection()) return;
    try { await supportRequestsCollection().doc(btn.dataset.ackId).set({ acknowledged:true, status:"acknowledged", acknowledgedAtMs:Date.now() }, { merge:true }); }
    catch(err){ console.error(err); alert("تعذر تأكيد الاستلام."); }
  });
}
function periodKeyForExam(e){
  return e && e.period ? `${e.period.startText} - ${e.period.endText}` : "غير محدد";
}
function normalizePeriodFilterText(value){
  return String(value || "")
    .replace(/[٠-٩]/g, d => "٠١٢٣٤٥٦٧٨٩".indexOf(d))
    .replace(/[۰-۹]/g, d => "۰۱۲۳۴۵۶۷۸۹".indexOf(d))
    .replace(/من\s*/g, "")
    .replace(/إلى|الى|–|—|−/g, "-")
    .replace(/\s*-\s*/g, " - ")
    .replace(/\s+/g, " ")
    .trim();
}
function getRequestPeriodCandidates(r){
  const candidates = [];
  if (r && r.periodText) candidates.push(r.periodText);
  if (r && r.examKey) {
    const parts = String(r.examKey).split('|');
    if (parts[1]) candidates.push(parts[1]);
  }
  if (r && r.periodRaw) candidates.push(r.periodRaw);
  return candidates.filter(Boolean);
}
function periodMatchesFilter(requestObj, filterValue){
  if (!filterValue) return true;
  const target = normalizePeriodFilterText(filterValue);
  const targetParsed = parsePeriod(target);
  return getRequestPeriodCandidates(requestObj).some(p => {
    const norm = normalizePeriodFilterText(p);
    if (norm === target) return true;
    const parsed = parsePeriod(norm);
    return parsed && targetParsed && parsed.startMinutes === targetParsed.startMinutes && parsed.endMinutes === targetParsed.endMinutes;
  });
}
function makeExamKey(row){
  if (!row) return "";
  const date = String(row["التاريخ"] || row.date || "").trim();
  const period = String(row["الفترة"] || row.period || "").trim();
  const hall = String(row["القاعة"] || row.hall || "").trim();
  const code = String(row["رمز المقرر"] || row.courseCode || "").trim();
  const section = String(row["الشعبة"] || row.section || "").trim();
  return [date, period, hall, code, section].join("|");
}

function findExamForAbsenceRequest(r){
  const exams = getAllNormalizedExams();
  if (!r) return null;
  if (r.examKey) {
    const hit = exams.find(e => makeExamKey(e) === r.examKey);
    if (hit) return hit;
  }
  const reqSec = clean(r.section || '').replace(/\D/g,'') || clean(r.section || '');
  return exams.find(e => {
    const sec = clean(e.section || '').replace(/\D/g,'') || clean(e.section || '');
    return (!r.courseCode || clean(e.courseCode).toUpperCase() === clean(r.courseCode).toUpperCase()) &&
      (!r.hall || clean(e.hall) === clean(r.hall)) &&
      (!r.examDate || clean(e.date) === normalizeDate(r.examDate)) &&
      (!reqSec || sec === reqSec);
  }) || null;
}

function getTodayExamsForSupport(){
  refreshAllExams();
  const now = new Date();
  return allExams.filter(e => isSameDay(combineDateTime(e.date, e.period.startMinutes), now));
}
function periodName(index){
  const names = ["الفترة الأولى", "الفترة الثانية", "الفترة الثالثة", "الفترة الرابعة", "الفترة الخامسة"];
  return names[index] || `الفترة ${toArabicDigits(index + 1)}`;
}
let supportTodayExamsCache = [];
let supportPeriodEntriesCache = [];

function buildSupportPeriodEntries(todayExams){
  const periods = new Map();
  todayExams.forEach(e => {
    const key = periodKeyForExam(e);
    if (!periods.has(key)) periods.set(key, []);
    periods.get(key).push(e);
  });
  return [...periods.entries()].sort((a,b) => {
    const ea = a[1][0], eb = b[1][0];
    return (ea?.period?.startMinutes || 0) - (eb?.period?.startMinutes || 0);
  });
}

function renderSupportPeriodSelector(todayExams){
  supportTodayExamsCache = Array.isArray(todayExams) ? todayExams : [];
  supportPeriodEntriesCache = buildSupportPeriodEntries(supportTodayExamsCache);
  const select = document.getElementById("supportPeriodSelect");
  const details = document.getElementById("supportPeriodStats");
  const hallsBox = document.getElementById("supportHallStats");
  if (!select || !details || !hallsBox) return;
  if (!supportPeriodEntriesCache.length) {
    select.innerHTML = `<option value="">لا توجد فترات اليوم</option>`;
    details.innerHTML = `<div class="empty-mini-stat">لا توجد فترات اختبار اليوم</div>`;
    hallsBox.innerHTML = `<div class="empty-mini-stat">لا توجد قاعات مستخدمة اليوم</div>`;
    return;
  }
  const previous = select.value;
  select.innerHTML = supportPeriodEntriesCache.map(([period, exams], idx) => {
    const label = `${periodName(idx)} — ${period}`;
    return `<option value="${idx}">${escapeHtml(label)}</option>`;
  }).join("");
  const selectedIndex = previous && Number(previous) < supportPeriodEntriesCache.length ? Number(previous) : 0;
  select.value = String(selectedIndex);
  select.onchange = () => renderSelectedSupportPeriod(Number(select.value || 0));
  renderSelectedSupportPeriod(selectedIndex);
}

function renderSelectedSupportPeriod(idx){
  const details = document.getElementById("supportPeriodStats");
  const hallsBox = document.getElementById("supportHallStats");
  if (!details || !hallsBox) return;
  const entry = supportPeriodEntriesCache[idx];
  if (!entry) {
    details.innerHTML = `<div class="empty-mini-stat">لا توجد بيانات للفترة المختارة</div>`;
    hallsBox.innerHTML = `<div class="empty-mini-stat">لا توجد قاعات مستخدمة</div>`;
    return;
  }
  const [period, exams] = entry;
  const halls = unique(exams.map(e => e.hall));
  const courses = uniqueCourseCount(exams);
  const sections = exams.map(e => clean(e.section)).filter(Boolean).length;
  const students = sumStudents(exams);
  const absence = getAbsenceTotalForExams(exams);
  const absenceRate = students ? ((absence / students) * 100).toFixed(2) : "0.00";
  details.innerHTML = `<div class="support-period-summary compact">
    <div><strong>${toArabicDigits(courses)}</strong><span>مقررات</span></div>
    <div><strong>${toArabicDigits(sections)}</strong><span>شعب</span></div>
    <div><strong>${toArabicDigits(halls.length)}</strong><span>قاعات</span></div>
    <div><strong>${toArabicDigits(students)}</strong><span>طلبة</span></div>
    <div><strong>${toArabicDigits(absence)}</strong><span>غياب</span></div>
    <div><strong>${toArabicDigits(absenceRate)}%</strong><span>نسبة الغياب</span></div>
  </div>`;
  renderSupportHallTable(exams);
}

function renderSupportHallTable(exams){
  const box = document.getElementById("supportHallStats");
  if (!box) return;
  if (!exams || !exams.length) {
    box.innerHTML = `<div class="empty-mini-stat">لا توجد قاعات مستخدمة في الفترة المختارة</div>`;
    return;
  }
  const rows = [...exams].sort((a,b) =>
    String(a.hall).localeCompare(String(b.hall), "ar", {numeric:true}) ||
    String(a.courseName).localeCompare(String(b.courseName), "ar") ||
    String(a.section).localeCompare(String(b.section), "ar", {numeric:true})
  );
  const hallCounts = new Map();
  rows.forEach(e => hallCounts.set(e.hall, (hallCounts.get(e.hall) || 0) + 1));
  const hallSeen = new Map();
  const body = rows.map(e => {
    const count = hallCounts.get(e.hall) || 1;
    const seen = hallSeen.get(e.hall) || 0;
    hallSeen.set(e.hall, seen + 1);
    const hallCell = seen === 0 ? `<td class="support-hall-merged" rowspan="${count}">${escapeHtml(e.hall)}</td>` : "";
    return `<tr>${hallCell}
      <td>${escapeHtml(e.courseName)}</td>
      <td>${escapeHtml(e.courseCode)}</td>
      <td>${escapeHtml(getSectionTypeLabel(e.section))}</td>
      <td>${toArabicDigits(e.students)}</td>
    </tr>`;
  }).join("");
  box.innerHTML = `<table class="support-hall-table">
    <thead><tr><th>القاعة</th><th>اسم المقرر</th><th>كود المقرر</th><th>الشعبة</th><th>عدد الطلبة</th></tr></thead>
    <tbody>${body}</tbody>
  </table>`;
}

function renderSupportPeriodStats(todayExams){
  renderSupportPeriodSelector(todayExams);
}
function renderSupportHallStats(todayExams){
  // Rendered through the selected-period table to avoid horizontal overflow.
}
function updateSupportStats(){
  const todayExams = getTodayExamsForSupport();
  setStat("supportTodayCourses", uniqueCourseCount(todayExams));
  setStat("supportTodaySections", todayExams.map(e => clean(e.section)).filter(Boolean).length);
  setStat("supportTodayHalls", computeCommitteeCount(todayExams));
  setStat("supportTodayStudents", sumStudents(todayExams));
  setStat("supportTodayAbsence", getAbsenceTotalForExams(todayExams));
  renderSupportPeriodStats(todayExams);
  renderSupportHallStats(todayExams);
}
function archiveExpiredSupportRequests(snapshot, now = Date.now()){
  if (!supportRequestsCollection() || !snapshot || !snapshot.docs) return;
  snapshot.docs.forEach(doc => {
    const data = doc.data() || {};
    const end = Number(data.examEndMs || 0);
    if (end && end < now && !data.archived) {
      supportRequestsCollection().doc(doc.id).set({ archived:true, status:"archived", archivedAtMs: now }, { merge:true }).catch(()=>{});
    }
  });
}


function attachAttendanceReportsListener(){
  if (attendanceReportsUnsubscribe || !attendanceReportsCollection()) return;
  attendanceReportsUnsubscribe = attendanceReportsCollection().onSnapshot(snap => {
    const rows = [];
    snap.docs.forEach(doc => rows.push({ id: doc.id, ...(doc.data() || {}) }));
    supportAttendanceReportsCache = rows;
    updateSupportStats();
  }, err => console.error(err));
}
function detachAttendanceReportsListener(){
  if (attendanceReportsUnsubscribe) { try { attendanceReportsUnsubscribe(); } catch {} attendanceReportsUnsubscribe = null; }
}

function attachSupportRequestsListener(){
  if (supportRequestsUnsubscribe || !supportRequestsCollection()) return;
  supportRequestsUnsubscribe = supportRequestsCollection().onSnapshot(snap => {
    const now = Date.now();
    archiveExpiredSupportRequests(snap, now);
    const rows = [];
    snap.docs.forEach(doc => {
      const data = doc.data() || {};
      if (!data.archived && Number(data.examEndMs || 0) >= now) rows.push({ id: doc.id, ...data });
    });
    supportAbsenceRequestsCache = rows.filter(r => r.kind === "absence");
    rows.sort((a,b) => (a.acknowledged === b.acknowledged ? 0 : a.acknowledged ? 1 : -1) || (b.createdAtMs || 0) - (a.createdAtMs || 0));
    updateSupportStats();
    const box = document.getElementById("supportNotifications");
    if (box) box.innerHTML = rows.length ? rows.map(r => supportRequestHtml(r.id, r)).join("") : '<div class="empty-mini-stat">لا توجد إشعارات حاليًا</div>';
    const currentIds = new Set(rows.map(r => r.id));
    rows.forEach(r => {
      if (!supportKnownRequestIds.has(r.id) && !r.acknowledged && location.hash === "#support") playBeep(2);
    });
    supportKnownRequestIds = currentIds;
  }, err => console.error(err));
}
function detachSupportRequestsListener(){
  if (supportRequestsUnsubscribe) { try { supportRequestsUnsubscribe(); } catch {} supportRequestsUnsubscribe = null; }
}

async function openAttendanceModalIfNeeded(){
  if (!currentHall || !currentPeriod || !activePeriodExams.length) return;
  if (attendanceModalShown || attendanceSubmitted) return;
  const alreadySubmitted = await checkAttendanceAlreadySubmitted();
  if (alreadySubmitted) { attendanceSubmitted = true; updateAbsenceSummaryCard(getStoredAbsenceTotal()); return; }
  const key = attendanceKeyForCurrentPeriod();
  if (key && localStorage.getItem(key) === "1") {
    attendanceSubmitted = true;
    updateAbsenceSummaryCard(getStoredAbsenceTotal());
    return;
  }
  attendanceModalShown = true;
  renderAttendanceModalRows();
  document.getElementById("attendanceModal")?.classList.remove("hidden");
}
function renderAttendanceModalRows(){
  const box = document.getElementById("attendanceRows");
  if (!box) return;
  const rows = activePeriodExams.map(e => `<tr data-exam-key="${escapeHtml(sectionExamKey(e))}">
    <td>${escapeHtml(e.courseName)}</td><td>${escapeHtml(e.courseCode)}</td><td>${escapeHtml(getSectionTypeLabel(e.section))}</td>
    <td><input type="number" min="0" max="${escapeHtml(e.students)}" step="1" value="0" data-absence-input="1" data-max-students="${escapeHtml(e.students)}" /></td>
  </tr>`).join("");
  box.innerHTML = `<table class="attendance-table"><thead><tr><th>اسم المقرر</th><th>كود المقرر</th><th>الشعبة</th><th>عدد الغياب</th></tr></thead><tbody>${rows}</tbody></table>`;
  attendanceSubmitInProgress = false;
  const btn = document.getElementById("attendanceSubmitBtn");
  if (btn) btn.disabled = false;
}
async function submitAttendanceReport(){
  if (attendanceSubmitInProgress || attendanceSubmitted) return;
  const key = attendanceKeyForCurrentPeriod();
  if (key && localStorage.getItem(key) === "1") { attendanceSubmitted = true; document.getElementById("attendanceModal")?.classList.add("hidden"); return; }
  if (!isCloudEnabled() || !supportRequestsCollection()) return alert("لا يمكن إرسال الغياب بدون اتصال Firestore.");
  attendanceSubmitInProgress = true;
  const btn = document.getElementById("attendanceSubmitBtn");
  if (btn) btn.disabled = true;
  const inputs = [...document.querySelectorAll('#attendanceRows tr[data-exam-key]')];
  let total = 0;
  const batch = [];
  const absenceValues = new Map();
  let validationError = "";
  inputs.forEach(tr => {
    if (validationError) return;
    const examKey = tr.dataset.examKey;
    const e = activePeriodExams.find(x => sectionExamKey(x) === examKey);
    const n = Number(tr.querySelector('[data-absence-input]')?.value || 0) || 0;
    if (e) absenceValues.set(examKey, n);
    if (e && n > Number(e.students || 0)) {
      validationError = `لا يمكن أن يتجاوز عدد الغياب عدد الطلبة المسجلين بالشعبة (${toArabicDigits(e.students)} طالبًا).`;
      return;
    }
    if (e && n > 0) {
      total += n;
      const msg = `يوجد غياب عدد ${toArabicDigits(n)} طالب في مقرر (${e.courseName} - ${e.courseCode}) شعبة ${getSectionTypeLabel(e.section)}`;
      batch.push({
        hall: currentHall,
        type: "تنبيه غياب",
        kind: "absence",
        message: msg,
        absenceCount: n,
        examKey,
        courseName: e.courseName,
        courseCode: e.courseCode,
        section: e.section,
        sectionLabel: getSectionTypeLabel(e.section),
        createdAtMs: Date.now(),
        examEndMs: currentPeriod.end.getTime(),
        periodText: `${currentPeriod.startText} - ${currentPeriod.endText}`,
        status: "pending",
        acknowledged: false,
        acknowledgedAtMs: 0,
        displaySeenAck: false
      });
    }
  });
  if (validationError) {
    attendanceSubmitInProgress = false;
    if (btn) btn.disabled = false;
    return alert(validationError);
  }
  try {
    for (const req of batch) {
      const docId = `absence_${safeDocId(key)}_${safeDocId(req.examKey)}`;
      await supportRequestsCollection().doc(docId).set(req, { merge:false });
    }
    if (key) {
      localStorage.setItem(key, "1");
      localStorage.setItem(key + ".total", String(total));
      await attendanceReportsCollection()?.doc(safeDocId(key)).set({
        hall: currentHall,
        periodText: `${currentPeriod.startText} - ${currentPeriod.endText}`,
        totalAbsence: total,
        submittedAtMs: Date.now(),
        examEndMs: currentPeriod.end.getTime(),
        sessionId: currentSessionId,
        date: activePeriodExams[0]?.date || "",
        details: activePeriodExams.map(e => {
          const n = Number(absenceValues.get(sectionExamKey(e)) || 0) || 0;
          return {
            examKey: sectionExamKey(e),
            courseName: e.courseName,
            courseCode: e.courseCode,
            section: e.section,
            sectionLabel: getSectionTypeLabel(e.section),
            hall: e.hall,
            examDate: e.date,
            periodText: `${currentPeriod.startText} - ${currentPeriod.endText}`,
            students: Number(e.students || 0) || 0,
            absenceCount: n
          };
        })
      }, { merge:false });
    }
    attendanceSubmitted = true;
    document.getElementById("attendanceModal")?.classList.add("hidden");
    updateAbsenceSummaryCard(total);
    showAppToast(total > 0 ? "تم تسجيل الغياب بنجاح" : "تم تسجيل عدم وجود غياب", 3000);
  } catch (err) {
    console.error(err);
    attendanceSubmitInProgress = false;
    if (btn) btn.disabled = false;
    const msg = String(err && err.message || "");
    if (msg.startsWith("ABSENCE_OVER_LIMIT:")) {
      const parts = msg.split(":");
      return alert(`لا يمكن أن يتجاوز عدد الغياب عدد الطلبة المسجلين بالشعبة (${toArabicDigits(parts[4] || "0")} طالبًا).`);
    }
    alert("تعذر إرسال بيانات الغياب. تحقق من قواعد Firestore.");
  }
}
function initAttendanceModal(){
  document.getElementById("attendanceSubmitBtn")?.addEventListener("click", submitAttendanceReport);
}
function openEarlyFinishModal(){
  if (!currentHall || !currentPeriod || !activePeriodExams.length) return;
  const modal = document.getElementById("earlyFinishModal");
  const options = document.getElementById("earlyFinishOptions");
  const confirm = document.getElementById("earlyFinishConfirm");
  if (!modal || !options || !confirm) return;
  earlyFinishDraft = null;
  confirm.classList.add("hidden");
  options.classList.remove("hidden");
  options.innerHTML = activePeriodExams.map(e => `<button type="button" class="secondary-btn" data-finish-key="${escapeHtml(sectionExamKey(e))}">${escapeHtml(e.courseName)}<br><small>${escapeHtml(e.courseCode)} — ${escapeHtml(getSectionTypeLabel(e.section))}</small></button>`).join("");
  modal.classList.remove("hidden");
}
function closeEarlyFinishModal(){
  document.getElementById("earlyFinishModal")?.classList.add("hidden");
  earlyFinishDraft = null;
}
async function submitEarlyFinish(){
  if (!earlyFinishDraft || !currentHall || !currentPeriod) return;
  const e = earlyFinishDraft;
  const examKey = sectionExamKey(e);
  const finishKey = `finalExamTimer.earlyFinished.${examKey}`;
  const set = getFinishedSectionsSet();
  if (set.has(examKey) || localStorage.getItem(finishKey) === "1") {
    closeEarlyFinishModal();
    showAppToast("تم إنهاء هذه الشعبة مسبقًا.", 3000);
    return;
  }
  localStorage.setItem(finishKey, "1");
  set.add(examKey);
  saveFinishedSectionsSet(set);
  const msg = `انتهى اختبار مقرر (${e.courseName} - ${e.courseCode}) شعبة ${getSectionTypeLabel(e.section)} وتم خروج جميع الطلبة.`;
  const docId = `earlyFinish_${safeDocId(examKey)}`;
  try {
    if (supportRequestsCollection()) await supportRequestsCollection().doc(docId).set({
      hall: currentHall,
      type: "انتهاء اختبار",
      kind: "earlyFinish",
      message: msg,
      courseName: e.courseName,
      courseCode: e.courseCode,
      section: e.section,
      sectionLabel: getSectionTypeLabel(e.section),
      examKey,
      createdAtMs: Date.now(),
      examEndMs: currentPeriod.end.getTime(),
      periodText: `${currentPeriod.startText} - ${currentPeriod.endText}`,
      status:"pending", acknowledged:false, acknowledgedAtMs:0, displaySeenAck:false
    }, { merge:false });
  } catch(err){ console.error(err); }
  closeEarlyFinishModal();
  showAppToast("تم إنهاء الاختبار المحدد بنجاح", 3000);
  const remaining = activePeriodExams.filter(x => !set.has(sectionExamKey(x)));
  if (!remaining.length) goHome(false); else renderHall(currentHall);
}
function initEarlyFinishTools(){
  document.getElementById("earlyEndBtn")?.addEventListener("click", openEarlyFinishModal);
  document.getElementById("earlyFinishCancelBtn")?.addEventListener("click", closeEarlyFinishModal);
  document.getElementById("earlyFinishNoBtn")?.addEventListener("click", () => {
    earlyFinishDraft = null;
    document.getElementById("earlyFinishConfirm")?.classList.add("hidden");
    document.getElementById("earlyFinishOptions")?.classList.remove("hidden");
  });
  document.getElementById("earlyFinishYesBtn")?.addEventListener("click", submitEarlyFinish);
  document.getElementById("earlyFinishOptions")?.addEventListener("click", e => {
    const btn = e.target.closest("[data-finish-key]"); if (!btn) return;
    const ex = activePeriodExams.find(x => sectionExamKey(x) === btn.dataset.finishKey); if (!ex) return;
    earlyFinishDraft = ex;
    document.getElementById("earlyFinishOptions")?.classList.add("hidden");
    const txt = document.getElementById("earlyFinishConfirmText");
    if (txt) txt.textContent = `هل تريد إنهاء اختبار مقرر (${ex.courseName} - ${ex.courseCode}) شعبة ${getSectionTypeLabel(ex.section)}؟`;
    document.getElementById("earlyFinishConfirm")?.classList.remove("hidden");
  });
}

function hallLockKeyFor(hall, period){
  if (!hall || !period) return "";
  return safeDocId(`${hall}|${period.startText}-${period.endText}`);
}
function hallLockLabel(period){
  return period ? `${period.startText} - ${period.endText}` : "";
}
function hallFromLockDoc(row){
  if (row && row.hall) return String(row.hall);
  const raw = String((row && row.id) || "");
  if (!raw) return "";
  const parts = raw.split("_").filter(Boolean);
  return parts.length ? parts[0] : "";
}
function periodFromLockDoc(row){
  if (row && row.periodText) return String(row.periodText);
  const raw = String((row && row.id) || "");
  const m = raw.match(/_(\d{1,2})_(\d{2})_(\d{1,2})_(\d{2})/);
  return m ? `${m[1]}:${m[2]} - ${m[3]}:${m[4]}` : "";
}

function stopCurrentHallLockWatcher(){
  if (currentHallLockUnsubscribe) {
    try { currentHallLockUnsubscribe(); } catch {}
    currentHallLockUnsubscribe = null;
  }
  if (hallLockPollTimer) {
    clearInterval(hallLockPollTimer);
    hallLockPollTimer = null;
  }
}
async function checkCurrentHallLockStillOwned(lockId){
  if (!lockId || !hallLocksCollection()) return;
  if (suppressHallLockForceClose) return;
  if (!currentHallLockId || currentHallLockId !== lockId) return;
  try {
    const snap = await hallLocksCollection().doc(lockId).get();
    if (!currentHallLockId || currentHallLockId !== lockId) return;
    if (!snap.exists) return handleForcedHallRelease("deleted");
    const data = snap.data() || {};
    if (data.forceClose) return handleForcedHallRelease("released");
    if (data.sessionId && data.sessionId !== currentSessionId) return handleForcedHallRelease("taken");
  } catch (err) {
    console.warn("Hall lock polling failed", err);
  }
}
function startCurrentHallLockPolling(lockId){
  if (hallLockPollTimer) clearInterval(hallLockPollTimer);
  hallLockPollTimer = setInterval(() => checkCurrentHallLockStillOwned(lockId), 2000);
}
function showAutoHomeState(message, seconds = 5){
  disableWakeLock();
  clearInterval(timerInterval);
  currentHall = "";
  activePeriodExams = [];
  currentPeriod = null;
  try { localStorage.removeItem(STORE_KEYS.lastHall); } catch {}
  const setup = document.getElementById("setupPanel");
  const view = document.getElementById("examView");
  const empty = document.getElementById("emptyState");
  setup?.classList.add("hidden");
  view?.classList.add("hidden");
  try { const select = document.getElementById("hallSelect"); if (select) select.value = ""; } catch {}
  if (!empty) return;
  empty.classList.remove("hidden");
  let remaining = Math.max(1, Number(seconds) || 5);
  const render = () => {
    empty.innerHTML = `<h2>${escapeHtml(message)}</h2><p>سيتم الرجوع إلى الصفحة الرئيسية خلال ${toArabicDigits(remaining)} ثوانٍ...</p><div class="auto-home-countdown">${toArabicDigits(remaining)}</div>`;
  };
  render();
  const countdown = setInterval(() => {
    remaining -= 1;
    if (remaining <= 0) {
      clearInterval(countdown);
      try { localStorage.removeItem(STORE_KEYS.lastHall); } catch {}
      const select = document.getElementById("hallSelect");
      if (select) select.value = "";
      location.hash = "display";
      goHome(false);
      setTimeout(() => { const s = document.getElementById("hallSelect"); if (s) s.value = ""; }, 50);
      return;
    }
    render();
  }, 1000);
}

function handleForcedHallRelease(reason=""){
  if (hallLockHeartbeatTimer) { clearInterval(hallLockHeartbeatTimer); hallLockHeartbeatTimer = null; }
  stopCurrentHallLockWatcher();
  try { sessionStorage.removeItem("finalExamTimer.supportLoggedIn"); } catch {}
  try { document.querySelectorAll("#attendanceModal,#supportRequestModal,#earlyFinishModal,#ackModal").forEach(el => el.classList.add("hidden")); } catch {}
  currentHallLockId = "";
  currentHallLockKey = "";
  currentHallLockOpenedAt = 0;
  currentHall = "";
  activePeriodExams = [];
  currentPeriod = null;
  endHandled = false;
  halfHandled = false;
  startHandled = false;
  fifteenHandled = false;
  try { localStorage.removeItem(STORE_KEYS.lastHall); } catch {}
  try { const select = document.getElementById("hallSelect"); if (select) select.value = ""; } catch {}
  showAutoHomeState("تم تحرير هذه القاعة من قبل المسؤول.", 5);
}
function watchCurrentHallLock(lockId){
  stopCurrentHallLockWatcher();
  if (!lockId || !hallLocksCollection()) return;
  try {
    currentHallLockUnsubscribe = hallLocksCollection().doc(lockId).onSnapshot(snap => {
      if (suppressHallLockForceClose) return;
      if (!currentHallLockId || currentHallLockId !== lockId) return;
      if (!snap.exists) {
        handleForcedHallRelease("deleted");
        return;
      }
      const data = snap.data() || {};
      if (data.forceClose) {
        handleForcedHallRelease("released");
        return;
      }
      if (data.sessionId && data.sessionId !== currentSessionId) {
        handleForcedHallRelease("taken");
      }
    }, err => console.warn("Hall lock watcher failed", err));
    startCurrentHallLockPolling(lockId);
  } catch (err) {
    console.warn("Could not watch hall lock", err);
  }
}

async function releaseCurrentHallLock(){
  if (!currentHallLockId || !hallLocksCollection()) { currentHallLockId = ""; currentHallLockKey = ""; stopCurrentHallLockWatcher(); return; }
  const lockId = currentHallLockId;
  currentHallLockId = "";
  currentHallLockKey = "";
  currentHallLockOpenedAt = 0;
  if (hallLockHeartbeatTimer) { clearInterval(hallLockHeartbeatTimer); hallLockHeartbeatTimer = null; }
  suppressHallLockForceClose = true;
  stopCurrentHallLockWatcher();
  try {
    const ref = hallLocksCollection().doc(lockId);
    const snap = await ref.get();
    const data = snap.exists ? (snap.data() || {}) : {};
    if (!snap.exists || data.sessionId === currentSessionId) await ref.delete();
  } catch (err) { console.warn("Could not release hall lock", err); }
  finally { setTimeout(() => { suppressHallLockForceClose = false; }, 300); }
}
async function heartbeatHallLock(){
  if (!currentHallLockId || !hallLocksCollection()) return;
  try { await hallLocksCollection().doc(currentHallLockId).set({ updatedAtMs: Date.now() }, { merge:true }); }
  catch (err) { console.warn("Hall lock heartbeat failed", err); }
}
function startHallLockHeartbeat(){
  if (hallLockHeartbeatTimer) clearInterval(hallLockHeartbeatTimer);
  hallLockHeartbeatTimer = setInterval(heartbeatHallLock, 30000);
}
async function acquireHallLock(hall, period){
  if (!hall || !period || !hallLocksCollection()) return { ok:true };
  const id = hallLockKeyFor(hall, period);
  if (currentHallLockId === id) { heartbeatHallLock(); return { ok:true }; }
  if (currentHallLockId && currentHallLockId !== id) await releaseCurrentHallLock();
  try {
    const ref = hallLocksCollection().doc(id);
    const snap = await ref.get();
    const now = Date.now();
    if (snap.exists) {
      const data = snap.data() || {};
      const stale = now - Number(data.updatedAtMs || data.openedAtMs || 0) > 3 * 60 * 1000;
      const sameSession = data.sessionId === currentSessionId;
      const released = !!data.forceClose;
      if (!stale && !sameSession && !released) return { ok:false, data };
    }
    await ref.set({ hall, periodText: hallLockLabel(period), sessionId: currentSessionId, openedAtMs: now, updatedAtMs: now, forceClose:false, userAgent: navigator.userAgent || "" });
    currentHallLockId = id;
    currentHallLockKey = `${hall}|${hallLockLabel(period)}`;
    currentHallLockOpenedAt = now;
    startHallLockHeartbeat();
    watchCurrentHallLock(id);
    return { ok:true };
  } catch (err) {
    console.error(err);
    return { ok:true };
  }
}
function showHallLockedState(hall, lockData={}){
  currentHall = "";
  activePeriodExams = [];
  currentPeriod = null;
  try { localStorage.removeItem(STORE_KEYS.lastHall); } catch {}
  showAutoHomeState("القاعة مفتوحة على شاشة أخرى.", 5);
}
async function checkAttendanceAlreadySubmitted(){
  const key = attendanceKeyForCurrentPeriod();
  if (!key) return false;
  if (localStorage.getItem(key) === "1") return true;
  try {
    const ref = attendanceReportsCollection()?.doc(safeDocId(key));
    if (!ref) return false;
    const snap = await ref.get();
    if (snap.exists) {
      const data = snap.data() || {};
      localStorage.setItem(key, "1");
      localStorage.setItem(key + ".total", String(data.totalAbsence || 0));
      return true;
    }
  } catch (err) { console.warn("Attendance status check failed", err); }
  return false;
}
function renderHallLocksList(docs){
  const box = document.getElementById("hallLocksList");
  if (!box) return;
  const rows = docs.map(doc => {
      const data = { id: doc.id, ...(doc.data ? doc.data() : doc) };
      data.hall = hallFromLockDoc(data);
      data.periodText = periodFromLockDoc(data);
      return data;
    })
    .filter(r => r && r.hall && !r.forceClose)
    .sort((a,b)=>String(a.hall||"").localeCompare(String(b.hall||""),'ar',{numeric:true}));
  if (!rows.length) { box.innerHTML = '<p class="soft-note">لا توجد قاعات مفتوحة حاليًا.</p>'; return; }
  box.innerHTML = `<table class="admin-locks-table"><thead><tr><th>القاعة</th><th>الفترة</th><th>وقت الفتح</th><th>إجراء</th></tr></thead><tbody>${rows.map(r=>`<tr><td>${escapeHtml(r.hall||"")}</td><td>${escapeHtml(r.periodText||"")}</td><td>${r.openedAtMs ? escapeHtml(toArabicDigits(new Intl.DateTimeFormat("ar-OM-u-nu-latn-ca-gregory", {hour:"2-digit",minute:"2-digit"}).format(new Date(r.openedAtMs)))) : ""}</td><td><button class="danger-btn small-danger" data-release-lock="${escapeHtml(r.id)}" data-release-hall="${escapeHtml(r.hall||"")}" type="button">تحرير القاعة</button></td></tr>`).join("")}</tbody></table>`;
  box.querySelectorAll("[data-release-lock]").forEach(btn => btn.addEventListener("click", async () => {
    const ok = await showConfirmModal("هل تريد تحرير هذه القاعة والسماح بفتحها من جهاز آخر؟", "تحرير القاعة");
    if (!ok || !hallLocksCollection()) return;
    try {
      const ref = hallLocksCollection().doc(btn.dataset.releaseLock);
      const snap = await ref.get();
      const data = snap.exists ? (snap.data() || {}) : {};
      const hall = data.hall || btn.dataset.releaseHall || hallFromLockDoc({ id: btn.dataset.releaseLock });
      const stamp = Date.now();
      await ref.set({ hall, forceClose:true, releasedAtMs:stamp, releasedBy:adminUserEmail || PRIMARY_ADMIN_EMAIL }, { merge:true });
      await saveCloudSettings({
        lastForceClosedLockId: btn.dataset.releaseLock,
        lastForceClosedHall: hall || "",
        lastForceClosedAtMs: stamp,
        forceReleaseSerial: `${stamp}_${btn.dataset.releaseLock}`
      });
      setTimeout(() => ref.delete().catch(()=>{}), 7000);
      showAppToast("تم تحرير القاعة بنجاح.", 3000);
    }
    catch (err) { console.error(err); alert("تعذر تحرير القاعة."); }
  }));
}
function initHallLockAdmin(){
  const box = document.getElementById("hallLocksList");
  if (!box || !hallLocksCollection()) return;
  if (hallLocksUnsubscribe) { try { hallLocksUnsubscribe(); } catch {} hallLocksUnsubscribe = null; }
  hallLocksUnsubscribe = hallLocksCollection().onSnapshot(snap => renderHallLocksList(snap.docs), err => { console.error(err); box.innerHTML = '<p class="soft-note">تعذر تحميل القاعات المفتوحة.</p>'; });
  document.getElementById("releaseAllHallLocksBtn")?.addEventListener("click", async () => {
    const ok = await showConfirmModal("هل تريد تحرير جميع القاعات المفتوحة؟", "تحرير جميع القاعات");
    if (!ok || !hallLocksCollection()) return;
    try {
      const snap = await hallLocksCollection().get();
      const stamp = Date.now();
      await Promise.all(snap.docs.map(d=>d.ref.set({ forceClose:true, releasedAtMs:stamp, releasedBy:adminUserEmail || PRIMARY_ADMIN_EMAIL }, { merge:true })));
      await saveCloudSettings({ lastForceCloseAllAtMs: stamp, forceReleaseSerial: `all_${stamp}` });
      setTimeout(async () => {
        try {
          const fresh = await hallLocksCollection().get();
          await Promise.all(fresh.docs.map(d=>d.ref.delete()));
        } catch {}
      }, 9000);
      showAppToast("تم تحرير جميع القاعات بنجاح.", 3000);
    }
    catch (err) { console.error(err); alert("تعذر تحرير جميع القاعات."); }
  });
}

async function renderHall(hall){
  refreshAllExams();
  const nextExams = getExamsForHall(hall);
  const nextPeriod = chooseCurrentPeriod(nextExams);
  const setup = document.getElementById("setupPanel");
  const view = document.getElementById("examView");
  const empty = document.getElementById("emptyState");
  if (!nextExams.length || !nextPeriod) {
    setup?.classList.add("hidden");
    renderNoExamState();
    return;
  }
  const lock = await acquireHallLock(hall, nextPeriod);
  if (!lock.ok) { showHallLockedState(hall, lock.data || {}); return; }
  currentHall = hall;
  localStorage.setItem(STORE_KEYS.lastHall, hall);
  activePeriodExams = nextExams;
  currentPeriod = nextPeriod;
  setup.classList.add("hidden"); empty.classList.add("hidden"); view.classList.remove("hidden");
  document.body.classList.remove("display-running", "single-course", "multi-course", "many-courses");
  document.getElementById("hallName").textContent = hall;
  document.getElementById("totalStudents").textContent = toArabicDigits(activePeriodExams.reduce((s,e)=>s+e.students,0));
  document.getElementById("periodText").textContent = `من ${currentPeriod.startText} إلى ${currentPeriod.endText}`;
  const attendanceKey = attendanceKeyForCurrentPeriod();
  attendanceSubmitted = await checkAttendanceAlreadySubmitted();
  attendanceModalShown = attendanceSubmitted;
  updateAbsenceSummaryCard(attendanceSubmitted ? getStoredAbsenceTotal() : 0);
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
  fifteenMinuteHandled = nowForFlags >= new Date(currentPeriod.end.getTime() - 15 * 60 * 1000);
  endHandled = nowForFlags >= currentPeriod.end;
  document.getElementById("homeBtn")?.classList.remove("hidden");
  document.getElementById("timer")?.classList.remove("timer-ended", "timer-waiting");
  document.getElementById("earlyEndBtn")?.classList.add("hidden");
  updateSupportCallButtonVisibility();
  updateEarlyEndButtonVisibility();
  startTimer();
  updateSupportCallButtonVisibility();
  watchHallSupportAcks();
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
  adminAuthorized = false;
  if (adminsUnsubscribe) { try { adminsUnsubscribe(); } catch {} adminsUnsubscribe = null; }
  if (cloudAuth && cloudAuth.currentUser) { cloudAuth.signOut().catch(()=>{}); }
  if (cloudAuthReady && cloudAuth && cloudAuth.currentUser) { cloudAuth.signOut().catch(()=>{}); }
  const login = document.getElementById("loginPanel");
  const settings = document.getElementById("settingsPanel");
  if (login) login.classList.remove("hidden");
  if (settings) settings.classList.add("hidden");
  setAdminSupportButtonVisible(false);
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
  updateSupportCallButtonVisibility();
  updateEarlyEndButtonVisibility();

  if (endHandled) {
    disableWakeLock();
    timerEl.textContent = "انتهى الوقت";
    timerEl.classList.add("timer-ended");
    document.body.classList.remove("display-running", "single-course", "multi-course", "many-courses");
    document.getElementById("homeBtn")?.classList.remove("hidden");
    return;
  }

  if (now < currentPeriod.start) {
    disableWakeLock();
    document.body.classList.remove("display-running", "single-course", "multi-course", "many-courses");
    timerEl.textContent = "لم يبدأ الوقت";
    timerEl.classList.add("timer-waiting");
    return;
  }

  if (!startHandled) {
    startHandled = true;
    playConfiguredBeep("start");
  }
  document.body.classList.add("display-running");
  enableWakeLock();
  timerEl.classList.remove("timer-waiting");
  const rawRemaining = currentPeriod.end - now;
  const remaining = Math.max(0, rawRemaining);
  const elapsed = now - currentPeriod.start;
  if (elapsed >= getAttendanceTimeMinutes() * 60000 && rawRemaining > 0) openAttendanceModalIfNeeded();

  if (!halfHandled && elapsed >= currentPeriod.durationMs / 2 && rawRemaining > 0) {
    halfHandled = true;
    playConfiguredBeep("half");
  }

  if (!fifteenMinuteHandled && rawRemaining <= 15 * 60 * 1000 && rawRemaining > 0) {
    fifteenMinuteHandled = true;
    playConfiguredBeep("fifteen");
  }

  if (!endHandled && rawRemaining <= 0) {
    endHandled = true;
    disableWakeLock();
    timerEl.textContent = "انتهى الوقت";
    timerEl.classList.add("timer-ended");
    playConfiguredBeep("end");
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
  releaseCurrentHallLock();
  disableWakeLock();
  clearInterval(timerInterval);
  currentHall = "";
  stopHallSupportAcks();
  activePeriodExams = [];
  currentPeriod = null;
  endHandled = false;
  halfHandled = false;
  fifteenMinuteHandled = false;
  startHandled = false;
  document.body.classList.remove("display-running", "single-course", "multi-course", "many-courses");
  document.getElementById("examView")?.classList.add("hidden");
  document.getElementById("emptyState")?.classList.add("hidden");
  document.getElementById("setupPanel")?.classList.remove("hidden");
  document.getElementById("timer")?.classList.remove("timer-ended", "timer-waiting");
  document.getElementById("earlyEndBtn")?.classList.add("hidden");
  document.getElementById("absenceSummaryCard")?.classList.add("hidden");
  const select = document.getElementById("hallSelect");
  if (select) select.value = "";
  populateHalls(restoreLastHall);
}
function populateHalls(restoreLastHall = true){
  refreshAllExams();
  const select = document.getElementById("hallSelect"); if (!select) return;
  const halls = getAvailableHalls();
  const setup = document.getElementById("setupPanel");
  const empty = document.getElementById("emptyState");
  const view = document.getElementById("examView");
  if (!halls.length) {
    renderNoExamState();
    return;
  }
  empty?.classList.add("hidden");
  view?.classList.add("hidden");
  setup?.classList.remove("hidden");
  const previous = restoreLastHall ? (select.value || localStorage.getItem(STORE_KEYS.lastHall) || "") : "";
  select.innerHTML = `<option value="">اختر القاعة</option>` + halls.map(h => `<option value="${escapeHtml(h)}">${escapeHtml(h)}</option>`).join("");
  if (previous && halls.includes(previous)) { select.value = previous; renderHall(previous); }
  const note = document.getElementById("setupNote");
  if (note) note.textContent = "تظهر القاعات التي لديها اختبار حالي أو يبدأ خلال 15 دقيقة فقط.";
}
function initDisplay(){
  updateTopDate();
  updateCopyright();
  bindFullscreenButton();
  initSupportRequestModal();
  initAttendanceModal();
  initEarlyFinishTools();
  setTitles();
  applyTimerPositionSetting();
  refreshAllExams();
  const season = getDisplayTerm();
  if (!season.active) {
    renderNoExamState();
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


function getTimerPosition(){
  return String(localStorage.getItem(STORE_KEYS.timerPosition) || (cloudSettingsCache && cloudSettingsCache.timerPosition) || "bottom") === "top" ? "top" : "bottom";
}
function applyTimerPositionSetting(){
  const pos = getTimerPosition();
  const examView = document.getElementById("examView");
  if (examView) {
    examView.classList.toggle("timer-position-top", pos === "top");
    examView.classList.toggle("timer-position-bottom", pos !== "top");
  }
  const topRadio = document.getElementById("timerPositionTop");
  const bottomRadio = document.getElementById("timerPositionBottom");
  if (topRadio) topRadio.checked = pos === "top";
  if (bottomRadio) bottomRadio.checked = pos !== "top";
}

function initTermSettings(){
  const semesterSelect = document.getElementById("semesterSelect");
  const academicYearInput = document.getElementById("academicYearInput");
  const saveBtn = document.getElementById("saveTermBtn");
  const attendanceTimeInput = document.getElementById("attendanceTimeInput");
  const beepStartDurationInput = document.getElementById("beepStartDurationInput");
  const beepHalfDurationInput = document.getElementById("beepHalfDurationInput");
  const beepFifteenDurationInput = document.getElementById("beepFifteenDurationInput");
  const beepEndDurationInput = document.getElementById("beepEndDurationInput");
  const beepStartEnabledInput = document.getElementById("beepStartEnabledInput");
  const beepHalfEnabledInput = document.getElementById("beepHalfEnabledInput");
  const beepFifteenEnabledInput = document.getElementById("beepFifteenEnabledInput");
  const beepEndEnabledInput = document.getElementById("beepEndEnabledInput");
  const saveAlertsBtn = document.getElementById("saveAlertsBtn");
  const timerPositionTop = document.getElementById("timerPositionTop");
  const timerPositionBottom = document.getElementById("timerPositionBottom");
  const saveTimerPositionBtn = document.getElementById("saveTimerPositionBtn");
  const saveAbsenceSettingsBtn = document.getElementById("saveAbsenceSettingsBtn");
  const supportCurrentCodeInput = document.getElementById("supportCurrentCodeInput");
  const supportNewCodeInput = document.getElementById("supportNewCodeInput");
  const supportConfirmCodeInput = document.getElementById("supportConfirmCodeInput");
  const saveSupportCodeBtn = document.getElementById("saveSupportCodeBtn");
  if (!semesterSelect || !academicYearInput || !saveBtn) return;
  const fallback = getExamSeason();
  const fallbackSemester = fallback.active ? String(fallback.semester).split(" ")[0] : "ربيع";
  const fallbackAcademicYear = fallback.active ? fallback.academicYear : `${new Date().getFullYear()} - ${new Date().getFullYear()+1}`;
  semesterSelect.value = localStorage.getItem(STORE_KEYS.semester) || fallbackSemester;
  academicYearInput.value = localStorage.getItem(STORE_KEYS.academicYear) || fallbackAcademicYear;
  if (attendanceTimeInput) attendanceTimeInput.value = localStorage.getItem(STORE_KEYS.attendanceTime) || (cloudSettingsCache && cloudSettingsCache.attendanceTime) || "30";
  if (beepStartDurationInput) beepStartDurationInput.value = localStorage.getItem(STORE_KEYS.beepStartDuration) || (cloudSettingsCache && cloudSettingsCache.beepStartDuration) || "3";
  if (beepHalfDurationInput) beepHalfDurationInput.value = localStorage.getItem(STORE_KEYS.beepHalfDuration) || (cloudSettingsCache && cloudSettingsCache.beepHalfDuration) || "3";
  if (beepFifteenDurationInput) beepFifteenDurationInput.value = localStorage.getItem(STORE_KEYS.beepFifteenDuration) || (cloudSettingsCache && cloudSettingsCache.beepFifteenDuration) || "1";
  if (beepEndDurationInput) beepEndDurationInput.value = localStorage.getItem(STORE_KEYS.beepEndDuration) || (cloudSettingsCache && cloudSettingsCache.beepEndDuration) || "10";
  if (beepStartEnabledInput) beepStartEnabledInput.checked = isBeepEnabled("start");
  if (beepHalfEnabledInput) beepHalfEnabledInput.checked = isBeepEnabled("half");
  if (beepFifteenEnabledInput) beepFifteenEnabledInput.checked = isBeepEnabled("fifteen");
  if (beepEndEnabledInput) beepEndEnabledInput.checked = isBeepEnabled("end");
  [supportCurrentCodeInput, supportNewCodeInput, supportConfirmCodeInput].forEach(el => { if (el) el.value = ""; });
  applyTimerPositionSetting();

  saveBtn.addEventListener("click", () => {
    const sem = semesterSelect.value;
    const ay = academicYearInput.value.trim();
    if (!sem || !ay) return alert("يرجى اختيار الفصل الدراسي وإدخال العام الأكاديمي.");
    if (!requireCloudForSharedSave()) return;
    localStorage.setItem(STORE_KEYS.semester, sem);
    localStorage.setItem(STORE_KEYS.academicYear, ay);
    saveCloudSettings({ semester: sem, academicYear: ay });
    logAdminOperation("حفظ إعدادات النظام", `${sem} - ${ay}`);
    setTitles();
    alert("تم حفظ إعدادات النظام.");
  });

  document.getElementById("clearExamDataBtn")?.addEventListener("click", async () => {
    if (!requireCloudForSharedSave()) return;
    if (!confirm("سيتم تفريغ قاعدة بيانات الامتحانات الحالية بالكامل. هل أنت متأكد؟")) return;
    if (!confirm("تأكيد نهائي: لا يمكن التراجع عن تفريغ قاعدة البيانات إلا بإعادة رفع ملف الامتحانات.")) return;
    const stamp = Date.now();
    clearLocalExamRelatedStorage();
    localStorage.setItem(STORE_KEYS.exams, JSON.stringify([]));
    localStorage.setItem(STORE_KEYS.examsMirror, JSON.stringify([]));
    localStorage.setItem("finalExamTimer.exams.updatedAt", String(stamp));
    localStorage.setItem("examTimerData.updatedAt", String(stamp));
    try {
      if (cloudReady && firestoreDoc(FIRESTORE_DOCS.exams)) {
        await firestoreDoc(FIRESTORE_DOCS.exams).set({ rows: [], rowsJson: "[]", updatedAt: stamp, fileName: "", clearedAt: stamp }, { merge: false });
      }
      if (cloudReady && firestoreDoc(FIRESTORE_DOCS.settings)) {
        const del = window.firebase && window.firebase.firestore ? window.firebase.firestore.FieldValue.delete() : null;
        await firestoreDoc(FIRESTORE_DOCS.settings).set(del ? { updatedAt: stamp, fileName: "", rows: del, rowsJson: del, examsData: del, examsJson: del } : { updatedAt: stamp, fileName: "" }, { merge: true });
      }
      if (cloudReady) {
        await Promise.all([
          deleteCollectionDocs(supportRequestsCollection()),
          deleteCollectionDocs(attendanceReportsCollection()),
          deleteCollectionDocs(hallLocksCollection()),
          deleteCollectionDocs(operationLogsCollection())
        ]);
      }
    } catch (err) { console.error(err); alert("تم التفريغ محليًا، لكن تعذر تفريغ بعض بيانات Firestore. تحقق من القواعد."); }
    try { localStorage.removeItem(STORE_KEYS.operationLog); } catch {}
    supportAbsenceRequestsCache = [];
    supportRequestsCache = [];
    suppressCloudSave = true;
    applyCloudRows([], stamp);
    suppressCloudSave = false;
    refreshAllExams();
    populateSettingsFilterOptions();
    populateEditDates();
    updateStats("تم تفريغ بيانات الامتحانات الحالية.");
    logAdminOperation("تفريغ بيانات الامتحانات الحالية", "تم حذف الامتحانات والإشعارات والقاعات المفتوحة والبيانات المرتبطة");
    alert("تم تفريغ بيانات الامتحانات الحالية وكل البيانات المرتبطة بها بنجاح.");
  });

  saveTimerPositionBtn?.addEventListener("click", () => {
    const timerPosition = timerPositionTop?.checked ? "top" : "bottom";
    if (!requireCloudForSharedSave()) return;
    localStorage.setItem(STORE_KEYS.timerPosition, timerPosition);
    saveCloudSettings({ timerPosition });
    logAdminOperation("حفظ موضع المؤقت", timerPosition === "top" ? "أعلى" : "أسفل");
    applyTimerPositionSetting();
    alert("تم حفظ موضع المؤقت.");
  });

  saveAlertsBtn?.addEventListener("click", () => {
    const beepStartDuration = beepStartDurationInput ? beepStartDurationInput.value.trim() : "3";
    const beepHalfDuration = beepHalfDurationInput ? beepHalfDurationInput.value.trim() : "3";
    const beepFifteenDuration = beepFifteenDurationInput ? beepFifteenDurationInput.value.trim() : "1";
    const beepEndDuration = beepEndDurationInput ? beepEndDurationInput.value.trim() : "10";
    if (!beepStartDuration || Number(beepStartDuration) <= 0 || !beepHalfDuration || Number(beepHalfDuration) <= 0 || !beepFifteenDuration || Number(beepFifteenDuration) <= 0 || !beepEndDuration || Number(beepEndDuration) <= 0) return alert("يرجى إدخال مدد التنبيه الصوتي بالثواني.");
    if (!requireCloudForSharedSave()) return;
    const beepStartEnabled = !!beepStartEnabledInput?.checked;
    const beepHalfEnabled = !!beepHalfEnabledInput?.checked;
    const beepFifteenEnabled = !!beepFifteenEnabledInput?.checked;
    const beepEndEnabled = !!beepEndEnabledInput?.checked;
    localStorage.setItem(STORE_KEYS.beepStartDuration, beepStartDuration);
    localStorage.setItem(STORE_KEYS.beepHalfDuration, beepHalfDuration);
    localStorage.setItem(STORE_KEYS.beepFifteenDuration, beepFifteenDuration);
    localStorage.setItem(STORE_KEYS.beepEndDuration, beepEndDuration);
    localStorage.setItem(STORE_KEYS.beepStartEnabled, String(beepStartEnabled));
    localStorage.setItem(STORE_KEYS.beepHalfEnabled, String(beepHalfEnabled));
    localStorage.setItem(STORE_KEYS.beepFifteenEnabled, String(beepFifteenEnabled));
    localStorage.setItem(STORE_KEYS.beepEndEnabled, String(beepEndEnabled));
    saveCloudSettings({ beepStartDuration, beepHalfDuration, beepFifteenDuration, beepEndDuration, beepStartEnabled, beepHalfEnabled, beepFifteenEnabled, beepEndEnabled });
    logAdminOperation("حفظ إعدادات التنبيهات الصوتية");
    alert("تم حفظ إعدادات التنبيهات الصوتية.");
  });

  saveAbsenceSettingsBtn?.addEventListener("click", () => {
    const attendanceTime = attendanceTimeInput ? attendanceTimeInput.value.trim() : "30";
    if (!attendanceTime || Number(attendanceTime) <= 0) return alert("يرجى إدخال وقت تسجيل الغياب بالدقائق.");
    if (!requireCloudForSharedSave()) return;
    localStorage.setItem(STORE_KEYS.attendanceTime, attendanceTime);
    saveCloudSettings({ attendanceTime });
    logAdminOperation("حفظ إعدادات الغياب", `وقت التسجيل: ${attendanceTime} دقيقة`);
    alert("تم حفظ إعدادات الغياب.");
  });

  saveSupportCodeBtn?.addEventListener("click", () => {
    const currentSupportCode = supportCurrentCodeInput ? supportCurrentCodeInput.value.trim() : "";
    const newSupportCode = supportNewCodeInput ? supportNewCodeInput.value.trim() : "";
    const confirmSupportCode = supportConfirmCodeInput ? supportConfirmCodeInput.value.trim() : "";
    if (!requireCloudForSharedSave()) return;
    if (currentSupportCode !== getSupportCode()) return alert("رمز دخول لجنة الدعم الحالي غير صحيح.");
    if (!newSupportCode || newSupportCode.length < 3) return alert("يرجى إدخال رمز جديد من 3 خانات على الأقل.");
    if (newSupportCode !== confirmSupportCode) return alert("الرمز الجديد وتأكيده غير متطابقين.");
    localStorage.setItem(STORE_KEYS.supportCode, newSupportCode);
    saveCloudSettings({ supportCode: newSupportCode });
    [supportCurrentCodeInput, supportNewCodeInput, supportConfirmCodeInput].forEach(el => { if (el) el.value = ""; });
  applyTimerPositionSetting();
    logAdminOperation("تغيير رمز لجنة الدعم");
    alert("تم تغيير رمز دخول لجنة الدعم بنجاح.");
  });
}



function getAllNormalizedExams(){
  return getStoredExams().map(normalizeExam).filter(e => e.hall && e.date && e.period);
}
function getExamWeekOptions(){
  const exams = getAllNormalizedExams().sort((a,b)=>getExamStart(a)-getExamStart(b));
  if (!exams.length) return [];
  const first = getExamStart(exams[0]);
  const start = new Date(first);
  const day = start.getDay(); // 0 Sun, 6 Sat
  const offsetToSat = day === 6 ? 0 : (day + 1);
  start.setDate(start.getDate() - offsetToSat);
  start.setHours(0,0,0,0);
  const last = getExamStart(exams[exams.length-1]);
  const weeks = [];
  let cursor = new Date(start);
  let idx = 1;
  while (cursor <= last) {
    const end = new Date(cursor);
    end.setDate(cursor.getDate()+6);
    end.setHours(23,59,59,999);
    weeks.push({ value:String(idx), label:`الأسبوع ${toArabicDigits(idx)} (${formatShortDateTime(cursor).date} - ${formatShortDateTime(end).date})`, start:new Date(cursor), end });
    cursor.setDate(cursor.getDate()+7);
    idx++;
  }
  return weeks;
}
function fillSelectOptions(select, items, allLabel){
  if (!select) return;
  const current = select.value;
  select.innerHTML = (allLabel ? `<option value="">${allLabel}</option>` : "") + items.map(i => `<option value="${escapeHtml(i.value)}">${escapeHtml(i.label)}</option>`).join("");
  if ([...select.options].some(o => o.value === current)) select.value = current;
}
function populateSettingsFilterOptions(){
  const exams = getAllNormalizedExams();
  const dates = unique(exams.map(e=>e.date)).sort().map(d => ({ value:d, label:toArabicDigits(d) }));
  const periods = unique(exams.map(e=>periodKeyForExam(e))).sort().map(p => ({ value:normalizePeriodFilterText(p), label:toArabicDigits(p) }));
  const weeks = getExamWeekOptions();
  ["adminStatsDaySelect","absenceStatsDaySelect"].forEach(id => fillSelectOptions(document.getElementById(id), dates, "اختر اليوم"));
  ["adminStatsPeriodSelect","absenceStatsPeriodSelect"].forEach(id => fillSelectOptions(document.getElementById(id), periods, "كل الفترات"));
  ["adminStatsWeekSelect","absenceStatsWeekSelect"].forEach(id => fillSelectOptions(document.getElementById(id), weeks, "اختر الأسبوع"));
}
function filterRequestsByAdminScope(reqs, scopePrefix){
  const scope = document.getElementById(scopePrefix+'ScopeSelect')?.value || 'all';
  const day = document.getElementById(scopePrefix+'DaySelect')?.value || "";
  const week = document.getElementById(scopePrefix+'WeekSelect')?.value || "";
  const period = document.getElementById(scopePrefix+'PeriodSelect')?.value || "";
  const weeks = getExamWeekOptions();
  return (reqs || []).filter(r => {
    const dateSource = r.examDate ? combineDateTime(r.examDate, 0) : new Date(Number(r.createdAtMs || r.examEndMs || Date.now()));
    if (scope === "day" && day && normalizeDate(`${dateSource.getFullYear()}-${pad(dateSource.getMonth()+1)}-${pad(dateSource.getDate())}`) !== day) return false;
    if (scope === "week" && week) {
      const w = weeks.find(x => x.value === week);
      if (w && !(dateSource >= w.start && dateSource <= w.end)) return false;
    }
    if (period && !periodMatchesFilter(r, period)) return false;
    return true;
  });
}
function filterExamsByAdminScope(exams, scopePrefix){
  const scope = document.getElementById(scopePrefix+'ScopeSelect')?.value || 'all';
  const day = document.getElementById(scopePrefix+'DaySelect')?.value || "";
  const week = document.getElementById(scopePrefix+'WeekSelect')?.value || "";
  const period = document.getElementById(scopePrefix+'PeriodSelect')?.value || "";
  const weeks = getExamWeekOptions();
  return (exams || []).filter(e => {
    const dateSource = combineDateTime(e.date, e.period.startMinutes);
    if (scope === "day" && day && e.date !== day) return false;
    if (scope === "week" && week) {
      const w = weeks.find(x => x.value === week);
      if (w && !(dateSource >= w.start && dateSource <= w.end)) return false;
    }
    if (period && normalizePeriodFilterText(periodKeyForExam(e)) !== normalizePeriodFilterText(period)) return false;
    return true;
  });
}

async function getAllAbsenceRequestsForAdmin(){
  if (supportRequestsCollection()) {
    try {
      const snap = await supportRequestsCollection().where("kind","==","absence").get();
      const rows = [];
      snap.forEach(doc => rows.push({ id:doc.id, ...(doc.data() || {}) }));
      supportAbsenceRequestsCache = rows;
      return rows;
    } catch (err) {
      console.warn("Could not load absence requests", err);
    }
  }
  return supportAbsenceRequestsCache || [];
}

function initSettingsSidebar(){
  const buttons = [...document.querySelectorAll('[data-settings-section-target]')];
  const sections = [...document.querySelectorAll('[data-settings-section]')];
  if (!buttons.length || !sections.length) return;
  populateSettingsFilterOptions();
  function showSection(name){
    if (!sections.some(s => s.dataset.settingsSection === name)) name = 'exam-file';
    buttons.forEach(b => b.classList.toggle('active', b.dataset.settingsSectionTarget === name));
    sections.forEach(s => s.classList.toggle('active', s.dataset.settingsSection === name));
    localStorage.setItem('finalExamTimer.settings.activeSection', name);
    if (name === 'attendance') { populateSettingsFilterOptions(); updateAbsenceStatsScopeControls(); resetAbsenceStatsView(); }
    if (name === 'statistics') { populateSettingsFilterOptions(); updateStats(); updateStatsScopeControls(); }
    if (name === 'archive-log') renderOperationLog();
  }
  buttons.forEach(btn => btn.addEventListener('click', () => showSection(btn.dataset.settingsSectionTarget)));
  const storedSettingsSection = localStorage.getItem('finalExamTimer.settings.activeSection');
  showSection(storedSettingsSection || buttons.find(b=>b.classList.contains('active'))?.dataset.settingsSectionTarget || 'exam-file');
  ['absenceStatsScopeSelect','absenceStatsDaySelect','absenceStatsWeekSelect','absenceStatsPeriodSelect'].forEach(id => document.getElementById(id)?.addEventListener('change', () => { resetAbsenceStatsView(); }));
  ['adminStatsScopeSelect','adminStatsDaySelect','adminStatsWeekSelect','adminStatsPeriodSelect'].forEach(id => document.getElementById(id)?.addEventListener('change', () => { window.__adminStatsRequested = false; updateStatsScopeControls(); updateStats(); }));
  document.getElementById('showAbsenceStatsBtn')?.addEventListener('click', () => { window.__absenceStatsRequested = true; updateAdminAbsenceStats(); });
  document.getElementById('showAdminStatsBtn')?.addEventListener('click', () => { window.__adminStatsRequested = true; updateStatsScopeControls(); updateStats(); });
  document.getElementById("studentCountsPdfFile")?.addEventListener("change", prepareStudentCountsFile);
  document.getElementById("analyzeStudentCountsBtn")?.addEventListener("click", analyzeStudentCountsFile);
  document.getElementById("applySelectedStudentCountsBtn")?.addEventListener("click", applySelectedStudentCountUpdates);
  document.getElementById("cancelStudentCountsBtn")?.addEventListener("click", async () => {
    const ok = await showConfirmModal("هل تريد إلغاء العملية؟ سيتم مسح ملف القوائم ونتائج التحليل الحالية.", "إلغاء تحديث أعداد الطلبة", { yesText:"نعم، إلغاء", noText:"العودة" });
    if (!ok) return;
    resetStudentCountsUpdateSection();
  });
  document.getElementById("selectAllStudentDiffsBtn")?.addEventListener("click", () => document.querySelectorAll('[data-student-diff-index]:not(:disabled)').forEach(el => el.checked = true));
  document.getElementById("clearAllStudentDiffsBtn")?.addEventListener("click", () => document.querySelectorAll('[data-student-diff-index]:not(:disabled)').forEach(el => el.checked = false));
  renderOperationLog();

}

function updateAbsenceStatsScopeControls(){
  const scope = document.getElementById('absenceStatsScopeSelect')?.value || 'all';
  document.getElementById('absenceStatsDayWrap')?.classList.toggle('hidden', scope !== 'day');
  document.getElementById('absenceStatsWeekWrap')?.classList.toggle('hidden', scope !== 'week');
  document.getElementById('absenceStatsPeriodWrap')?.classList.remove('hidden');
}
function resetAbsenceStatsView(){
  window.__absenceStatsRequested = false;
  updateAbsenceStatsScopeControls();
  const summary = document.getElementById('absenceStatsSummary');
  const details = document.getElementById('absenceStatsDetails');
  if (summary) summary.innerHTML = '';
  if (details) details.innerHTML = '<div class="placeholder-panel">اختر نطاق الإحصائية والبيانات المطلوبة ثم اضغط عرض الإحصائية.</div>';
}
function updateStatsScopeControls(){
  const scope = document.getElementById('adminStatsScopeSelect')?.value || '';
  document.getElementById('adminStatsDayWrap')?.classList.toggle('hidden', scope !== 'day');
  document.getElementById('adminStatsWeekWrap')?.classList.toggle('hidden', scope !== 'week');
  document.getElementById('adminStatsPeriodWrap')?.classList.remove('hidden');
}

async function updateAdminAbsenceStats(){
  updateAbsenceStatsScopeControls();
  if (!window.__absenceStatsRequested) return;
  const scope = document.getElementById('absenceStatsScopeSelect')?.value || 'all';
  const dayVal = document.getElementById('absenceStatsDaySelect')?.value || '';
  const weekVal = document.getElementById('absenceStatsWeekSelect')?.value || '';
  const detailsBox = document.getElementById('absenceStatsDetails');
  const summaryBox = document.getElementById('absenceStatsSummary');
  if ((scope === 'day' && !dayVal) || (scope === 'week' && !weekVal)) {
    if (summaryBox) summaryBox.innerHTML = '';
    if (detailsBox) detailsBox.innerHTML = '<div class="placeholder-panel">يرجى اختيار البيانات المطلوبة لعرض الإحصائية.</div>';
    return;
  }

  populateSettingsFilterOptions();
  const allReqs = await getAllAbsenceRequestsForAdmin();
  const reqs = filterRequestsByAdminScope((allReqs || []).filter(r => r.kind === 'absence'), 'absenceStats')
    .filter(r => Number(r.absenceCount || 0) > 0);
  const scopedExams = filterExamsByAdminScope(getAllNormalizedExams(), 'absenceStats');
  const totalAbs = reqs.reduce((s,r)=>s+(Number(r.absenceCount)||0),0);
  const totalStudents = sumStudents(scopedExams);
  const rate = totalStudents ? ((totalAbs/totalStudents)*100).toFixed(2) : '0.00';

  if (summaryBox) {
    summaryBox.innerHTML = `<div><strong>${toArabicDigits(totalAbs)}</strong><span>إجمالي الغياب</span></div><div><strong>${toArabicDigits(totalStudents)}</strong><span>إجمالي الطلبة</span></div><div><strong>${toArabicDigits(rate)}%</strong><span>نسبة الغياب</span></div>`;
  }

  if (detailsBox) {
    const rows = reqs.map(r => {
      const ex = findExamForAbsenceRequest(r);
      const registeredAt = r.createdAtMs ? new Intl.DateTimeFormat("ar-OM-u-nu-latn-ca-gregory", {dateStyle:"short", timeStyle:"short"}).format(new Date(r.createdAtMs)) : "";
      const examDate = r.examDate || (ex && ex.date) || "";
      const periodText = r.periodText || (ex && periodKeyForExam(ex)) || "";
      const hall = r.hall || (ex && ex.hall) || "";
      const courseName = r.courseName || (ex && ex.courseName) || "";
      const courseCode = r.courseCode || (ex && ex.courseCode) || "";
      const section = r.sectionLabel || getSectionTypeLabel(r.section || (ex && ex.section) || "");
      return `<tr><td>${escapeHtml(courseName)}</td><td>${escapeHtml(courseCode)}</td><td>${escapeHtml(section)}</td><td>${escapeHtml(toArabicDigits(examDate))}</td><td>${escapeHtml(toArabicDigits(periodText))}</td><td>${escapeHtml(hall)}</td><td>${toArabicDigits(Number(r.absenceCount)||0)}</td><td>${escapeHtml(toArabicDigits(registeredAt))}</td></tr>`;
    }).join('');
    detailsBox.innerHTML = `<table class="support-hall-table absence-report-table"><thead><tr><th>اسم المقرر</th><th>الكود</th><th>الشعبة</th><th>تاريخ الامتحان</th><th>الفترة الامتحانية</th><th>القاعة</th><th>عدد الغياب</th><th>توقيت التسجيل</th></tr></thead><tbody>${rows || '<tr><td colspan="8">لا توجد بيانات غياب ضمن النطاق المحدد</td></tr>'}</tbody></table>`;
  }
}

async function printAbsenceStatsReport(){
  await updateAdminAbsenceStats();
  const scope = document.getElementById('absenceStatsScopeSelect')?.value || 'all';
  const titlePart = scope === 'day' ? `ليوم ${document.getElementById('absenceStatsDaySelect')?.selectedOptions?.[0]?.textContent || ''}` : scope === 'week' ? `${document.getElementById('absenceStatsWeekSelect')?.selectedOptions?.[0]?.textContent || ''}` : 'شامل';
  const summaryHtml = document.getElementById('absenceStatsSummary')?.innerHTML || '';
  const tableHtml = document.getElementById('absenceStatsDetails')?.innerHTML || '<p>لا توجد بيانات.</p>';
  const w = window.open('', '_blank');
  if (!w) { window.print(); return; }
  w.document.open();
  w.document.write(`<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>إحصائية الغياب</title><style>
    @page{size:A4;margin:14mm 12mm;} body{font-family:Arial,'Tahoma',sans-serif;color:#0B2E6B;background:#fff;margin:0;}
    .report-header{display:grid;grid-template-columns:130px 1fr;align-items:center;border-bottom:2px solid #E7771A;padding-bottom:10px;margin-bottom:14px;break-inside:avoid;}
    .report-header img{width:120px;height:auto;justify-self:start}.report-title{text-align:center}.report-title h1{margin:0;font-size:22px}.report-title h2{margin:6px 0 0;font-size:16px;color:#333}
    .summary{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin:10px 0 14px;break-inside:avoid}.summary>div{border:1px solid #DDE6F2;border-radius:10px;padding:8px;text-align:center;background:#F7FAFE}.summary strong{display:block;font-size:18px}.summary span{font-size:12px;color:#526070}
    table{width:100%;border-collapse:collapse;font-size:11px;page-break-inside:auto}thead{display:table-header-group}tr{page-break-inside:avoid;page-break-after:auto}th{background:#FFF3E7;color:#0B2E6B;border:1px solid #D9E2EF;padding:6px}td{border:1px solid #D9E2EF;padding:5px;color:#111;line-height:1.35}.support-hall-table-wrap{overflow:visible!important;border:0!important}.soft-note{display:none}
  </style></head><body><div class="report-header"><img src="assets/logo.png"><div class="report-title"><h1>إحصائية الغياب</h1><h2>${titlePart}</h2></div></div><div class="summary">${summaryHtml}</div>${tableHtml}</body></html>`);
  w.document.close();
  setTimeout(()=>{ w.focus(); w.print(); }, 500);
}

let pendingStudentCountDiffs = [];
let pendingStudentCountWorkbookRows = [];
let pendingStudentCountHeaders = [];
let pendingStudentCountFileName = "";
function normalizeCourseCodeForKey(code){
  const raw = clean(code).toUpperCase();
  const match = raw.match(/[A-Z]{2,8}\s*\d{3,5}/);
  return (match ? match[0] : raw).replace(/\s+/g, '');
}
function normalizeSectionForKey(section){
  const s = clean(section);
  const m = s.match(/\d{1,4}/);
  return m ? m[0] : s.toUpperCase();
}
function studentCountKey(code, section){
  return `${normalizeCourseCodeForKey(code)}|${normalizeSectionForKey(section)}`;
}
function normalizeStudentStatus(value){
  return String(value || '').trim().toUpperCase().replace(/[^A-Z]/g, '');
}
function extractCourseCodeFromText(text){
  const m = String(text || '').toUpperCase().match(/\b[A-Z]{2,6}\d{3,5}\b/);
  return m ? m[0] : '';
}
function extractSectionFromText(text){
  const s = String(text || '');
  const patterns = [
    /(?:SECTION\s*(?:NO\.?|NUMBER)?|SEC\.?|CRN\s*SECTION|الشعبة|شعبه)\s*[:\-#]?\s*(\d{1,4})/i,
    /(?:Section|Sec)\s*(\d{1,4})/i,
    /\bSIS\s*\(?\s*(\d{1,4})\s*\)?/i,
    /\bCIMS\s*\(?\s*(\d{1,4})\s*\)?/i
  ];
  for (const p of patterns) { const m = s.match(p); if (m) return m[1]; }
  return '';
}
function looksLikeStudentRow(cells){
  const joined = (cells || []).map(clean).join(' ');
  if (looksLikeCourseHeader(joined)) return false;
  return (cells || []).some(c => {
    const v = clean(c).replace(/\s+/g,'');
    return /^\d{7,12}$/.test(v) || /^\d{3,6}[A-Z]\d{2,6}$/i.test(v) || /^\d{4,}[A-Z]?\d{2,}$/.test(v);
  }) || /\b\d{3,6}[A-Z]\d{2,6}\b/i.test(joined);
}
function cleanCourseNameFromStudentHeader(raw, code){
  const original = String(raw || '').trim();
  if (!original) return '';
  let suffix = '';
  const suffixMatch = original.match(/\b[A-Z]{2,8}\s*\d{3,5}\s*-\s*(\d{1,3})\b/i);
  if (suffixMatch) suffix = suffixMatch[1];

  let s = original;
  s = s.replace(/Course\s*Name\s*[:\-]?/ig, '').replace(/Course\s*Title\s*[:\-]?/ig, '').replace(/اسم\s*المقرر\s*[:\-]?/ig, '');
  // Remove course codes such as EDMA2213-3 but preserve the trailing course number as part of the course name.
  s = s.replace(/\b[A-Z]{2,8}\s*\d{3,5}\s*-\s*\d{1,3}\b/gi, '');
  s = s.replace(/\b[A-Z]{2,8}\s*\d{3,5}\b/gi, '');
  if (code) s = s.replace(new RegExp(code.replace(/[.*+?^${}()|[\]\\]/g,'\\$&') + '\\s*-?\\s*\\d*', 'i'), '');
  s = s.replace(/[：:]+/g, ' ').replace(/\s+/g, ' ').trim();
  const arabic = s.match(/[\u0600-\u06FF][\u0600-\u06FF\s\d()\-–]+/);
  let name = arabic ? arabic[0].replace(/^[-–\s]+|[-–\s]+$/g, '').trim() : s.replace(/^[:\-\s]+|[:\-\s]+$/g, '').trim();
  if (suffix && name && !new RegExp('(^|\\s)' + suffix + '$').test(name)) name = `${name} ${suffix}`;
  return name;
}

function rowHasExclusion(cells, exclusion){
  const rawCells = (cells || []).map(x => String(x || '').trim()).filter(Boolean);
  const rawJoined = rawCells.join(' ');
  const normalizedCells = rawCells.map(normalizeStudentStatus).filter(Boolean);
  const exclusionList = (exclusion || []).map(normalizeStudentStatus).filter(Boolean);

  // Exact-cell matching is always allowed. This prevents single-letter codes such as W from matching names like AL-WAHEIBI.
  if (normalizedCells.some(c => exclusionList.includes(c))) return true;

  for (const ex of exclusionList) {
    if (!ex) continue;
    if (ex === 'W') {
      if (rawCells.some(c => /^W$/i.test(c))) return true;
      continue;
    }
    if (ex === 'FW') {
      if (rawCells.some(c => /^FW$/i.test(c))) return true;
      continue;
    }
    if (ex === 'WD') {
      if (rawCells.some(c => /^WD$/i.test(c))) return true;
      continue;
    }
    if (ex === 'WITHDRAW') {
      if (/\bWITHDRAW(?:N|AL)?\b/i.test(rawJoined)) return true;
      continue;
    }
    if (ex === 'FAILINGFORUNEXCUSEDABSENCE') {
      if (/FAILING\s+FOR\s+UNEXCUSED\s+ABSENCE/i.test(rawJoined)) return true;
      continue;
    }
    // Longer exclusion phrases can be matched as normalized substrings.
    if (ex.length >= 3 && normalizeStudentStatus(rawJoined).includes(ex)) return true;
  }
  return false;
}

function looksLikeCourseHeader(text){
  return /Course\s*Name|Course\s*Department|Section\s*No|Lecturer\s*Name|No\s*Of\s*Student|اسم\s*المقرر|الشعبة/i.test(String(text||''));
}

function detectHeaderIndex(cells, patterns){
  const normalized = (cells || []).map(c => clean(c).toLowerCase());
  for (let i=0; i<normalized.length; i++) {
    if (patterns.some(p => p.test(normalized[i]))) return i;
  }
  return -1;
}

function updateHeaderMapFromRow(cells){
  const map = {};
  (cells || []).forEach((c,i) => {
    const v = clean(c).toLowerCase();
    if (/student\s*no|student\s*number|رقم\s*الطالب/.test(v)) map.studentNo = i;
    if (/student\s*name|اسم\s*الطالب/.test(v)) map.studentName = i;
    if (/remarks|remark|student'?s\s*signature|signature|الملاحظات|ملاحظات|توقيع/.test(v)) map.remarks = i;
    if (/course\s*code|رمز\s*المقرر|الكود/.test(v)) map.courseCode = i;
    if (/course\s*name|اسم\s*المقرر|المقرر/.test(v)) map.courseName = i;
    if (/section|section\s*no|الشعبة|شعبه/.test(v)) map.section = i;
  });
  return map;
}

function getRemarksFromRow(cells, headerMap){
  if (headerMap && headerMap.remarks !== undefined) return clean(cells[headerMap.remarks]);
  // In UTAS reports the exclusion status may appear in Remarks or Student's Signature columns.
  const joined = (cells || []).map(clean).join(' ');
  const m = joined.match(/(Withdraw|Failing\s+for\s+unexcused\s+absence|FW|\bW\b)/i);
  return m ? m[0] : '';
}

function normalizeHeaderName(value){
  return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
}
function isLikelyStudentNumber(value){
  const v = String(value || '').trim().replace(/\s+/g, '');
  // يستخدم هذا القسم عمود تسلسل الطالب. لذلك نقبل الأرقام القصيرة مثل 1، 2، 36،
  // ونستمر أيضًا في قبول أرقام الطلبة الطويلة في حال اختار المستخدم ذلك العمود.
  return /^\d{1,15}$/.test(v) || /^\d{3,8}[A-Z]\d{2,8}$/i.test(v);
}
function findHeaderRowInSheet(rows){
  let best = { index:-1, score:0, headers:[] };
  (rows || []).forEach((row, idx) => {
    const cells = (Array.isArray(row) ? row : [row]).map(clean);
    const joined = cells.join(' ').toLowerCase();
    let score = 0;
    if (/student\s*no|student\s*number|serial|sequence|^\s*no\.?\s*$|\bno\.?\b|تسلسل|مسلسل|الرقم\s*المسلسل|رقم\s*الطالب/i.test(joined)) score += 4;
    if (/remarks|remark|signature|student'?s\s*signature|ملاحظات|الملاحظات|توقيع/i.test(joined)) score += 3;
    if (/student\s*name|اسم\s*الطالب/i.test(joined)) score += 1;
    if (cells.filter(Boolean).length >= 3) score += 1;
    if (score > best.score) best = { index:idx, score, headers:cells };
  });
  return best.score >= 4 ? best : { index:-1, score:0, headers:[] };
}
function collectStudentCountHeadersFromWorkbookRows(workbookRows){
  const set = new Map();
  (workbookRows || []).forEach(sheet => {
    const found = findHeaderRowInSheet(sheet.rows || []);
    (found.headers || []).forEach(h => {
      const c = clean(h);
      if (c) set.set(c, c);
    });
  });
  return [...set.values()];
}
function chooseDefaultHeader(headers, patterns){
  return (headers || []).find(h => patterns.some(p => p.test(h))) || (headers || [])[0] || '';
}
function buildHeaderMapFromHeaders(headers){
  const selectedStudent = clean(document.getElementById('studentNumberColumnSelect')?.value || '');
  const selectedStatus = clean(document.getElementById('studentStatusColumnSelect')?.value || '');
  const map = {};
  (headers || []).forEach((h,i)=>{
    if (clean(h) === selectedStudent) map.studentNo = i;
    if (clean(h) === selectedStatus) map.status = i;
  });
  if (map.studentNo === undefined) {
    const i = (headers || []).findIndex(h => /student\s*no|student\s*number|serial|sequence|^\s*no\.?\s*$|\bno\.?\b|تسلسل|مسلسل|الرقم\s*المسلسل|رقم\s*الطالب/i.test(h));
    if (i >= 0) map.studentNo = i;
  }
  if (map.status === undefined) {
    const i = (headers || []).findIndex(h => /remarks|remark|signature|student'?s\s*signature|ملاحظات|الملاحظات|توقيع/i.test(h));
    if (i >= 0) map.status = i;
  }
  return map;
}
function extractCourseMetaFromRows(rows, sheetName=''){
  let code = extractCourseCodeFromText(sheetName) || '';
  let name = '';
  let section = extractSectionFromText(sheetName) || '';
  const limit = Math.min((rows || []).length, 40);
  for (let i=0; i<limit; i++) {
    const cells = (rows[i] || []).map(clean);
    const joined = cells.join(' ');
    const c = extractCourseCodeFromText(joined);
    if (c && !code) code = c;
    const sec = extractSectionFromText(joined);
    if (sec && !section) section = sec;
    if (/Course\s*Name|Course\s*Title|اسم\s*المقرر/i.test(joined) || (c && /[\u0600-\u06FF]/.test(joined))) {
      const nm = cleanCourseNameFromStudentHeader(joined, c || code);
      if (nm && (!name || nm.length > name.length)) name = nm;
    }
  }
  // If sheet name is EDMA2213-1, the last number is often section, not course title.
  const sheetSec = String(sheetName||'').match(/[A-Z]{2,8}\s*\d{3,5}\s*[-_ ]\s*(\d{1,4})/i);
  if (!section && sheetSec) section = sheetSec[1];
  return { courseCode: normalizeCourseCodeForKey(code), courseName: name, section: normalizeSectionForKey(section) };
}
function classifyStudentStatus(value){
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (/^\s*W\s*$/i.test(raw) || /\bWITHDRAW(?:N|AL)?\b/i.test(raw)) return 'W';
  if (/^\s*FW\s*$/i.test(raw) || /FAILING\s+FOR\s+UNEXCUSED\s+ABSENCE/i.test(raw)) return 'FW';
  return '';
}
function summarizeStudentCountsFromWorkbookRows(workbookRows){
  const map = new Map();
  function ensure(meta){
    const k = studentCountKey(meta.courseCode, meta.section);
    if (!map.has(k)) map.set(k, { courseCode:meta.courseCode, courseName:meta.courseName || '', section:meta.section, total:0, wCount:0, fwCount:0, excluded:0, actual:0 });
    const item = map.get(k);
    if (meta.courseName && (!item.courseName || item.courseName.length < 3)) item.courseName = meta.courseName;
    return item;
  }
  (workbookRows || []).forEach(sheet => {
    const rows = sheet.rows || [];
    const found = findHeaderRowInSheet(rows);
    if (found.index < 0) return;
    const headerMap = buildHeaderMapFromHeaders(found.headers);
    if (headerMap.studentNo === undefined) return;
    const meta = extractCourseMetaFromRows(rows, sheet.name || '');
    if (!meta.courseCode || !meta.section) return;
    const item = ensure(meta);
    for (let r = found.index + 1; r < rows.length; r++) {
      const cells = (rows[r] || []).map(clean);
      // Stop at next course header only; ignore empty/footer rows.
      const joined = cells.join(' ');
      if (looksLikeCourseHeader(joined) && extractCourseCodeFromText(joined) && r > found.index + 2) break;
      const studentNo = clean(cells[headerMap.studentNo] || '');
      if (!isLikelyStudentNumber(studentNo)) continue;
      const statusRaw = headerMap.status !== undefined ? clean(cells[headerMap.status] || '') : '';
      const status = classifyStudentStatus(statusRaw);
      item.total++;
      if (status === 'W') item.wCount++;
      if (status === 'FW') item.fwCount++;
    }
  });
  return [...map.values()].map(x => ({ ...x, excluded:x.wCount + x.fwCount, actual:x.total - x.wCount - x.fwCount }));
}
function summarizeStudentCountsFromFlatRows(rows){
  // Legacy fallback for very old callers; Excel analysis now uses summarizeStudentCountsFromWorkbookRows.
  return summarizeStudentCountsFromWorkbookRows([{ name:'Sheet1', rows: rows || [] }]);
}
async function extractRowsFromPdfFile(file){
  if (!window.pdfjsLib) throw new Error('PDFJS_NOT_LOADED');
  window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js';
  const buf = await file.arrayBuffer();
  const pdf = await window.pdfjsLib.getDocument({data:buf}).promise;
  const rows = [];
  for (let p=1; p<=pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    const lines = new Map();
    content.items.forEach(item => {
      const y = Math.round((item.transform && item.transform[5]) || 0);
      const x = Math.round((item.transform && item.transform[4]) || 0);
      const key = String(y);
      if (!lines.has(key)) lines.set(key, []);
      lines.get(key).push({x, text:item.str});
    });
    [...lines.entries()].sort((a,b)=>Number(b[0])-Number(a[0])).forEach(([,items]) => {
      rows.push(items.sort((a,b)=>a.x-b.x).map(i=>i.text));
    });
  }
  return rows;
}
async function loadStudentCountsWorkbook(file){
  const data = new Uint8Array(await file.arrayBuffer());
  const wb = XLSX.read(data, { type:'array', cellDates:false });
  return wb.SheetNames.map(sn => ({ name:sn, rows:XLSX.utils.sheet_to_json(wb.Sheets[sn], { header:1, defval:'', raw:false }) }));
}
function resetStudentCountsUpdateSection(message='سيتم عرض الفروقات هنا بعد تحليل الملف.'){
  pendingStudentCountDiffs = [];
  pendingStudentCountWorkbookRows = [];
  pendingStudentCountHeaders = [];
  pendingStudentCountFileName = '';
  const fileInput = document.getElementById('studentCountsPdfFile');
  if (fileInput) fileInput.value = '';
  const mapBox = document.getElementById('studentColumnMappingBox');
  if (mapBox) mapBox.classList.add('hidden');
  const stSel = document.getElementById('studentNumberColumnSelect');
  const statusSel = document.getElementById('studentStatusColumnSelect');
  if (stSel) stSel.innerHTML = '';
  if (statusSel) statusSel.innerHTML = '';
  const summary = document.getElementById('studentCountsDiffSummary');
  if (summary) summary.textContent = message;
  const table = document.getElementById('studentCountsDiffTable');
  if (table) table.innerHTML = '';
}
async function prepareStudentCountsFile(){
  const file = document.getElementById('studentCountsPdfFile')?.files?.[0];
  if (!file) return;
  const name = file.name.toLowerCase();
  if (!(name.endsWith('.xlsx') || name.endsWith('.xls'))) {
    resetStudentCountsUpdateSection('يرجى اختيار ملف Excel فقط.');
    alert('يرجى اختيار ملف Excel فقط.');
    return;
  }
  try {
    pendingStudentCountWorkbookRows = await loadStudentCountsWorkbook(file);
    pendingStudentCountFileName = file.name;
    pendingStudentCountHeaders = collectStudentCountHeadersFromWorkbookRows(pendingStudentCountWorkbookRows);
    const stSel = document.getElementById('studentNumberColumnSelect');
    const statusSel = document.getElementById('studentStatusColumnSelect');
    const opts = pendingStudentCountHeaders.map(h => `<option value="${escapeHtml(h)}">${escapeHtml(h)}</option>`).join('');
    if (stSel) {
      stSel.innerHTML = opts;
      stSel.value = chooseDefaultHeader(pendingStudentCountHeaders, [/^\s*no\.?\s*$/i,/serial/i,/sequence/i,/تسلسل/i,/مسلسل/i,/student\s*no/i,/student\s*number/i,/رقم\s*الطالب/i]) || stSel.value;
    }
    if (statusSel) {
      statusSel.innerHTML = opts;
      statusSel.value = chooseDefaultHeader(pendingStudentCountHeaders, [/remarks/i,/remark/i,/signature/i,/ملاحظات/i,/توقيع/i]) || statusSel.value;
    }
    document.getElementById('studentColumnMappingBox')?.classList.remove('hidden');
    const summary = document.getElementById('studentCountsDiffSummary');
    if (summary) summary.textContent = `تم اختيار ملف Excel: ${file.name}. اختر عمود تسلسل الطالب وعمود حالة الطالب ثم اضغط تحليل ومقارنة الأعداد.`;
  } catch (err) {
    console.error(err);
    resetStudentCountsUpdateSection('تعذر قراءة ملف Excel.');
    alert('تعذر قراءة ملف Excel.');
  }
}
async function analyzeStudentCountsFile(){
  const file = document.getElementById('studentCountsPdfFile')?.files?.[0];
  const summary = document.getElementById('studentCountsDiffSummary');
  const table = document.getElementById('studentCountsDiffTable');
  if (!file) return alert('يرجى اختيار ملف Excel أولًا.');
  if (!pendingStudentCountWorkbookRows.length || pendingStudentCountFileName !== file.name) await prepareStudentCountsFile();
  if (!pendingStudentCountWorkbookRows.length) return;
  if (summary) summary.textContent = 'جاري تحليل ملف Excel ومقارنة الأعداد...';
  if (table) table.innerHTML = '';
  try {
    const counts = summarizeStudentCountsFromWorkbookRows(pendingStudentCountWorkbookRows);
    const examRows = getStoredExams();
    const examMap = new Map();
    examRows.forEach((r, idx) => {
      const e = normalizeExam(r);
      if (e.courseCode && e.section) examMap.set(studentCountKey(e.courseCode, e.section), { index:idx, exam:e });
    });
    pendingStudentCountDiffs = counts.map(c => {
      const hit = examMap.get(studentCountKey(c.courseCode, c.section));
      const current = hit ? Number(hit.exam.students)||0 : null;
      return { ...c,
        courseName: hit ? hit.exam.courseName : c.courseName,
        sectionLabel: hit ? getSectionTypeLabel(hit.exam.section) : getSectionTypeLabel(c.section),
        current,
        rowIndex: hit ? hit.index : -1,
        diff: hit ? c.actual - current : null,
        selected: !!(hit && c.actual !== current)
      };
    }).filter(x => x.current !== null);
    const diffCount = pendingStudentCountDiffs.filter(x => x.diff !== 0).length;
    const unmatched = counts.filter(c => !examMap.has(studentCountKey(c.courseCode, c.section))).length;
    if (summary) summary.textContent = `تم تحليل ${toArabicDigits(counts.length)} شعبة. توجد ${toArabicDigits(diffCount)} شعبة بها اختلاف في الأعداد. غير المطابق مع ملف الامتحانات: ${toArabicDigits(unmatched)}.`;
    if (table) {
      const controls = pendingStudentCountDiffs.some(x=>x.diff!==0) ? `<div class="student-diff-controls"><button id="selectAllStudentDiffsInlineBtn" class="secondary-btn" type="button">تحديد الكل</button><button id="clearAllStudentDiffsInlineBtn" class="secondary-btn" type="button">إلغاء تحديد الكل</button></div>` : '';
      const body = pendingStudentCountDiffs.map((x,i) => `<tr class="${x.diff===0?'diff-ok':Math.abs(Number(x.diff)||0)>1?'diff-strong':'diff-soft'}"><td><input type="checkbox" data-student-diff-index="${i}" ${x.selected?'checked':''} ${x.diff===0?'disabled':''}></td><td>${escapeHtml(x.courseName||'')}</td><td>${escapeHtml(x.courseCode)}</td><td>${escapeHtml(getSectionTypeLabel(x.section))}</td><td>${toArabicDigits(x.current)}</td><td>${toArabicDigits(x.total)}</td><td>${toArabicDigits(x.wCount)}</td><td>${toArabicDigits(x.fwCount)}</td><td>${toArabicDigits(x.excluded)}</td><td>${toArabicDigits(x.actual)}</td><td>${toArabicDigits(x.diff)}</td></tr>`).join('');
      const unmatchedRows = counts.filter(c => !examMap.has(studentCountKey(c.courseCode, c.section))).map(c => `<tr class="diff-unmatched"><td>—</td><td>${escapeHtml(c.courseName||'')}</td><td>${escapeHtml(c.courseCode)}</td><td>${escapeHtml(getSectionTypeLabel(c.section))}</td><td>غير مطابق</td><td>${toArabicDigits(c.total)}</td><td>${toArabicDigits(c.wCount)}</td><td>${toArabicDigits(c.fwCount)}</td><td>${toArabicDigits(c.excluded)}</td><td>${toArabicDigits(c.actual)}</td><td>—</td></tr>`).join('');
      table.innerHTML = `${controls}<table class="student-count-diff-table"><thead><tr><th>تحديد</th><th>المقرر</th><th>الكود</th><th>الشعبة</th><th>العدد الحالي</th><th>إجمالي الملف</th><th>W</th><th>FW</th><th>إجمالي المستبعدين</th><th>العدد الفعلي</th><th>الفرق</th></tr></thead><tbody>${body || ''}${unmatchedRows || ''}${(!body && !unmatchedRows) ? '<tr><td colspan="11">لم يتم العثور على شعب قابلة للتحليل. تأكد من اختيار عمود تسلسل الطالب وعمود حالة الطالب بشكل صحيح.</td></tr>' : ''}</tbody></table>`;
      const selectAll = () => document.querySelectorAll('[data-student-diff-index]:not(:disabled)').forEach(el => el.checked = true);
      const clearAll = () => document.querySelectorAll('[data-student-diff-index]:not(:disabled)').forEach(el => el.checked = false);
      document.getElementById('selectAllStudentDiffsInlineBtn')?.addEventListener('click', selectAll);
      document.getElementById('clearAllStudentDiffsInlineBtn')?.addEventListener('click', clearAll);
    }
    logAdminOperation('تحليل أعداد الطلبة', file.name);
  } catch (err) {
    console.error(err);
    if (summary) summary.textContent = 'تعذر تحليل ملف Excel. تأكد من اختيار الأعمدة الصحيحة.';
    alert('تعذر تحليل ملف Excel.');
  }
}
async function applySelectedStudentCountUpdates(){
  if (!pendingStudentCountDiffs.length) return alert('لا توجد فروقات لاعتمادها.');
  if (!requireCloudForSharedSave()) return;
  const rows = getStoredExams();
  const selected = [...document.querySelectorAll('[data-student-diff-index]:checked')].map(el => pendingStudentCountDiffs[Number(el.dataset.studentDiffIndex)]).filter(x => x && x.diff !== 0);
  if (!selected.length) return alert('يرجى تحديد شعبة واحدة على الأقل للتحديث.');
  const ok = await showConfirmModal("هل تريد اعتماد التحديث؟ سيتم تحديث أعداد الطلبة للشعب المحددة ثم مسح ملف القوائم ونتائج التحليل الحالية.", "اعتماد التحديث", { yesText:"اعتماد التحديث", noText:"إلغاء" });
  if (!ok) return;
  selected.forEach(x => { if (rows[x.rowIndex]) setStudentsValue(rows[x.rowIndex], x.actual); });
  saveExams(rows); refreshAllExams(); updateStats('تم تحديث أعداد الطلبة المحددة.'); populateEditDates(); populateSettingsFilterOptions();
  logAdminOperation('اعتماد التحديث', `${selected.length} شعبة`);
  resetStudentCountsUpdateSection('تم اعتماد تحديث الأعداد المحددة ومسح ملف التحليل من الواجهة.');
  alert('تم اعتماد التحديث ومسح ملف القوائم من الواجهة بنجاح.');
}

function getReportSelectedSections(){
  const selected = {};
  document.querySelectorAll('[data-report-section]').forEach(el => selected[el.dataset.reportSection] = !!el.checked);
  return selected;
}
function getReportScope(){
  return document.querySelector('input[name="reportScope"]:checked')?.value || "daily";
}
function isDateInReportScope(dateObj, scope){
  const d = new Date(dateObj);
  const now = new Date();
  if (scope === "all") return true;
  if (scope === "daily") return isSameDay(d, now);
  if (scope === "weekly") {
    const start = new Date(now);
    start.setHours(0,0,0,0);
    start.setDate(start.getDate() - start.getDay());
    const end = new Date(start);
    end.setDate(start.getDate() + 7);
    return d >= start && d < end;
  }
  return true;
}
function requestDateForScope(r){
  return new Date(Number(r.createdAtMs || r.examEndMs || Date.now()));
}
function examDateForScope(e){
  return combineDateTime(e.date, e.period.startMinutes);
}
function getReportScopeLabel(scope){
  return scope === "daily" ? "تقرير يومي" : scope === "weekly" ? "تقرير أسبوعي" : "تقرير شامل";
}
function tableHtmlHorizontal(labels, values){
  return `<table class="print-table print-summary-horizontal"><thead><tr>${labels.map(h=>`<th>${escapeHtml(h)}</th>`).join("")}</tr></thead><tbody><tr>${values.map(v=>`<td>${v}</td>`).join("")}</tr></tbody></table>`;
}
function getSupportReportTitleData(){
  const term = getDisplayTerm();
  return {
    semester: term && term.active ? term.semester : (localStorage.getItem(STORE_KEYS.semester) || ""),
    academicYear: term && term.academicYear ? term.academicYear : (localStorage.getItem(STORE_KEYS.academicYear) || ""),
    chairName: localStorage.getItem(STORE_KEYS.supportChairName) || (cloudSettingsCache && cloudSettingsCache.supportChairName) || "",
    chairTitle: localStorage.getItem(STORE_KEYS.supportChairTitle) || (cloudSettingsCache && cloudSettingsCache.supportChairTitle) || ""
  };
}
function tableHtml(headers, rows){
  return `<table class="print-table"><thead><tr>${headers.map(h=>`<th>${escapeHtml(h)}</th>`).join("")}</tr></thead><tbody>${rows.length ? rows.map(r=>`<tr>${r.map(c=>`<td>${c}</td>`).join("")}</tr>`).join("") : `<tr><td colspan="${headers.length}">لا توجد بيانات</td></tr>`}</tbody></table>`;
}
function buildSupportReportHtml(requests=[]){
  refreshAllExams();
  const selected = getReportSelectedSections();
  const title = getSupportReportTitleData();
  const scope = getReportScope();
  const scopeLabel = getReportScopeLabel(scope);
  const exams = allExams.filter(e => isDateInReportScope(examDateForScope(e), scope));
  const scopedRequests = requests.filter(r => isDateInReportScope(requestDateForScope(r), scope));
  const absenceReqs = scopedRequests.filter(r=>r.kind === "absence");
  const earlyReqs = scopedRequests.filter(r=>r.kind === "earlyFinish");
  const activeReqs = scopedRequests.filter(r=>r.kind !== "absence" && r.kind !== "earlyFinish");
  const absenceTotal = absenceReqs.reduce((s,r)=>s+(Number(r.absenceCount)||0),0);
  const totalStudents = sumStudents(exams);
  const summaryRows = [
    ["نوع التقرير", escapeHtml(scopeLabel)],
    ["عدد اللجان", toArabicDigits(computeCommitteeCount(exams))],
    ["القاعات المستخدمة", toArabicDigits(unique(exams.map(e=>e.hall)).length)],
    ["عدد المقررات", toArabicDigits(uniqueCourseCount(exams))],
    ["عدد الشعب", toArabicDigits(exams.length)],
    ["عدد الطلبة", toArabicDigits(totalStudents)],
    ["عدد الغياب", toArabicDigits(absenceTotal)],
    ["نسبة الغياب", toArabicDigits(totalStudents ? ((absenceTotal/totalStudents)*100).toFixed(2) : "0.00") + "%"],
    ["عدد الاستدعاءات", toArabicDigits(activeReqs.length)],
    ["إنهاء الاختبارات", toArabicDigits(earlyReqs.length)]
  ];
  const periodMap = new Map();
  exams.forEach(e => { const k = periodKeyForExam(e); if (!periodMap.has(k)) periodMap.set(k, []); periodMap.get(k).push(e); });
  const periodRows = [...periodMap.entries()].map(([period, exs], i)=>{
    const abs = getAbsenceTotalForExams(exs);
    const st = sumStudents(exs);
    return [periodName(i), escapeHtml(period), toArabicDigits(computeCommitteeCount(exs)), toArabicDigits(unique(exs.map(e=>e.hall)).length), toArabicDigits(uniqueCourseCount(exs)), toArabicDigits(st), toArabicDigits(abs), toArabicDigits(st?((abs/st)*100).toFixed(2):"0.00")+"%"];
  });
  const hallRows = exams.slice().sort((a,b)=>String(a.hall).localeCompare(String(b.hall),'ar',{numeric:true})).map(e=>[
    escapeHtml(e.hall), escapeHtml(e.courseName), escapeHtml(e.courseCode), escapeHtml(getSectionTypeLabel(e.section)), toArabicDigits(e.students), toArabicDigits(getAbsenceTotalForExams([e]))
  ]);
  const requestRows = scopedRequests.slice().sort((a,b)=>(a.createdAtMs||0)-(b.createdAtMs||0)).map(r=>[
    r.createdAtMs ? escapeHtml(toArabicDigits(new Intl.DateTimeFormat("ar-OM-u-nu-latn-ca-gregory", {hour:"2-digit", minute:"2-digit", day:"2-digit", month:"2-digit"}).format(new Date(r.createdAtMs)))) : "",
    escapeHtml(r.hall || ""), escapeHtml(r.type || r.kind || ""), escapeHtml(buildSupportRequestLabel(r))
  ]);
  const absenceRows = absenceReqs.slice().sort((a,b)=>String(a.courseCode||"").localeCompare(String(b.courseCode||""),'ar',{numeric:true})).map(r=>[
    escapeHtml(r.courseName || ""), escapeHtml(r.courseCode || ""), escapeHtml(r.sectionLabel || getSectionTypeLabel(r.section || "")), toArabicDigits(Number(r.absenceCount)||0)
  ]);
  let sections = "";
  if (selected.summary) sections += `<h2>الملخص الإحصائي</h2>${tableHtmlHorizontal(summaryRows.map(r=>r[0]), summaryRows.map(r=>r[1]))}`;
  if (selected.periods) sections += `<h2>إحصائية الفترات</h2>${tableHtml(["الفترة","الوقت","اللجان","القاعات","المقررات","الطلبة","الغياب","نسبة الغياب"], periodRows)}`;
  if (selected.halls) sections += `<h2>القاعات المستخدمة</h2>${tableHtml(["القاعة","اسم المقرر","الكود","الشعبة","الطلبة","الغياب"], hallRows)}`;
  if (selected.absence) sections += `<h2>إحصائية الغياب</h2>${tableHtml(["اسم المقرر","كود المقرر","الشعبة","عدد الغياب"], absenceRows)}`;
  if (selected.requests) sections += `<h2>سجل الاستدعاءات</h2>${tableHtml(["الوقت","القاعة","النوع","التفاصيل"], requestRows.filter(r=>!/غياب|انتهاء/.test(r[2]+r[3])))}`;
  if (selected.finish) sections += `<h2>سجل إنهاء الاختبارات</h2>${tableHtml(["الوقت","القاعة","النوع","التفاصيل"], requestRows.filter(r=>/انتهاء/.test(r[2]+r[3])))}`;
  const logo = selected.logo ? `<img class="print-logo" src="assets/logo.png" />` : "";
  const signature = selected.signature ? `<div class="signature-block"><p>رئيس لجنة دعم ومراقبة الامتحانات</p><strong>${escapeHtml(title.chairName || "................................")}</strong><p>${escapeHtml(title.chairTitle || "")}</p><p>التوقيع: ................................</p></div>` : "";
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>تقرير لجنة دعم ومراقبة الامتحانات</title><style>
    @page{size:A4;margin:16mm 14mm 14mm 14mm} @font-face{font-family:'UTASReport';src:url('assets/fonts/UTAS-Regular.woff2') format('woff2'),url('assets/fonts/UTAS-Regular.ttf') format('truetype');font-weight:400;font-style:normal}body{font-family:'UTASReport',Tahoma,Arial,sans-serif;color:#0B2E6B;line-height:1.55;margin:0;padding-top:42mm}.print-header{height:34mm;position:fixed;top:0;left:0;right:0;background:#fff;border-bottom:2px solid #0B2E6B;margin-bottom:12px;padding-bottom:7px;text-align:center;z-index:5}.print-logo{position:absolute;right:0;top:0;max-height:62px;max-width:205px;object-fit:contain}.print-header h1{font-size:23px;margin:4px 0}.print-header h2{font-size:16px;margin:2px 0;color:#123}.print-content{padding-top:0}.print-section h2,h2{font-size:17px;margin:16px 0 8px;color:#0B2E6B}.print-table{width:100%;border-collapse:collapse;margin-bottom:12px;font-size:11px;table-layout:auto}.print-table th,.print-table td{border:1px solid #B8C6D9;padding:5px;text-align:center;vertical-align:middle}.print-table th{background:#EAF2FF}.print-summary-horizontal{font-size:10px}.signature-block{margin-top:36px;text-align:left;color:#111}.report-date{text-align:left;color:#555;font-size:12px;margin-top:8px}@media print{button{display:none}.print-header{break-after:avoid;page-break-after:avoid}.print-section{break-inside:auto}thead{display:table-header-group}}
  </style></head><body>${logo}<div class="print-header"><h1>تقرير لجنة دعم ومراقبة الامتحانات</h1><h2>الامتحانات النهائية للفصل الدراسي (${escapeHtml(title.semester)})</h2><h2>العام الأكاديمي (${escapeHtml(title.academicYear)})</h2><h2>${escapeHtml(scopeLabel)}</h2><div class="report-date">تاريخ إنشاء التقرير: ${escapeHtml(toArabicDigits(new Intl.DateTimeFormat("ar-OM-u-nu-latn-ca-gregory", {dateStyle:"medium", timeStyle:"short"}).format(new Date())))}</div></div><main class="print-content">${sections}${signature}</main><script>setTimeout(()=>window.print(),400)</script></body></html>`;
}

async function generateSupportReport(){
  let requests = [];
  try {
    if (supportRequestsCollection()) {
      const snap = await supportRequestsCollection().get();
      requests = snap.docs.map(d=>({id:d.id, ...(d.data()||{})}));
    }
  } catch(err){ console.error(err); }
  const html = buildSupportReportHtml(requests);
  const w = window.open("", "_blank");
  if (!w) return alert("تعذر فتح نافذة التقرير. تحقق من إعدادات المتصفح.");
  w.document.open(); w.document.write(html); w.document.close();
}
function initReportTools(){
  const chairName = document.getElementById("supportChairNameInput");
  const chairTitle = document.getElementById("supportChairTitleInput");
  if (chairName) chairName.value = localStorage.getItem(STORE_KEYS.supportChairName) || (cloudSettingsCache && cloudSettingsCache.supportChairName) || "";
  if (chairTitle) chairTitle.value = localStorage.getItem(STORE_KEYS.supportChairTitle) || (cloudSettingsCache && cloudSettingsCache.supportChairTitle) || "";
  document.getElementById("saveReportSettingsBtn")?.addEventListener("click", () => {
    if (!requireCloudForSharedSave()) return;
    const name = chairName ? chairName.value.trim() : "";
    const title = chairTitle ? chairTitle.value.trim() : "";
    localStorage.setItem(STORE_KEYS.supportChairName, name);
    localStorage.setItem(STORE_KEYS.supportChairTitle, title);
    saveCloudSettings({ supportChairName:name, supportChairTitle:title });
    logAdminOperation("حفظ بيانات رئيس لجنة الدعم", name);
    const status = document.getElementById("reportStatus"); if (status) status.textContent = "تم حفظ بيانات التقرير.";
  });
  document.getElementById("generateSupportReportBtn")?.addEventListener("click", generateSupportReport);
}

function initAdmin(){
  updateTopDate();
  updateCopyright();
  bindFullscreenButton();
  setTitles();
  initTermSettings();
  initReportTools();
  initHallLockAdmin();
  initSettingsSidebar();
  setAdminSupportButtonVisible(false);
  const login = document.getElementById("loginPanel"); const settings = document.getElementById("settingsPanel");
  document.getElementById("loginBtn")?.addEventListener("click", async () => {
    try {
      if (cloudAuthReady && cloudAuth) {
        const provider = new window.firebase.auth.GoogleAuthProvider();
        provider.setCustomParameters({ prompt: "select_account" });
        const result = await cloudAuth.signInWithPopup(provider);
        const user = result.user;
        const allowed = user && await isAuthorizedAdmin(user.email);
        if (!allowed) {
          await cloudAuth.signOut();
          return alert("هذا الحساب غير مصرح له بالدخول إلى الإعدادات.");
        }
        adminAuthorized = true;
        adminUserEmail = normalizeEmail(user.email);
        sessionStorage.setItem("finalExamTimer.adminLoggedIn","true");
        login.classList.add("hidden"); settings.classList.remove("hidden"); setAdminSupportButtonVisible(true);
        updateStats(); resetAdminInactivity(); loadAdminsList();
      } else {
        alert("Firebase Authentication غير مفعّل. يرجى تفعيل Google Sign-in في Firebase.");
      }
    } catch (err) {
      console.error(err);
      alert("تعذر تسجيل الدخول باستخدام Google. تحقق من تفعيل Google في Firebase ومن إضافة نطاق Vercel في Authorized domains.");
    }
  });
  updateDataFileInfo();
  setCloudStatus(cloudStatusText);
  document.getElementById("adminOpenSupportBtn")?.addEventListener("click", () => {
    sessionStorage.setItem("finalExamTimer.supportLoggedIn", "true");
    location.hash = "support";
  });
  document.getElementById("excelFile")?.addEventListener("change", handleExcelUpload);
  document.getElementById("replaceDataBtn")?.addEventListener("click", replaceCurrentData);
  document.getElementById("savePasswordBtn")?.addEventListener("click", async () => {
    const current = document.getElementById("currentPassword")?.value || "";
    const np = document.getElementById("newPassword")?.value.trim() || "";
    const cp = document.getElementById("confirmPassword")?.value.trim() || "";
    if (np.length < 6) return alert("يرجى إدخال كلمة مرور جديدة من 6 خانات على الأقل.");
    if (np !== cp) return alert("كلمة المرور الجديدة وتأكيدها غير متطابقين.");
    if (cloudAuthReady && cloudAuth && cloudAuth.currentUser) {
      try {
        const user = cloudAuth.currentUser;
        const credential = window.firebase.auth.EmailAuthProvider.credential(user.email, current);
        await user.reauthenticateWithCredential(credential);
        await user.updatePassword(np);
        await saveCloudSettings({ passwordHintUpdatedAt: Date.now() });
        ["currentPassword","newPassword","confirmPassword"].forEach(id => { const el = document.getElementById(id); if (el) el.value = ""; });
        alert("تم تغيير كلمة مرور حساب Firebase Authentication. ستعمل على جميع الأجهزة.");
      } catch (err) {
        console.error(err);
        alert("تعذر تغيير كلمة المرور. تحقق من كلمة المرور الحالية أو أعد تسجيل الدخول.");
      }
    } else {
      const oldPw = getAdminPassword();
      if (current !== oldPw) return alert("الرقم السري الحالي غير صحيح.");
      if (!requireCloudForSharedSave()) return;
      localStorage.setItem(STORE_KEYS.password, np);
      cloudSettingsCache = { ...(cloudSettingsCache || {}), password: np };
      saveCloudSettings({ password: np });
      ["currentPassword","newPassword","confirmPassword"].forEach(id => { const el = document.getElementById(id); if (el) el.value = ""; });
      alert("تم حفظ الرقم السري الجديد.");
    }
  });
  initEditTools();
  initManualExamForm();
  initAdminManagement();
}

function initAdminManagement(){
  const addBtn = document.getElementById("addAdminBtn");
  if (!addBtn) return;
  addBtn.addEventListener("click", addAdminEmail);
}
function initManualExamForm(){
  document.getElementById("addManualExamBtn")?.addEventListener("click", () => {
    if (!requireCloudForSharedSave()) return;
    const row = {
      "رمز المقرر": clean(document.getElementById("manualCourseCode")?.value),
      "اسم المقرر": clean(document.getElementById("manualCourseName")?.value),
      "الشعبة": clean(document.getElementById("manualSection")?.value),
      "اليوم": clean(document.getElementById("manualDay")?.value),
      "التاريخ": clean(document.getElementById("manualDate")?.value),
      "الفترة": clean(document.getElementById("manualPeriod")?.value),
      "عدد الطلاب": clean(document.getElementById("manualStudents")?.value),
      "القاعة": clean(document.getElementById("manualHall")?.value)
    };
    const exam = normalizeExam(row);
    if (!exam.courseCode || !exam.courseName || !exam.section || !exam.date || !exam.period || !exam.hall) {
      return alert("يرجى تعبئة جميع بيانات الاختبار بصيغة صحيحة.");
    }
    const rows = getStoredExams();
    rows.push(row);
    saveExams(rows);
    logAdminOperation("إضافة امتحان مقرر", `${row["اسم المقرر"] || ""} - ${row["رمز المقرر"] || ""}`);
    refreshAllExams(); populateHalls(); populateEditDates(); updateStats("تمت إضافة الاختبار يدويًا."); updateSupportStats();
    ["manualCourseCode","manualCourseName","manualSection","manualDay","manualDate","manualPeriod","manualStudents","manualHall"].forEach(id => { const el=document.getElementById(id); if(el) el.value=""; });
    const st = document.getElementById("manualExamStatus"); if (st) st.textContent = "تمت إضافة الاختبار وجدولته بنجاح.";
  });
}

function renderAdminsListFromDocs(docs){
  const box = document.getElementById("adminsList");
  if (!box) return;
  const admins = docs.map(doc => ({ id: doc.id, ...(doc.data ? doc.data() : doc) }))
    .map(a => ({ ...a, email: normalizeEmail(a.email || a.id) }))
    .filter(a => a.email)
    .sort((a,b) => (a.email === PRIMARY_ADMIN_EMAIL ? -1 : b.email === PRIMARY_ADMIN_EMAIL ? 1 : a.email.localeCompare(b.email)));
  if (!admins.some(a => a.email === PRIMARY_ADMIN_EMAIL)) admins.unshift({ email: PRIMARY_ADMIN_EMAIL, protected: true, role: "owner" });
  box.innerHTML = admins.map(a => {
    const isPrimary = a.email === PRIMARY_ADMIN_EMAIL;
    return `<div class="admin-user-row">
      <div><strong>${escapeHtml(a.email)}</strong>${isPrimary ? '<span>مالك النظام</span>' : '<span>أدمن</span>'}</div>
      ${isPrimary ? '<em>لا يمكن حذفه</em>' : `<button type="button" class="danger-btn" data-remove-admin="${escapeHtml(a.email)}">حذف</button>`}
    </div>`;
  }).join("");
  box.querySelectorAll("[data-remove-admin]").forEach(btn => {
    btn.addEventListener("click", () => removeAdminEmail(btn.getAttribute("data-remove-admin")));
  });
}
async function loadAdminsList(){
  const box = document.getElementById("adminsList");
  if (!box || !cloudDb) return;
  await ensurePrimaryAdminDoc();
  if (adminsUnsubscribe) { try { adminsUnsubscribe(); } catch {} adminsUnsubscribe = null; }
  adminsUnsubscribe = cloudDb.collection("admins").onSnapshot(snap => {
    renderAdminsListFromDocs(snap.docs);
  }, err => {
    console.error(err);
    box.innerHTML = '<p class="soft-note">تعذر تحميل قائمة المسؤولين. تحقق من قواعد Firestore.</p>';
  });
}
async function addAdminEmail(){
  if (!requireCloudForSharedSave()) return;
  const input = document.getElementById("newAdminEmail");
  const email = normalizeEmail(input?.value || "");
  if (!email || !email.includes("@")) return alert("يرجى إدخال بريد إلكتروني صحيح.");
  try {
    await adminDoc(email).set({
      email,
      role: email === PRIMARY_ADMIN_EMAIL ? "owner" : "admin",
      protected: email === PRIMARY_ADMIN_EMAIL,
      addedBy: adminUserEmail || (cloudAuth.currentUser && cloudAuth.currentUser.email) || "",
      createdAt: window.firebase.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    if (input) input.value = "";
    logAdminOperation("إضافة أدمن", email);
    alert("تمت إضافة الأدمن.");
  } catch (err) {
    console.error(err);
    alert("تعذرت إضافة الأدمن. تحقق من قواعد Firestore.");
  }
}
async function removeAdminEmail(email){
  if (!requireCloudForSharedSave()) return;
  email = normalizeEmail(email);
  if (email === PRIMARY_ADMIN_EMAIL) return alert("لا يمكن حذف المسؤول الرئيسي.");
  const ok = await showConfirmModal("هل تريد حذف هذا الأدمن من قائمة المصرح لهم؟", "حذف أدمن", { yesText:"حذف", noText:"إلغاء" });
  if (!ok) return;
  try {
    await adminDoc(email).delete();
    logAdminOperation("حذف أدمن", email);
    alert("تم حذف الأدمن بنجاح.");
    loadAdminsList();
  } catch (err) {
    console.error(err);
    alert("تعذر حذف الأدمن. تحقق من قواعد Firestore.");
  }
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
async function saveEditedRows(){
  const cards = [...document.querySelectorAll(".edit-row-card")];
  if (!cards.length) return alert("لا توجد سجلات معروضة للحفظ.");
  if (!requireCloudForSharedSave()) return;
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
  const savedToCloud = await saveExams(rows);
  if (!savedToCloud) return;
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
  logAdminOperation("حفظ تعديلات بيانات الامتحانات", `${cards.length} سجل`);
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
  if (!requireCloudForSharedSave()) return;
  const savedToCloud = await saveExamsWithMeta(pendingExcelRows, pendingExcelFileName);
  logAdminOperation("استبدال ملف الامتحانات", pendingExcelFileName);
  if (!savedToCloud) return;
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
  const scopeControl = document.getElementById('adminStatsScopeSelect');
  const contentBox = document.getElementById('adminStatsContent');
  const placeholder = document.getElementById('adminStatsPlaceholder');
  if (scopeControl && (!scopeControl.value || !window.__adminStatsRequested)) {
    if (contentBox) contentBox.classList.add('hidden');
    if (placeholder) placeholder.classList.remove('hidden');
    const statusOnly = document.getElementById("adminStatus");
    if (statusOnly) statusOnly.textContent = message || "";
    return;
  }
  if (contentBox) contentBox.classList.remove('hidden');
  if (placeholder) placeholder.classList.add('hidden');
  const rows = getStoredExams();
  const allScopedExams = rows.map(normalizeExam).filter(e => e.hall && e.date && e.period);
  const exams = filterExamsByAdminScope(allScopedExams, 'adminStats');
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

function hasAnyActiveExamNow(){
  refreshAllExams();
  const now = new Date();
  return allExams.some(e => {
    const t = getExamTiming(e);
    return t && now >= t.start && now <= t.end;
  });
}
function updateSupportWakeLock(){
  if (location.hash === "#support" && hasAnyActiveExamNow()) enableWakeLock();
  else if (location.hash === "#support") disableWakeLock();
}
function startSupportWakeMode(){
  updateSupportWakeLock();
  if (supportWakeInterval) clearInterval(supportWakeInterval);
  supportWakeInterval = setInterval(updateSupportWakeLock, 10000);
}
function stopSupportWakeMode(){
  if (supportWakeInterval) clearInterval(supportWakeInterval);
  supportWakeInterval = null;
}

function showAppPage(){
  const isAdmin = location.hash === "#admin";
  const isSupport = location.hash === "#support";
  document.body.classList.toggle("admin-mode", isAdmin || isSupport);
  document.body.classList.toggle("display-mode", !isAdmin && !isSupport);
  const display = document.getElementById("displayPage");
  const admin = document.getElementById("adminPage");
  const support = document.getElementById("supportPage");
  if (display) display.classList.toggle("hidden", isAdmin || isSupport);
  if (admin) admin.classList.toggle("hidden", !isAdmin);
  if (support) support.classList.toggle("hidden", !isSupport);
  updateTopDate();
  updateCopyright();
  if (!isAdmin) adminLogout();
  if (!isSupport) { detachSupportRequestsListener();
  detachAttendanceReportsListener(); stopSupportWakeMode(); }
  if (!isAdmin && !isSupport) {
    refreshAllExams();
    if (currentHall) renderHall(currentHall);
    else populateHalls();
  } else if (isSupport) {
    if (!isSupportLoggedIn()) { location.hash = "admin"; return; }
    updateSupportStats();
    attachSupportRequestsListener();
  attachAttendanceReportsListener();
    startSupportWakeMode();
  } else {
    const login = document.getElementById("loginPanel");
    const settings = document.getElementById("settingsPanel");
    if (sessionStorage.getItem("finalExamTimer.adminLoggedIn") === "true") {
      if (login) login.classList.add("hidden");
      if (settings) settings.classList.remove("hidden");
      setAdminSupportButtonVisible(true);
      loadAdminsList();
      resetAdminInactivity();
    } else {
      if (login) login.classList.remove("hidden");
      if (settings) settings.classList.add("hidden");
      setAdminSupportButtonVisible(false);
    }
    populateEditDates();
    updateStats();
  }
}

window.addEventListener("beforeunload", () => { try { if (currentHallLockId && navigator.sendBeacon) { /* best effort only */ } } catch {} releaseCurrentHallLock(); });

document.addEventListener("DOMContentLoaded", () => {
  initCloudSync();
  attachAdminActivityWatchers();
  initDisplay();
  initAdmin();
  initSupportPage();
  showAppPage();
  window.addEventListener("hashchange", showAppPage);
});
