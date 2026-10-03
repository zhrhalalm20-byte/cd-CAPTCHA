const form = document.getElementById("searchForm");
const searchButton = document.getElementById("searchButton");
const buttonText = document.getElementById("buttonText");
const loader = document.getElementById("loader");
const message = document.getElementById("message");
const result = document.getElementById("result");
const seatNumber = document.getElementById("seatNumber");
const resultName = document.getElementById("resultName");
const resultYear = document.getElementById("resultYear");
const resultPsn = document.getElementById("resultPsn");
const psnRow = document.getElementById("psnRow");
const studentName = document.getElementById("studentName");
const academicYear = document.getElementById("academicYear");
const toast = document.getElementById("toast");

function showMessage(text, type = "error") {
  message.textContent = text;
  message.className = `message ${type}`;
}
function hideMessage() { message.className = "message hidden"; message.textContent = ""; }
function setLoading(loading) {
  searchButton.disabled = loading;
  buttonText.classList.toggle("hidden", loading);
  loader.classList.toggle("hidden", !loading);
}
function hideResult() { result.classList.add("hidden"); }
function showToast(text) {
  toast.textContent = text;
  toast.classList.remove("hidden");
  toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => { toast.classList.add("hidden"); toast.classList.remove("show"); }, 2200);
}
function showResult(data) {
  seatNumber.textContent = data.seat_number || "—";
  resultName.textContent = data.student_name || studentName.value.trim();
  resultYear.textContent = data.academic_year || academicYear.value;
  if (data.psn) { resultPsn.textContent = data.psn; psnRow.classList.remove("hidden"); }
  else psnRow.classList.add("hidden");
  result.classList.remove("hidden");
  result.scrollIntoView({ behavior: "smooth", block: "center" });
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  hideMessage(); hideResult();
  const year = academicYear.value.trim();
  const name = studentName.value.trim();
  if (!year) { showMessage("يرجى اختيار العام الدراسي."); academicYear.focus(); return; }
  if (!name) { showMessage("يرجى إدخال الاسم الرباعي."); studentName.focus(); return; }
  if (name.split(/\s+/).filter(Boolean).length < 4) { showMessage("يرجى إدخال الاسم الرباعي كاملًا."); studentName.focus(); return; }
  setLoading(true);
  try {
    const response = await fetch("/api/search", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ academic_year: year, student_name: name }) });
    let data;
    try { data = await response.json(); } catch { throw new Error("تعذر قراءة استجابة الخادم."); }
    if (!response.ok || !data.success) { showMessage(data.message || "حدث خطأ أثناء الاستعلام."); return; }
    showResult(data);
    showMessage("تم العثور على بيانات الطالب بنجاح.", "success");
  } catch (error) {
    console.error(error);
    showMessage("تعذر الاتصال بالخادم. تأكد من اتصال الإنترنت وحاول مرة أخرى.");
  } finally { setLoading(false); }
});

document.getElementById("copyButton").addEventListener("click", async () => {
  const value = seatNumber.textContent.trim();
  if (!value || value === "—") return;
  try { await navigator.clipboard.writeText(value); showToast("تم نسخ رقم الجلوس"); }
  catch { showToast("تعذر النسخ تلقائيًا"); }
});
document.getElementById("printButton").addEventListener("click", () => window.print());
document.getElementById("newSearchButton").addEventListener("click", () => {
  hideResult(); hideMessage(); studentName.focus(); window.scrollTo({ top: document.getElementById("search").offsetTop - 30, behavior: "smooth" });
});

document.getElementById("menuBtn").addEventListener("click", () => document.getElementById("mobileNav").classList.toggle("open"));
document.querySelectorAll(".mobile-nav a").forEach(a => a.addEventListener("click", () => document.getElementById("mobileNav").classList.remove("open")));
