const express = require("express");
const axios = require("axios");
const { wrapper } = require("axios-cookiejar-support");
const { CookieJar } = require("tough-cookie");
const cheerio = require("cheerio");
const path = require("path");

const app = express();
const PORT = Number(process.env.PORT) || 3000;

const BASE_URL = "https://nataeji.moe.gov.ye";
const SEARCH_URL = `${BASE_URL}/seat-numbers/secondary/`;
const PROCESS_URL = `${BASE_URL}/seat-numbers/secondary/process/`;
const YEAR_OPTIONS = [
  "2025/2026", "2024/2025", "2023/2024", "2022/2023", "2021/2022",
  "2020/2021", "2019/2020", "2018/2019", "2017/2018", "2016/2017"
];

app.disable("x-powered-by");
app.use(express.json({ limit: "20kb" }));
app.use(express.urlencoded({ extended: false, limit: "20kb" }));
app.use(express.static(__dirname, { index: false }));

// Small in-memory guard to avoid accidental request floods. It resets automatically.
const requestLog = new Map();
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 12;

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizeArabicName(name) {
  return cleanText(name)
    .replace(/[إأآ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه");
}

function looksLikeFourPartName(name) {
  return cleanText(name).split(/\s+/).filter(Boolean).length >= 4;
}

function extractCsrf(html) {
  const $ = cheerio.load(html);
  return $('input[name="csrfmiddlewaretoken"]').attr("value") || null;
}

function absoluteUrl(url) {
  if (!url) return null;
  if (/^https?:\/\//i.test(url)) return url;
  return new URL(url, BASE_URL).toString();
}

function isAllowedYear(year) {
  return YEAR_OPTIONS.includes(year);
}

function rateLimited(ip) {
  const now = Date.now();
  const item = requestLog.get(ip);
  if (!item || now - item.start >= RATE_WINDOW_MS) {
    requestLog.set(ip, { start: now, count: 1 });
    return false;
  }
  item.count += 1;
  return item.count > RATE_LIMIT;
}

async function createOfficialClient(jar) {
  return wrapper(axios.create({
    jar,
    withCredentials: true,
    timeout: 25_000,
    maxRedirects: 5,
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; NataejiSeatSearch/2.0)",
      "Accept": "text/html,application/xhtml+xml,application/json,text/javascript,*/*;q=0.8"
    }
  }));
}

async function getResultHtml(resultUrl, jar) {
  const client = await createOfficialClient(jar);
  const response = await client.get(resultUrl, {
    headers: {
      "Referer": SEARCH_URL,
      "Accept": "text/html,application/xhtml+xml"
    }
  });
  return response.data;
}

function parseResult(html) {
  const $ = cheerio.load(html);
  const bodyText = cleanText($("body").text());

  if (/انتهت صلاحية النتائج|صلاحية النتائج/i.test(bodyText)) {
    return {
      success: false,
      code: "EXPIRED",
      message: "انتهت صلاحية نتيجة البحث، يرجى إجراء الاستعلام مرة أخرى."
    };
  }

  let seatNumber = null;
  let psn = null;
  let academicYear = null;
  let studentName = null;

  const seatMatch =
    bodyText.match(/رقم\s*الجلوس\s*[:：\-]?\s*([0-9٠-٩]+)/i) ||
    bodyText.match(/رقم\s*الجلوس[^0-9٠-٩]{0,30}([0-9٠-٩]+)/i);
  const psnMatch = bodyText.match(/\bPSN\s*[:：\-]?\s*([0-9٠-٩]+)/i);
  const yearMatch = bodyText.match(/العام\s*الدراسي\s*[:：\-]?\s*([0-9]{4}\s*\/\s*[0-9]{4})/i);
  const nameMatch = bodyText.match(/الاسم\s*[:：\-]?\s*(.+?)(?=\s+(?:رقم\s*الجلوس|العام\s*الدراسي|PSN)|$)/i);

  if (seatMatch) seatNumber = cleanText(seatMatch[1]);
  if (psnMatch) psn = cleanText(psnMatch[1]);
  if (yearMatch) academicYear = cleanText(yearMatch[1]);
  if (nameMatch) studentName = cleanText(nameMatch[1]);

  $("tr").each((_, row) => {
    const cells = $(row).find("th, td").map((__, el) => cleanText($(el).text())).get();
    if (cells.length < 2) return;
    const label = cells[0];
    const value = cells.slice(1).join(" ");
    if (!seatNumber && /رقم\s*الجلوس/i.test(label)) seatNumber = value;
    if (!psn && /PSN/i.test(label)) psn = value;
    if (!academicYear && /العام\s*الدراسي/i.test(label)) academicYear = value;
    if (!studentName && /^الاسم$/i.test(label)) studentName = value;
  });

  if (!seatNumber) {
    if (/لا توجد|لم يتم العثور|غير موجود|لا يوجد/i.test(bodyText)) {
      return { success: false, code: "NOT_FOUND", message: "لم يتم العثور على بيانات بهذا الاسم." };
    }
    return {
      success: false,
      code: "UNEXPECTED_RESPONSE",
      message: "وصلت استجابة غير متوقعة من الموقع الرسمي. حاول مرة أخرى لاحقًا."
    };
  }

  return {
    success: true,
    seat_number: seatNumber,
    psn,
    academic_year: academicYear,
    student_name: studentName
  };
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "nataeji-seat-search", version: "2.0.0" });
});

app.get("/api/years", (_req, res) => {
  res.json({ success: true, years: YEAR_OPTIONS });
});

app.post("/api/search", async (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || "unknown";
  if (rateLimited(ip)) {
    return res.status(429).json({
      success: false,
      code: "RATE_LIMIT",
      message: "تم تجاوز عدد المحاولات مؤقتًا. يرجى الانتظار دقيقة ثم المحاولة مرة أخرى."
    });
  }

  const academicYear = cleanText(req.body?.academic_year);
  const studentName = cleanText(req.body?.student_name);

  if (!isAllowedYear(academicYear)) {
    return res.status(400).json({ success: false, message: "يرجى اختيار عام دراسي صحيح." });
  }

  if (!studentName) {
    return res.status(400).json({ success: false, message: "يرجى إدخال الاسم الرباعي." });
  }

  if (!looksLikeFourPartName(studentName)) {
    return res.status(400).json({ success: false, message: "يرجى إدخال الاسم الرباعي كاملًا." });
  }

  if (studentName.length > 150) {
    return res.status(400).json({ success: false, message: "الاسم طويل جدًا." });
  }

  const jar = new CookieJar();
  const normalizedName = normalizeArabicName(studentName);

  try {
    const client = await createOfficialClient(jar);

    // 1) Get a fresh CSRF token and cookies from the official page.
    const pageResponse = await client.get(SEARCH_URL, {
      headers: { "Referer": BASE_URL }
    });
    const csrfToken = extractCsrf(pageResponse.data);

    if (!csrfToken) {
      return res.status(502).json({
        success: false,
        code: "CSRF_MISSING",
        message: "تعذر الحصول على رمز الحماية من الموقع الرسمي. حاول لاحقًا."
      });
    }

    // 2) Submit through the official process endpoint with the same session.
    const processResponse = await client.post(
      PROCESS_URL,
      new URLSearchParams({
        academic_year: academicYear,
        student_name: normalizedName,
        csrfmiddlewaretoken: csrfToken
      }).toString(),
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "X-CSRFToken": csrfToken,
          "X-Requested-With": "XMLHttpRequest",
          "Referer": SEARCH_URL,
          "Origin": BASE_URL,
          "Accept": "application/json, text/javascript, */*; q=0.01"
        },
        validateStatus: status => status >= 200 && status < 500
      }
    );

    if (processResponse.status === 403) {
      return res.status(502).json({
        success: false,
        code: "CSRF_FAILED",
        message: "رفض الموقع الرسمي الطلب بسبب الحماية. حاول مرة أخرى."
      });
    }

    const data = processResponse.data;

    if (!data || data.success !== true || !data.redirect_url) {
      const message = cleanText(data?.message || "");
      if (/لا توجد|لم يتم العثور|غير موجود/i.test(message)) {
        return res.status(404).json({
          success: false,
          code: "NOT_FOUND",
          message: "لم يتم العثور على بيانات بهذا الاسم."
        });
      }
      return res.status(502).json({
        success: false,
        code: "SEARCH_FAILED",
        message: "تعذر إكمال البحث من الموقع الرسمي. حاول مرة أخرى."
      });
    }

    // 3) Follow the official result URL using the same cookie session.
    const resultUrl = absoluteUrl(data.redirect_url);
    const resultHtml = await getResultHtml(resultUrl, jar);
    const result = parseResult(resultHtml);

    if (!result.success) {
      return res.status(result.code === "NOT_FOUND" ? 404 : 502).json(result);
    }

    return res.json(result);
  } catch (error) {
    if (error.code === "ECONNABORTED" || /timeout/i.test(error.message || "")) {
      return res.status(504).json({
        success: false,
        code: "TIMEOUT",
        message: "استغرق الاتصال بالموقع الرسمي وقتًا طويلًا. حاول مرة أخرى."
      });
    }

    if (error.response?.status === 403) {
      return res.status(502).json({
        success: false,
        code: "CSRF_FAILED",
        message: "رفض الموقع الرسمي الطلب بسبب الحماية. حاول مرة أخرى."
      });
    }

    console.error("Official site request failed:", error.message);
    return res.status(502).json({
      success: false,
      code: "OFFICIAL_SITE_UNAVAILABLE",
      message: "الموقع الرسمي غير متاح حاليًا أو حدث خطأ في الاتصال. حاول لاحقًا."
    });
  }
});

// SPA-style fallback without an Express 5 wildcard route.
app.use((_req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Nataeji seat search running on port ${PORT}`);
});
