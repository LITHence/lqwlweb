/**
 * ============================================================
 * LQWL Freedom — 领启未来 Web 门户
 * ============================================================
 * 
 * 【整体架构】
 * 
 *   浏览器 (本文件)  →  Cloudflare Worker (代理)  →  api.07future.com
 *        ↓                      ↓                         ↓
 *   React 前端             转发请求 + 注入 Cookie       领启未来后端
 * 
 * 【认证机制】
 * 领启未来后端是 Node.js + Express + express-session。
 * 认证方式是传统的 Cookie-based Session：
 *   - Cookie 名称: sessionID
 *   - Cookie 值格式: s%3A<session_id>.<hmac_signature>
 *     - s%3A 是 URL 编码的 "s:"，express-session 签名 cookie 的标识
 *     - "." 前面是 session ID
 *     - "." 后面是 HMAC-SHA256 签名（服务器用 secret 生成，防篡改）
 *   - 完整 Cookie Header: sessionID=s%3A...
 * 
 * 【数据流】
 * 1. 用户从平板提取 sessionID 值（通过 extract_cookie.sh）
 * 2. 前端把值存在 localStorage，每次请求通过 X-LQ-Cookie header 发给 Worker
 * 3. Worker 把 X-LQ-Cookie 转成标准 Cookie header，转发给 07future API
 * 4. API 响应原路返回
 * 
 * 【为什么不直接用 Cookie】
 * 浏览器的 Cookie 只能发给同域名。我们的网页在 xxx.pages.dev，
 * 不可能让浏览器自动带上 api.07future.com 的 Cookie。
 * 所以用自定义 header（X-LQ-Cookie）绕过这个限制。
 */

import { useState, useEffect, useCallback, useRef } from "react";

// ============================================================
// API 层
// ============================================================

/**
 * 创建 API 客户端
 * 
 * @param {string} workerUrl - Cloudflare Worker 的 URL
 * @param {string} cookie    - 完整的 Cookie header 值，格式: "sessionID=s%3A..."
 * 
 * 【设计模式：工厂函数】
 * createApi 不是一个 class，而是一个工厂函数（factory function）。
 * 它返回一个包含多个方法的对象。这种模式的好处：
 *   - workerUrl 和 cookie 通过闭包（closure）被所有方法共享
 *   - 不需要每次调用都传这两个参数
 *   - 调用方式简洁：api.getMe() 而不是 api.get("/api/v2/users/me", cookie)
 */
const createApi = (workerUrl, cookie) => {
  // 所有请求共享的 headers
  const headers = {
    "Content-Type": "application/json",
    "X-LQ-Cookie": cookie,  // 自定义 header，Worker 会把它转成 Cookie header
  };

  /**
   * 通用 GET 请求
   * async/await 是处理异步操作（如网络请求）的语法糖
   * 等价于 .then().catch() 链式调用，但可读性更好
   */
  const get = async (path) => {
    const res = await fetch(`${workerUrl}${path}`, { headers });
    if (!res.ok) throw new Error(`API ${res.status}: ${path}`);
    // 检查 Worker 是否返回了刷新后的 cookie（服务器 session 续期）
    const newCookie = res.headers.get("X-LQ-New-Cookie");
    if (newCookie) localStorage.setItem("lqwl_cookie", newCookie);
    return res.json();
  };

  /** 通用 POST 请求 */
  const post = async (path, body) => {
    const res = await fetch(`${workerUrl}${path}`, {
      method: "POST", headers, body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`API ${res.status}: ${path}`);
    return res.json();
  };

  /** 通用 PUT 请求 */
  const put = async (path, body) => {
    const opts = { method: "PUT", headers };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(`${workerUrl}${path}`, opts);
    if (!res.ok) throw new Error(`API ${res.status}: ${path}`);
    return res.json();
  };

  // 返回所有可用的 API 方法
  // 这些路径都是从 jadx 反编译 Api.java 得到的
  return {
    // -- 用户信息 --
    getMe: () => get("/api/v2/users/me"),
    getStudentInfo: (mac = "00:00:00:00:00:00") =>
      get(`/api/users/info/student?versionName=7.3.8&mac=${mac}`),
    getVip: () => get("/api/users/vip/vipInfo"),

    // -- 课程 --
    getSchedule: () => get("/api/course-schedule/get-active-table-by-student"),
    getCourseList: () => get("/api/course/my_course"),

    // -- 考勤 --
    getAttendanceSummary: () => get("/api/attendance/my-summary"),
    getAttendance: () => get("/api/attendance/my"),

    // -- 成绩 --
    getGrade: () => get("/api/students/grade"),
    getQuizResult: () => get("/api/quiz/quizResult/studyCore"),

    // -- 计划 --
    getPlanner: (status = "todo,doing,done") => get(`/api/planner?statuses=${status}`),
    postPlanner: (data) => post("/api/planner", data),

    // -- 单词 --
    getWordPlan: () => get("/api/word-plans/me"),
    getWordStats: () => get("/api/word-plan-stats/me"),
    getWordToday: () => get("/api/word-plan-today/me"),
    getWordRank: () => get("/api/word-plans/ranks"),

    // -- 番茄钟 --
    getTomatoStats: () => get("/api/planner-pomodoro-timer/statistics"),

    // -- 通知 --
    getNotifications: () => get("/api/notification/student/index"),

    // -- 请假 --
    getMyAbsence: () => get("/api/absence/my"),

    // -- 版本 --
    getVersion: () => get("/api/version-manager/pad-meta"),

    // -- 考试/作业 --
    // 列表（APP 固定传 3 天窗口的 startTime/endTime）
    getQuizAll: () => get("/api/quiz/byStudent"),
    getQuizByRange: (startTime, endTime) =>
      get(`/api/quiz/byStudent?startTime=${encodeURIComponent(startTime)}&endTime=${encodeURIComponent(endTime)}`),
    getQuizRecent: () => {
      // 模拟 APP 行为：往前推 7 天，往后推 3 天
      const s = new Date(); s.setDate(s.getDate() - 7); s.setHours(0,0,0,0);
      const e = new Date(); e.setDate(e.getDate() + 3); e.setHours(0,0,0,0);
      return get(`/api/quiz/byStudent?startTime=${encodeURIComponent(s.toISOString())}&endTime=${encodeURIComponent(e.toISOString())}`);
    },
    getQuizHomework: () => get("/api/quiz/byStudent?homeWork=true"),
    getQuizExam: () => get("/api/quiz/byStudent?homeWork=false"),
    // 分页接口
    getQuizPage: (page = 1, pageSize = 20) =>
      get(`/api/quiz/byStudent/pageView?page=${page}&pageSize=${pageSize}`),
    getQuizProgress: () => get("/api/quiz/get-homework-progress"),
    getQuizByCourse: (courseId) => get(`/api/quiz/byStudent/course?course_id=${courseId}`),

    // -- 考试/作业 动作 --
    // 拉取题目内容（同时会将 status 0→1）
    getQuizContent: (instantId) =>
      put(`/api/quiz/getConentAllSection?instant_id=${instantId}`),
    // 开始考试
    startQuiz: (instantId) => put("/api/quiz/startQuiz", { instant_id: instantId }),
    // 保存单题答案
    saveQuizOne: (instantId, contentId, answerKey, fileList = []) =>
      put("/api/quiz/saveQuizOne", {
        instant_id: instantId,
        content: contentId,
        answerKey: answerKey,
        aiGrade: 0.0,
        fileList: fileList,
      }),
    // 保存 AI 写作答案
    saveQuizOneAI: (instantId, contentId, answerKey) =>
      put("/api/quiz/saveQuizOne/ai", {
        instant_id: instantId,
        content: contentId,
        answerKey: answerKey,
        aiGrade: 0.0,
      }),
    // 提交作业
    submitQuiz: (instantId, feedback = "") =>
      put("/api/quiz/submitQuiz", { instant_id: instantId, feedback }),
    // -- 模考 (quCent) 专用端点 --
    getQuCentContent: (instantId) =>
      put(`/api/quiz/getConentAllSection/qucent/preload?instant_id=${instantId}`, {}),
    saveQuCentOne: (instantId, cIndex, answerKeys = [], fileList = []) =>
      put("/api/quiz/saveQuizOne/qucent", {
        instant_id: instantId, cIndex, answerKeys, fileList,
      }),
    submitQuCent: (instantId, feedback = "") =>
      put("/api/quiz/submitQuiz/quCent", { instant_id: instantId, feedback }),
    quCentTimeUsage: (instantId, cIndex, usage) =>
      post("/api/quiz/quCent/timeUsage", { instant_id: instantId, cIndex, usage }),
    getQuizInstant: (instantId) =>
      get(`/api/quiz/instant?instant_id=${instantId}`),
    getQuizStatusSync: (instantId) =>
      get(`/api/quiz/status/sync?instant_id=${instantId}`),
    // 获取上传 URL
    getUploadUrl: (ext = ".png") => get(`/api/users/uploadUrl?extend=${ext}`),
    // 通过 Worker 代理上传到 COS（绕过 CORS）
    proxyUpload: async (cosUrl, file) => {
      const res = await fetch(`${workerUrl}/upload-proxy`, {
        method: "PUT",
        headers: {
          "X-LQ-Cookie": cookie,
          "X-Upload-Url": cosUrl,
          "Content-Type": file.type || "application/octet-stream",
        },
        body: file,
      });
      return res;
    },
    // 获取已保存答案
    getSavedAnswers: (instantId) =>
      get(`/api/quiz/getSaveAnswers?instant_id=${instantId}`),

    // -- 管控分析（这些端点揭示了服务器下发的管控规则）--
    getAppRules: () => get("/api/black-box-application-constraint-groups"),
    getAppList: () => get("/api/black-box-applications"),
    getWhitelist: () => get("/api/system/StudentTerminalWebPageWhiteLists"),
    getTaskLobbies: () => get("/api/black-box-tasks"),
  };
};

// ============================================================
// Cookie 解析工具
// ============================================================

/**
 * 智能解析用户输入的 cookie/sessionID
 * 
 * 用户可能粘贴以下几种格式：
 *   1. 完整格式:  "sessionID=s%3A07jC07..."      → 直接使用
 *   2. 只有值:    "s%3A07jC07..."                 → 自动补上 "sessionID="
 *   3. 带空格/换行: "  sessionID=s%3A07jC07...\n" → trim 后处理
 *   4. extract_cookie.sh 输出: 直接就是格式 1
 * 
 * @param {string} input - 用户输入
 * @returns {string} 标准化的 cookie header 值
 */
function parseCookieInput(input) {
  const trimmed = input.trim();

  // 如果已经是 "sessionID=..." 格式，直接返回
  if (trimmed.startsWith("sessionID=")) {
    return trimmed;
  }

  // 如果是 "s%3A..." 或 "s:" 开头（用户只粘贴了值），补上 cookie 名
  if (trimmed.startsWith("s%3A") || trimmed.startsWith("s:")) {
    return `sessionID=${trimmed}`;
  }

  // 其他情况：假设整个输入就是 cookie 值
  return `sessionID=${trimmed}`;
}

/**
 * 从标准化的 cookie 字符串中提取 session ID 值（用于显示）
 * "sessionID=s%3A07jC07..." → "s%3A07jC07..."
 */
function extractSessionValue(cookie) {
  if (cookie.startsWith("sessionID=")) {
    return cookie.slice("sessionID=".length);
  }
  return cookie;
}

// ============================================================
// UI 组件
// ============================================================

/** 
 * 通用卡片组件
 * 
 * 【React 组件的 props】
 * { title, icon, children, loading, onRefresh } 是解构赋值（destructuring），
 * 从 props 对象中直接取出这几个属性。
 * children 是 React 特殊 prop，代表标签之间的内容：
 *   <Card title="xxx">这里的内容就是 children</Card>
 */
function Card({ title, icon, children, loading, onRefresh }) {
  return (
    <div style={{
      background: "var(--bg2)",
      border: "1px solid var(--border)",
      borderRadius: "12px",
      padding: "18px",
      position: "relative",
      minHeight: "100px",
      boxShadow: "0 1px 3px rgba(0,0,0,0.06)",
    }}>
      <div style={{
        display: "flex", justifyContent: "space-between",
        alignItems: "center", marginBottom: "14px",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <span style={{ fontSize: "15px" }}>{icon}</span>
          <span style={{ fontSize: "13px", fontWeight: 600 }}>{title}</span>
        </div>
        {onRefresh && (
          <button onClick={onRefresh} title="刷新" style={{
            background: "none", border: "none", color: "var(--text3)",
            cursor: "pointer", padding: "4px", fontSize: "14px",
          }}>↻</button>
        )}
      </div>
      {loading ? (
        <div style={{ textAlign: "center", padding: "20px", color: "var(--text3)" }}>
          <div style={{
            width: "18px", height: "18px", margin: "0 auto",
            border: "2px solid var(--border)", borderTopColor: "var(--accent)",
            borderRadius: "50%", animation: "spin 0.8s linear infinite",
          }} />
        </div>
      ) : children}
    </div>
  );
}

function Stat({ label, value, color }) {
  return (
    <div>
      <div style={{ fontSize: "11px", color: "var(--text3)", letterSpacing: "0.3px", marginBottom: "3px" }}>{label}</div>
      <div style={{ fontSize: "20px", fontWeight: 700, color: color || "var(--text)" }}>{value ?? "—"}</div>
    </div>
  );
}

function Tag({ children, color = "#c08552" }) {
  return (
    <span style={{
      display: "inline-block", padding: "2px 8px", borderRadius: "20px",
      fontSize: "11px", fontWeight: 500,
      background: `${color}18`, color: color,
    }}>{children}</span>
  );
}

function JsonPreview({ data, maxHeight = "50vh" }) {
  if (!data) return <div style={{ color: "var(--text3)", fontSize: "13px" }}>暂无数据</div>;
  return (
    <pre style={{
      fontSize: "11px", color: "var(--text2)", background: "var(--bg3)",
      padding: "14px", borderRadius: "8px", overflow: "auto",
      maxHeight, whiteSpace: "pre-wrap", margin: 0, lineHeight: 1.6,
    }}>
      {typeof data === "string" ? data : JSON.stringify(data, null, 2)}
    </pre>
  );
}

// ============================================================
// 设置页面 — 首次使用时显示
// ============================================================

/**
 * 【这个页面的职责】
 * 1. 让用户输入 Cloudflare Worker URL
 * 2. 让用户粘贴从 extract_cookie.sh 提取的 sessionID
 * 3. 测试连接是否成功
 * 4. 成功后保存到 localStorage 并进入主界面
 */
function SetupScreen({ onComplete }) {
  // useState 返回 [当前值, 设置函数]
  // localStorage.getItem 在首次渲染时读取之前保存的值（如果有的话）
  const [workerUrl, setWorkerUrl] = useState(localStorage.getItem("lqwl_worker") || "");
  const [sessionInput, setSessionInput] = useState(localStorage.getItem("lqwl_session_raw") || "");
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState(null);

  /**
   * 测试连接
   * 1. 把用户输入解析成标准 cookie 格式
   * 2. 发一个 /api/v2/users/me 请求
   * 3. 如果返回 200 + 用户数据，说明 cookie 有效
   */
  const handleTest = async () => {
    setTesting(true);
    setResult(null);
    try {
      const url = workerUrl.replace(/\/$/, ""); // 去掉末尾的 /
      const cookie = parseCookieInput(sessionInput);

      const res = await fetch(`${url}/api/v2/users/me`, {
        headers: { "Content-Type": "application/json", "X-LQ-Cookie": cookie },
      });

      if (res.ok) {
        const data = await res.json();
        // 保存到 localStorage（浏览器关闭后还在）
        localStorage.setItem("lqwl_worker", url);
        localStorage.setItem("lqwl_cookie", cookie);
        localStorage.setItem("lqwl_session_raw", sessionInput);
        setResult({
          ok: true,
          name: data.name || data.username || data.realName || "已连接",
          data,
        });
      } else {
        setResult({
          ok: false,
          msg: `HTTP ${res.status} — ${
            res.status === 401
              ? "Session 已过期，需要重新从平板提取"
              : "请检查 Worker URL"
          }`,
        });
      }
    } catch (e) {
      setResult({ ok: false, msg: e.message });
    }
    setTesting(false);
  };

  // ---- 输入框的通用样式（复用） ----
  const inputStyle = {
    width: "100%", padding: "12px 14px",
    background: "var(--bg3)",
    border: "1px solid var(--border)",
    borderRadius: "10px", color: "#fff", fontSize: "13px",
    outline: "none", boxSizing: "border-box",
    fontFamily: "var(--font)",
  };

  return (
    <div style={{
      minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center",
      background: "#0a0a0f",
      fontFamily: "var(--font-mono)", color: "var(--text)",
    }}>
      <div style={{
        width: "min(500px, 90vw)",
        background: "var(--bg3)",
        border: "1px solid var(--border)",
        borderRadius: "16px", padding: "36px 28px",
      }}>
        {/* 标题 */}
        <div style={{ textAlign: "center", marginBottom: "32px" }}>
          <div style={{
            fontSize: "28px", fontWeight: 700, letterSpacing: "-1px",
            color: "#c08552", marginBottom: "6px",
          }}>LQWL Freedom</div>
          <div style={{ fontSize: "12px", color: "var(--text3)", letterSpacing: "2px" }}>
            领启未来 · 自由门户
          </div>
        </div>

        {/* Worker URL 输入 */}
        <div style={{ marginBottom: "18px" }}>
          <label style={{
            fontSize: "11px", color: "var(--text2)", textTransform: "uppercase",
            letterSpacing: "1px", display: "block", marginBottom: "6px",
          }}>Worker URL</label>
          <input
            value={workerUrl}
            onChange={(e) => setWorkerUrl(e.target.value)}
            placeholder="https://lqwl-proxy.xxx.workers.dev"
            style={inputStyle}
          />
          <div style={{ fontSize: "11px", color: "var(--text3)", marginTop: "4px" }}>
            Cloudflare Worker 代理地址（cd worker && npx wrangler deploy 后获得）
          </div>
        </div>

        {/* Session ID 输入 */}
        <div style={{ marginBottom: "24px" }}>
          <label style={{
            fontSize: "11px", color: "var(--text2)", textTransform: "uppercase",
            letterSpacing: "1px", display: "block", marginBottom: "6px",
          }}>Session ID</label>
          <textarea
            value={sessionInput}
            onChange={(e) => setSessionInput(e.target.value)}
            placeholder={"粘贴以下任意格式:\nsessionID=s%3A07jC07L2b8...\n或只粘贴值:\ns%3A07jC07L2b8..."}
            rows={3}
            style={{ ...inputStyle, resize: "vertical" }}
          />
          <div style={{ fontSize: "11px", color: "var(--text3)", marginTop: "4px", lineHeight: "1.6" }}>
            从平板提取：<code style={{ color: "#c08552" }}>bash extract_cookie.sh</code>
            <br />
            存储位置：<code style={{ color: "#c08552" }}>
              okgo_cookie.xml → Java 序列化 → hex 解码
            </code>
          </div>
        </div>

        {/* 解析预览：让用户看到实际会发送什么 */}
        {sessionInput.trim() && (
          <div style={{
            marginBottom: "18px", padding: "10px 14px",
            background: "rgba(192,133,82,0.04)",
            border: "1px solid rgba(192,133,82,0.1)",
            borderRadius: "8px", fontSize: "11px", color: "#c08552",
            wordBreak: "break-all",
          }}>
            <span style={{ color: "var(--text2)" }}>将发送: </span>
            Cookie: {parseCookieInput(sessionInput)}
          </div>
        )}

        {/* 测试按钮 */}
        <button
          onClick={handleTest}
          disabled={testing || !workerUrl || !sessionInput}
          style={{
            width: "100%", padding: "13px", border: "none", borderRadius: "10px",
            background: testing ? "#222" : "#c08552",
            cursor: testing ? "wait" : "pointer",
            color: testing ? "#888" : "#0a0a0f",
            fontSize: "13px", fontWeight: 700, letterSpacing: "0.5px",
            fontFamily: "var(--font)",
            opacity: (!workerUrl || !sessionInput) ? 0.3 : 1,
            transition: "all 0.2s",
          }}
        >
          {testing ? "连接中..." : "测试连接"}
        </button>

        {/* 测试结果 */}
        {result && (
          <div style={{
            marginTop: "16px", padding: "14px", borderRadius: "10px", fontSize: "13px",
            background: result.ok ? "rgba(192,133,82,0.06)" : "rgba(255,80,80,0.06)",
            border: `1px solid ${result.ok ? "rgba(192,133,82,0.15)" : "rgba(255,80,80,0.15)"}`,
            color: result.ok ? "#c08552" : "#ff5050",
          }}>
            {result.ok ? (
              <>
                <div style={{ marginBottom: "10px" }}>✓ 连接成功 — {result.name}</div>
                <button
                  onClick={() => onComplete(
                    workerUrl.replace(/\/$/, ""),
                    parseCookieInput(sessionInput)
                  )}
                  style={{
                    width: "100%", padding: "10px",
                    background: "rgba(192,133,82,0.12)",
                    border: "1px solid rgba(192,133,82,0.25)",
                    borderRadius: "8px", color: "#c08552",
                    cursor: "pointer", fontSize: "13px", fontWeight: 600,
                    fontFamily: "var(--font)",
                  }}
                >
                  进入门户 →
                </button>
              </>
            ) : (
              <span>✗ {result.msg}</span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================================
// API 调试器 — 手动测试任意端点
// ============================================================

/**
 * 这个组件让你像 Postman 一样测试 API。
 * 预置了从 jadx 反编译出来的所有有用端点。
 */
function ApiDebugger({ workerUrl, cookie }) {
  const [method, setMethod] = useState("GET");
  const [path, setPath] = useState("/api/v2/users/me");
  const [body, setBody] = useState("");
  const [result, setResult] = useState(null);
  const [elapsed, setElapsed] = useState(null);
  const [fetching, setFetching] = useState(false);

  // 预置端点列表（全部来自 jadx 反编译的 Api.java）
  const presets = [
    { label: "用户信息", path: "/api/v2/users/me" },
    { label: "学生信息", path: "/api/users/info/student?versionName=7.3.8&mac=00:00:00:00:00:00" },
    { label: "课程表", path: "/api/course-schedule/get-active-table-by-student" },
    { label: "我的课程", path: "/api/course/my_course" },
    { label: "考勤汇总", path: "/api/attendance/my-summary" },
    { label: "考勤记录", path: "/api/attendance/my" },
    { label: "成绩", path: "/api/students/grade" },
    { label: "计划", path: "/api/planner?statuses=todo,doing,done" },
    { label: "单词统计", path: "/api/word-plan-stats/me" },
    { label: "今日单词", path: "/api/word-plan-today/me" },
    { label: "单词排行", path: "/api/word-plans/ranks" },
    { label: "通知", path: "/api/notification/student/index" },
    { label: "VIP", path: "/api/users/vip/vipInfo" },
    { label: "版本检查", path: "/api/version-manager/pad-meta" },
    { label: "应用限制规则", path: "/api/black-box-application-constraint-groups" },
    { label: "受管控应用", path: "/api/black-box-applications" },
    { label: "网页白名单", path: "/api/system/StudentTerminalWebPageWhiteLists" },
    { label: "任务大厅", path: "/api/black-box-tasks" },
    { label: "番茄钟统计", path: "/api/planner-pomodoro-timer/statistics" },
    { label: "请假记录", path: "/api/absence/my" },
    { label: "考试结果", path: "/api/quiz/quizResult/studyCore" },
    { label: "全部考试/作业", path: "/api/quiz/byStudent" },
    { label: "仅作业", path: "/api/quiz/byStudent?homeWork=true" },
    { label: "仅考试", path: "/api/quiz/byStudent?homeWork=false" },
    { label: "考试/作业(分页)", path: "/api/quiz/byStudent/pageView?page=1&pageSize=20" },
    { label: "作业进度", path: "/api/quiz/get-homework-progress" },
    { label: "按课程查quiz", path: "/api/quiz/byStudent/course?course_id=" },
    { label: "拉取题目(PUT)", path: "/api/quiz/getConentAllSection?instant_id=" },
    { label: "获取上传URL", path: "/api/users/uploadUrl?extend=.png" },
    { label: "AI错误颜色", path: "/api/quiz/ai-errorColor" },
    { label: "模考内容(PUT)", path: "/api/quiz/getConentAllSection/qucent/preload?instant_id=" },
    { label: "模考状态同步", path: "/api/quiz/status/sync?instant_id=" },
    { label: "模考实例", path: "/api/quiz/instant?instant_id=" },
  ];

  const send = async () => {
    setFetching(true);
    const t0 = performance.now();
    try {
      const opts = {
        method,
        headers: { "Content-Type": "application/json", "X-LQ-Cookie": cookie },
      };
      if (method !== "GET" && body.trim()) opts.body = body;

      const res = await fetch(`${workerUrl}${path}`, opts);
      const text = await res.text();
      setElapsed(Math.round(performance.now() - t0));
      try {
        setResult({ status: res.status, data: JSON.parse(text) });
      } catch {
        setResult({ status: res.status, data: text });
      }
    } catch (e) {
      setElapsed(Math.round(performance.now() - t0));
      setResult({ status: "ERR", data: e.message });
    }
    setFetching(false);
  };

  const inputStyle = {
    padding: "10px 12px", background: "var(--bg3)",
    border: "1px solid var(--border)", borderRadius: "8px",
    color: "#fff", fontSize: "13px", outline: "none",
    fontFamily: "var(--font)",
  };

  return (
    <Card title="API 调试器" icon="⚡">
      {/* 预置端点按钮 */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: "5px", marginBottom: "16px" }}>
        {presets.map((p) => (
          <button
            key={p.path}
            onClick={() => { setMethod("GET"); setPath(p.path); setBody(""); }}
            style={{
              padding: "4px 10px", borderRadius: "6px", fontSize: "11px",
              cursor: "pointer", fontFamily: "var(--font)",
              background: path === p.path ? "rgba(192,133,82,0.12)" : "rgba(255,255,255,0.03)",
              border: path === p.path ? "1px solid rgba(192,133,82,0.25)" : "1px solid var(--border)",
              color: path === p.path ? "#c08552" : "#888",
              transition: "all 0.15s",
            }}
          >{p.label}</button>
        ))}
      </div>

      {/* 请求构造器 */}
      <div style={{ display: "flex", gap: "8px", marginBottom: "12px" }}>
        <select value={method} onChange={(e) => setMethod(e.target.value)}
          style={{ ...inputStyle, color: "#c08552" }}>
          {["GET", "POST", "PUT", "PATCH", "DELETE"].map((m) => <option key={m}>{m}</option>)}
        </select>
        <input
          value={path} onChange={(e) => setPath(e.target.value)}
          placeholder="/api/..." style={{ ...inputStyle, flex: 1 }}
        />
        <button onClick={send} disabled={fetching} style={{
          ...inputStyle, background: "#c08552", color: "#0a0a0f",
          fontWeight: 700, cursor: "pointer", border: "none",
          opacity: fetching ? 0.5 : 1,
        }}>
          {fetching ? "..." : "发送"}
        </button>
      </div>

      {/* POST body 输入 */}
      {method !== "GET" && (
        <textarea
          value={body} onChange={(e) => setBody(e.target.value)}
          placeholder='{"key": "value"}' rows={4}
          style={{
            width: "100%", ...inputStyle, resize: "vertical",
            marginBottom: "12px", boxSizing: "border-box",
          }}
        />
      )}

      {/* 响应 */}
      {result && (
        <div>
          <div style={{ display: "flex", gap: "10px", alignItems: "center", marginBottom: "8px" }}>
            <Tag color={
              result.status === 200 ? "#c08552" :
              result.status < 400 ? "#fbbf24" : "#ff5050"
            }>
              {result.status}
            </Tag>
            {elapsed != null && (
              <span style={{ fontSize: "11px", color: "var(--text3)" }}>{elapsed}ms</span>
            )}
          </div>
          <JsonPreview data={result.data} />
        </div>
      )}
    </Card>
  );
}

// ============================================================
// 课表组件
// ============================================================

const DAY_LABELS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];

function ScheduleTable({ data }) {
  if (!data) return <div style={{ color: "var(--text3)", fontSize: "13px" }}>暂无数据</div>;

  const sections = data.sections || [];
  const slots = data.slots || [];
  const schoolDays = data.schoolDays || [0, 1, 2, 3, 4];

  if (!sections.length || !slots.length) {
    return (
      <div>
        <div style={{ color: "var(--text3)", fontSize: "12px", marginBottom: "10px" }}>
          课表结构未识别，显示原始数据：
        </div>
        <JsonPreview data={data} maxHeight="400px" />
      </div>
    );
  }

  // Build grid: grid[section][day] = { name, teacher, room }
  const grid = {};
  slots.forEach(slot => {
    const { day, section: sec, items } = slot;
    if (!items || items.length === 0) return;
    const item = items[0];
    let name, teacher, room;

    if (item.type === "课程" && item.course) {
      name = shortCourseName(item.course.name || item.course.discrption || "");
      teacher = item.teacher?.name || "";
      room = item.classRoom?.name || "";
    } else if (item.type === "选修组") {
      // Elective group: show group name + first elective's details
      const el = item.electives?.[0];
      name = item.name || el?.course?.name || "选修";
      teacher = el?.teacher?.name || "";
      room = el?.classRoom?.name || "";
    } else {
      name = item.name || item.course?.name || "";
      teacher = item.teacher?.name || "";
    }

    if (name) {
      if (!grid[sec]) grid[sec] = {};
      grid[sec][day] = { name, teacher, room: shortCourseName(room) };
    }
  });

  // Filter out empty sections (no classes any day)
  const activeSections = sections
    .map((s, i) => ({ ...s, idx: i }))
    .filter(s => schoolDays.some(d => grid[s.idx]?.[d]));

  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px" }}>
        <thead>
          <tr>
            <th style={thStyle}>时间</th>
            {schoolDays.map(d => <th key={d} style={thStyle}>{DAY_LABELS[d]}</th>)}
          </tr>
        </thead>
        <tbody>
          {activeSections.map(sec => (
            <tr key={sec.idx}>
              <td style={{ ...tdStyle, textAlign: "center", whiteSpace: "nowrap", width: "80px" }}>
                <div style={{ fontWeight: 500, color: "var(--text)" }}>{sec.title}</div>
                <div style={{ fontSize: "10px", color: "var(--text3)" }}>{sec.startTime}–{sec.endTime}</div>
              </td>
              {schoolDays.map(d => {
                const cell = grid[sec.idx]?.[d];
                return (
                  <td key={d} style={{
                    ...tdStyle,
                    background: cell ? "var(--bg3)" : "transparent",
                    borderRadius: cell ? "4px" : 0,
                  }}>
                    {cell && (
                      <div>
                        <div style={{ fontWeight: 500, color: "var(--text)", marginBottom: "1px" }}>
                          {cell.name}
                        </div>
                        {cell.teacher && (
                          <div style={{ fontSize: "10px", color: "var(--text3)" }}>{cell.teacher}</div>
                        )}
                      </div>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const thStyle = {
  padding: "10px 8px", textAlign: "left", fontWeight: 600,
  borderBottom: "2px solid var(--border)", color: "var(--text2)", fontSize: "12px",
};
const tdStyle = {
  padding: "10px 8px", borderBottom: "1px solid var(--border)",
  verticalAlign: "top", minWidth: "100px",
};

// ============================================================
// 考试/作业面板
// ============================================================

/**
 * 考试/作业类型的中文映射和颜色
 */
const QUIZ_TYPE_MAP = {
  "custom-subject":   { label: "自定义", color: "#8b8bf5" },
  "quCent-homework":  { label: "模考作业", color: "#f59e0b" },
  "quCent-exam":      { label: "模考", color: "#ef4444" },
  "quCent-typeIn":    { label: "模考录入", color: "#f97316" },
  "ai-writing":       { label: "AI写作", color: "#22d3ee" },
  "ai-speaking":      { label: "AI口语", color: "#a78bfa" },
  "toefl":            { label: "托福", color: "#3b82f6" },
  "ielts":            { label: "雅思", color: "#10b981" },
  "ielts-ai-writing": { label: "雅思AI写作", color: "#34d399" },
};

const STATUS_MAP = {
  "0": { label: "未开始", color: "var(--text3)", bg: "rgba(85,85,85,0.12)" },
  "1": { label: "进行中", color: "#fbbf24", bg: "rgba(251,191,36,0.1)" },
  "2": { label: "已提交", color: "#22d3ee", bg: "rgba(34,211,238,0.1)" },
  "3": { label: "已完成", color: "#c08552", bg: "rgba(192,133,82,0.1)" },
};

/**
 * 计算截止时间的紧急程度
 * @returns {{ label: string, color: string, urgent: boolean }}
 */
function getDeadlineInfo(endTime) {
  if (!endTime) return null;
  const now = new Date();
  const end = new Date(endTime);
  const diff = end - now;

  if (diff < 0) return { label: "已截止", color: "var(--text3)", urgent: false };
  if (diff < 3600000) return { label: `${Math.ceil(diff / 60000)}分钟`, color: "#ef4444", urgent: true };
  if (diff < 86400000) return { label: `${Math.ceil(diff / 3600000)}小时`, color: "#f59e0b", urgent: true };
  if (diff < 86400000 * 3) return { label: `${Math.ceil(diff / 86400000)}天`, color: "#fbbf24", urgent: false };
  return { label: `${Math.ceil(diff / 86400000)}天`, color: "var(--text3)", urgent: false };
}

/**
 * 从课程名中提取简短科目名
 * "高一AL1班雅思听力" → "雅思听力"
 */
function shortCourseName(name) {
  if (!name) return "未分类";
  return name.replace(/^高一[A-Z0-9]+班/, "").replace(/^PBR-EBC\s*/, "") || name;
}

/**
 * 将 Quill delta JSON 转为简单 HTML
 */
function deltaToHtml(deltaStr) {
  try {
    const { ops } = JSON.parse(deltaStr);
    if (!ops) return "";
    return ops.map(op => {
      if (typeof op.insert === "string") {
        let text = op.insert.replace(/&/g, "&amp;").replace(/</g, "&lt;");
        text = text.replace(/\n/g, "<br>");
        const attr = op.attributes || {};
        if (attr.bold) text = `<strong>${text}</strong>`;
        if (attr.color) text = `<span style="color:${attr.color}">${text}</span>`;
        if (attr.background) text = `<mark style="background:${attr.background};padding:1px 3px;border-radius:2px">${text}</mark>`;
        return text;
      }
      if (op.insert?.image) {
        return `<img src="${op.insert.image}" style="max-width:100%;border-radius:8px;margin:8px 0" />`;
      }
      return "";
    }).join("");
  } catch { return ""; }
}

/**
 * 文件图标
 */
function fileIcon(type) {
  if (!type) return "📄";
  if (type.includes("audio")) return "🔊";
  if (type.includes("pdf")) return "📕";
  if (type.includes("word") || type.includes("document")) return "📘";
  if (type.includes("image")) return "🖼";
  if (type.includes("video")) return "🎬";
  return "📄";
}

/**
 * 作答工作区 — 加载题目、填写答案、上传图片、提交
 */
function QuizWorkspace({ quiz, api, onClose, onSubmitted }) {
  const [content, setContent] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [answers, setAnswers] = useState({});
  const [feedback, setFeedback] = useState("");
  const [error, setError] = useState(null);
  const [uploadingFor, setUploadingFor] = useState(null);
  const [statusMsg, setStatusMsg] = useState("");

  const instantId = quiz._id;
  const isQuCent = (quiz.type || "").startsWith("quCent");

  // 加载题目
  useEffect(() => {
    (async () => {
      try {
        setLoading(true);
        const data = isQuCent
          ? await api.getQuCentContent(instantId)
          : await api.getQuizContent(instantId);
        setContent(data);
        // 预填已保存答案
        if (isQuCent && Array.isArray(data.answers)) {
          const pre = {};
          data.answers.forEach(a => {
            pre[a.cIndex] = { answerKey: (a.answerKeys || []).join("\n"), fileList: a.fileList || [] };
          });
          setAnswers(pre);
        } else if (data.savedAnswers) {
          const pre = {};
          for (const [cid, ans] of Object.entries(data.savedAnswers)) {
            pre[cid] = { answerKey: ans.answerKey || "", fileList: ans.fileList || [] };
          }
          setAnswers(pre);
        }
      } catch (e) {
        setError(e.message);
      } finally {
        setLoading(false);
      }
    })();
  }, [instantId, api, isQuCent]);

  // 保存单题
  const saveOne = async (contentId) => {
    const ans = answers[contentId] || { answerKey: "", fileList: [] };
    setSaving(true); setStatusMsg("保存中…");
    try {
      if (isQuCent) {
        const keys = ans.answerKey ? ans.answerKey.split("\n").filter(Boolean) : [];
        await api.saveQuCentOne(instantId, contentId, keys, ans.fileList);
      } else {
        await api.saveQuizOne(instantId, contentId, ans.answerKey, ans.fileList);
      }
      setStatusMsg("✓ 已保存");
    } catch (e) { setStatusMsg("保存失败: " + e.message); }
    finally { setSaving(false); }
  };

  // 上传图片（通过 Worker 代理解决 CORS）
  const handleImageUpload = async (contentId, file) => {
    try {
      setUploadingFor(contentId);
      setStatusMsg("获取上传链接…");
      const ext = "." + (file.name.split(".").pop() || "png");
      const urlData = await api.getUploadUrl(ext);

      setStatusMsg("上传中…");
      const uploadRes = await api.proxyUpload(urlData.uploadURL, file);
      if (!uploadRes.ok) throw new Error("上传失败 " + uploadRes.status);

      const fileEntry = {
        name: file.name || "学生作答图片",
        url: urlData.imageURL,
        fileType: file.type,
        size: file.size,
      };
      const newFileList = [...(answers[contentId]?.fileList || []), fileEntry];
      setAnswers(prev => ({
        ...prev,
        [contentId]: { answerKey: prev[contentId]?.answerKey || "", fileList: newFileList },
      }));
      if (isQuCent) {
        await api.saveQuCentOne(instantId, contentId, [], newFileList);
      } else {
        await api.saveQuizOne(instantId, contentId, answers[contentId]?.answerKey || "", newFileList);
      }
      setStatusMsg("✓ 图片已上传并保存");
    } catch (e) {
      setStatusMsg("上传失败: " + e.message);
    } finally { setUploadingFor(null); }
  };

  // 提交
  const handleSubmit = async () => {
    if (!confirm("确认提交？提交后无法修改。")) return;
    setSubmitting(true); setStatusMsg("提交中…");
    try {
      if (isQuCent) {
        // 保存所有有内容的答案
        const qcQuestions = content?.quiz?.quCentQuestionExtends || [];
        for (const q of qcQuestions) {
          const ans = answers[q.cIndex];
          if (ans && (ans.answerKey || ans.fileList?.length)) {
            const keys = ans.answerKey ? ans.answerKey.split("\n").filter(Boolean) : [];
            await api.saveQuCentOne(instantId, q.cIndex, keys, ans.fileList || []);
          }
        }
        await api.submitQuCent(instantId, feedback);
      } else {
        const sections = content?.quiz?.sections || [];
        for (const sec of sections) {
          for (const item of sec.content || []) {
            const cid = item.content?._id;
            if (cid && answers[cid] && (answers[cid].answerKey || answers[cid].fileList?.length)) {
              await api.saveQuizOne(instantId, cid, answers[cid].answerKey, answers[cid].fileList || []);
            }
          }
        }
        await api.submitQuiz(instantId, feedback);
      }
      setStatusMsg("✓ 提交成功！");
      setTimeout(() => onSubmitted?.(), 1000);
    } catch (e) { setStatusMsg("提交失败: " + e.message); }
    finally { setSubmitting(false); }
  };

  const removeFile = (contentId, idx) => {
    setAnswers(prev => ({
      ...prev,
      [contentId]: {
        ...prev[contentId],
        fileList: (prev[contentId]?.fileList || []).filter((_, i) => i !== idx),
      },
    }));
  };

  const sty = {
    overlay: {
      position: "fixed", inset: 0, zIndex: 1000,
      background: "var(--bg)", overflow: "auto",
      display: "flex", flexDirection: "column",
      fontFamily: "var(--font)",
    },
    header: {
      padding: "14px 20px", borderBottom: "1px solid var(--border)",
      display: "flex", alignItems: "center", gap: "12px",
      background: "var(--bg2)", position: "sticky", top: 0, zIndex: 10,
    },
    body: { flex: 1, padding: "20px", display: "flex", flexDirection: "column", gap: "16px", maxWidth: "800px", margin: "0 auto", width: "100%" },
    card: {
      background: "var(--bg2)", border: "1px solid var(--border)",
      borderRadius: "12px", padding: "16px",
    },
    textarea: {
      width: "100%", minHeight: "120px", padding: "12px",
      background: "var(--bg3)", border: "1px solid var(--border)",
      borderRadius: "8px", color: "var(--text)", fontSize: "13px",
      fontFamily: "var(--font)",
      resize: "vertical", outline: "none", boxSizing: "border-box",
    },
    btn: (color = "#c08552", disabled = false) => ({
      padding: "8px 16px", borderRadius: "8px", fontSize: "12px",
      fontFamily: "var(--font)", cursor: disabled ? "not-allowed" : "pointer",
      border: `1px solid ${color}33`, background: disabled ? "rgba(255,255,255,0.02)" : `${color}15`,
      color: disabled ? "#555" : color, opacity: disabled ? 0.5 : 1, transition: "all 0.15s",
    }),
  };

  const sections = content?.quiz?.sections || [];
  const submitTypes = content?.quiz?.submitTypes || [];
  const isSubmitted = content?.status === "2" || content?.status === "3";
  const quizTitle = content?.quiz?.title || content?.quiz?.name || quiz.quiz?.title || "作业";
  const teacher = content?.quiz?.teacher || "";
  const quCentQuestions = content?.quiz?.quCentQuestionExtends || [];
  const paperUrl = content?.quiz?.renderDataUrl || "";

  return (
    <div style={sty.overlay}>
      {/* 顶栏 */}
      <div style={sty.header}>
        <button onClick={onClose} style={{ background: "none", border: "none", color: "var(--text2)", fontSize: "20px", cursor: "pointer", padding: "4px 8px" }}>←</button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: "14px", color: "var(--text)", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {quizTitle}
          </div>
          <div style={{ fontSize: "11px", color: "var(--text3)", marginTop: "2px" }}>
            {shortCourseName(quiz.course_id?.name)}
            {teacher && ` · ${teacher}`}
            {isSubmitted && " · ✓ 已提交"}
          </div>
        </div>
        {statusMsg && (
          <span style={{
            fontSize: "11px", padding: "4px 10px", borderRadius: "6px", flexShrink: 0,
            background: statusMsg.includes("✓") ? "rgba(192,133,82,0.1)" : statusMsg.includes("失败") ? "rgba(239,68,68,0.1)" : "rgba(255,255,255,0.05)",
            color: statusMsg.includes("✓") ? "#c08552" : statusMsg.includes("失败") ? "#ef4444" : "#888",
          }}>{statusMsg}</span>
        )}
      </div>

      {/* 内容 */}
      <div style={sty.body}>
        {loading && <div style={{ color: "var(--text2)", textAlign: "center", padding: "60px" }}>加载题目中…</div>}
        {error && <div style={{ color: "#ef4444", textAlign: "center", padding: "40px" }}>{error}</div>}

        {!loading && !error && isQuCent && (
          <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
            {paperUrl && (
              <div style={sty.card}>
                <div style={{ fontSize: "11px", color: "var(--text3)", marginBottom: "8px" }}>试卷原件</div>
                <a href={paperUrl} target="_blank" rel="noopener"
                  style={{ color: "var(--accent)", fontSize: "13px", textDecoration: "none" }}>
                  📄 查看试卷 →
                </a>
              </div>
            )}
            {quCentQuestions.map((q) => {
              const cid = q.cIndex;
              const ans = answers[cid] || { answerKey: "", fileList: [] };
              return (
                <div key={cid} style={sty.card}>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "10px", flexWrap: "wrap", gap: "4px" }}>
                    <span style={{ fontSize: "13px", fontWeight: 600, color: "var(--text)" }}>
                      题 {cid}
                    </span>
                    <span style={{ fontSize: "11px", color: "var(--text3)" }}>
                      {q.qType} · {q.maxScore}分
                    </span>
                  </div>
                  <textarea
                    value={ans.answerKey}
                    onChange={e => setAnswers(prev => ({
                      ...prev,
                      [cid]: { answerKey: e.target.value, fileList: prev[cid]?.fileList || [] },
                    }))}
                    placeholder={isSubmitted ? "（已提交）" : "输入答案…"}
                    disabled={isSubmitted}
                    style={sty.textarea}
                  />
                  {ans.fileList?.length > 0 && (
                    <div style={{ display: "flex", gap: "8px", marginTop: "10px", flexWrap: "wrap" }}>
                      {ans.fileList.map((f, fi) => (
                        <div key={fi} style={{ position: "relative" }}>
                          <img src={f.url} alt={f.name} style={{
                            width: "80px", height: "80px", borderRadius: "8px", objectFit: "cover",
                            border: "1px solid var(--border)",
                          }} />
                          {!isSubmitted && (
                            <button onClick={() => removeFile(cid, fi)} style={{
                              position: "absolute", top: "-6px", right: "-6px",
                              width: "18px", height: "18px", borderRadius: "50%",
                              background: "#ef4444", border: "none", color: "#fff",
                              fontSize: "10px", cursor: "pointer", lineHeight: "18px", textAlign: "center",
                            }}>✕</button>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                  {!isSubmitted && (
                    <div style={{ display: "flex", gap: "8px", marginTop: "12px" }}>
                      <button onClick={() => saveOne(cid)} disabled={saving} style={sty.btn("#c08552", saving)}>
                        {saving ? "保存中…" : "💾 保存"}
                      </button>
                      <label style={{ ...sty.btn("#22d3ee", !!uploadingFor), display: "inline-flex", alignItems: "center", gap: "4px", cursor: uploadingFor ? "not-allowed" : "pointer" }}>
                        {uploadingFor === cid ? "上传中…" : "📷 上传图片"}
                        <input type="file" accept="image/*" style={{ display: "none" }} disabled={!!uploadingFor}
                          onChange={e => { const f = e.target.files?.[0]; if (f) handleImageUpload(cid, f); e.target.value = ""; }} />
                      </label>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {!loading && !error && !isQuCent && sections.map((sec, si) => (
          <div key={si} style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
            {sections.length > 1 && (
              <div style={{ fontSize: "12px", color: "#c08552", fontWeight: 600 }}>
                Section {sec.sectionNumber}: {sec.title}
              </div>
            )}

            {(sec.content || []).map((item, qi) => {
              const c = item.content || {};
              const cid = c._id;
              const ans = answers[cid] || { answerKey: "", fileList: [] };
              const deltaHtml = deltaToHtml(c.delta);
              const attachedFiles = c.files || [];

              return (
                <div key={cid || qi} style={sty.card}>
                  {/* 题号 + 提交类型 */}
                  <div style={{ fontSize: "11px", color: "var(--text3)", marginBottom: "10px", display: "flex", justifyContent: "space-between" }}>
                    <span>第 {qi + 1} 题</span>
                    {submitTypes.length > 0 && (
                      <span style={{ color: "var(--text3)" }}>
                        提交方式: {submitTypes.join(" / ")}
                      </span>
                    )}
                  </div>

                  {/* 题目内容（Quill delta 渲染） */}
                  {deltaHtml && (
                    <div
                      dangerouslySetInnerHTML={{ __html: deltaHtml }}
                      style={{
                        fontSize: "13px", color: "var(--text)", lineHeight: 1.8,
                        marginBottom: "14px", wordBreak: "break-word",
                      }}
                    />
                  )}

                  {/* 附件列表 */}
                  {attachedFiles.length > 0 && (
                    <div style={{
                      marginBottom: "14px", padding: "12px",
                      background: "var(--bg3)",
                      borderRadius: "8px", border: "1px solid var(--border)",
                    }}>
                      <div style={{ fontSize: "10px", color: "var(--text3)", marginBottom: "8px", letterSpacing: "0.5px" }}>
                        附件 ({attachedFiles.length})
                      </div>
                      <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                        {attachedFiles.map((f, fi) => (
                          <div key={fi} style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                            <a
                              href={f.url}
                              target="_blank"
                              rel="noopener"
                              style={{
                                display: "flex", alignItems: "center", gap: "8px",
                                color: "#88b4e7", fontSize: "12px", textDecoration: "none",
                              }}
                            >
                              <span>{fileIcon(f.fileType)}</span>
                              <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.name}</span>
                              <span style={{ color: "var(--text3)", fontSize: "10px", flexShrink: 0 }}>
                                {f.size ? `${(f.size / 1024 / 1024).toFixed(1)}MB` : ""}
                              </span>
                            </a>
                            {/* 内嵌音频播放器 */}
                            {f.fileType?.includes("audio") && (
                              <audio controls preload="none" style={{ width: "100%", height: "32px", marginTop: "2px" }}>
                                <source src={f.url} type={f.fileType} />
                              </audio>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* 参考答案 */}
                  {c.answerText && c.answerText !== "?" && (
                    <details style={{ marginBottom: "12px" }}>
                      <summary style={{ fontSize: "11px", color: "var(--text3)", cursor: "pointer" }}>参考答案</summary>
                      <div style={{ fontSize: "12px", color: "var(--text2)", marginTop: "6px", padding: "8px", background: "var(--bg3)", borderRadius: "6px" }}>
                        {c.answerText}
                      </div>
                    </details>
                  )}

                  {/* 文字答案输入 */}
                  <textarea
                    value={ans.answerKey}
                    onChange={e => setAnswers(prev => ({
                      ...prev,
                      [cid]: { answerKey: e.target.value, fileList: prev[cid]?.fileList || [] },
                    }))}
                    placeholder={isSubmitted ? "（已提交）" : "输入答案…"}
                    disabled={isSubmitted}
                    style={sty.textarea}
                  />

                  {/* 已上传图片 */}
                  {ans.fileList?.length > 0 && (
                    <div style={{ display: "flex", gap: "8px", marginTop: "10px", flexWrap: "wrap" }}>
                      {ans.fileList.map((f, fi) => (
                        <div key={fi} style={{ position: "relative" }}>
                          <img src={f.url} alt={f.name} style={{
                            width: "80px", height: "80px", borderRadius: "8px", objectFit: "cover",
                            border: "1px solid var(--border)",
                          }} />
                          {!isSubmitted && (
                            <button onClick={() => removeFile(cid, fi)} style={{
                              position: "absolute", top: "-6px", right: "-6px",
                              width: "18px", height: "18px", borderRadius: "50%",
                              background: "#ef4444", border: "none", color: "#fff",
                              fontSize: "10px", cursor: "pointer", lineHeight: "18px", textAlign: "center",
                            }}>✕</button>
                          )}
                        </div>
                      ))}
                    </div>
                  )}

                  {/* 操作按钮 */}
                  {!isSubmitted && (
                    <div style={{ display: "flex", gap: "8px", marginTop: "12px", alignItems: "center" }}>
                      <button onClick={() => saveOne(cid)} disabled={saving} style={sty.btn("#c08552", saving)}>
                        {saving ? "保存中…" : "💾 保存"}
                      </button>
                      <label style={{ ...sty.btn("#22d3ee", !!uploadingFor), display: "inline-flex", alignItems: "center", gap: "4px", cursor: uploadingFor ? "not-allowed" : "pointer" }}>
                        {uploadingFor === cid ? "上传中…" : "📷 上传图片"}
                        <input type="file" accept="image/*" style={{ display: "none" }} disabled={!!uploadingFor}
                          onChange={e => { const f = e.target.files?.[0]; if (f) handleImageUpload(cid, f); e.target.value = ""; }} />
                      </label>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ))}

        {/* 提交区 */}
        {!loading && !error && !isSubmitted && (
          <div style={{ ...sty.card, borderColor: "rgba(192,133,82,0.12)", background: "rgba(192,133,82,0.03)" }}>
            <div style={{ fontSize: "11px", color: "var(--text3)", marginBottom: "8px" }}>提交反馈（选填）</div>
            <input value={feedback} onChange={e => setFeedback(e.target.value)}
              placeholder="写点什么给老师…"
              style={{ ...sty.textarea, minHeight: "40px", marginBottom: "12px" }} />
            <button onClick={handleSubmit} disabled={submitting}
              style={{ ...sty.btn("#c08552", submitting), padding: "12px 24px", fontSize: "14px", fontWeight: 600, width: "100%", textAlign: "center" }}>
              {submitting ? "提交中…" : "✓ 提交作业"}
            </button>
          </div>
        )}

        {/* 已提交状态 */}
        {!loading && !error && isSubmitted && (
          <div style={{ ...sty.card, borderColor: "rgba(34,211,238,0.12)", background: "rgba(34,211,238,0.03)", textAlign: "center" }}>
            <div style={{ fontSize: "14px", color: "#22d3ee", fontWeight: 600 }}>✓ 已提交</div>
            {content?.feedback && <div style={{ fontSize: "12px", color: "var(--text2)", marginTop: "6px" }}>反馈: {content.feedback}</div>}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * 考试/作业面板组件
 */
function QuizPanel({ quizData, loading, error, onRefresh, api }) {
  const [statusFilter, setStatusFilter] = useState("all");
  const [typeFilter, setTypeFilter] = useState("all");
  const [courseFilter, setCourseFilter] = useState("all");
  const [hwFilter, setHwFilter] = useState("all"); // all / homework / exam
  const [sortBy, setSortBy] = useState("deadline"); // deadline / grade / name
  const [searchText, setSearchText] = useState("");
  const [expandedId, setExpandedId] = useState(null);
  const [viewLimit, setViewLimit] = useState(30);
  const [activeQuiz, setActiveQuiz] = useState(null); // 打开作答工作区的 quiz

  const data = quizData || [];

  // ---- 数据未就绪时的占位 ----
  if (!quizData && !loading) {
    return (
      <Card title="考试/作业" icon="📝" onRefresh={onRefresh}>
        <div style={{ color: "var(--text2)", fontSize: "12px", lineHeight: 1.8 }}>
          {error ? (
            <>
              <div style={{ color: "#ff5050", marginBottom: "8px" }}>加载失败: {error}</div>
              <div style={{ color: "var(--text3)" }}>
                请检查：API 端点 <code style={{ color: "#c08552" }}>/api/quiz/byStudent</code> 是否可用，
                或点击右上角刷新重试。
              </div>
              <div style={{ color: "var(--text3)", marginTop: "8px" }}>
                调试建议：切到 API 调试 tab，手动测试该端点看返回结构。
              </div>
            </>
          ) : (
            <div>暂无数据，点击刷新加载</div>
          )}
        </div>
      </Card>
    );
  }

  if (loading && !quizData) {
    return (
      <Card title="考试/作业" icon="📝" loading={true} />
    );
  }

  // ---- 统计 ----
  const stats = {
    total: data.length,
    completed: data.filter(r => r.status === "3").length,
    inProgress: data.filter(r => r.status === "1").length,
    pending: data.filter(r => r.status === "0").length,
    submitted: data.filter(r => r.status === "2").length,
    homework: data.filter(r => r.homeWork).length,
    exam: data.filter(r => !r.homeWork).length,
  };

  const graded = data.filter(r => r.grade != null && r.grade >= 0 && r.status === "3");
  stats.avgGrade = graded.length > 0
    ? (graded.reduce((s, r) => s + r.grade, 0) / graded.length).toFixed(1)
    : "—";
  stats.completionRate = stats.total > 0
    ? ((stats.completed / stats.total) * 100).toFixed(0)
    : "—";

  // ---- 提取课程列表 ----
  const courses = [...new Set(
    data.map(r => r.course_id?.name).filter(Boolean)
  )].sort();

  // ---- 提取类型列表 ----
  const types = [...new Set(data.map(r => r.type))].sort();

  // ---- 过滤 ----
  let filtered = data;
  if (statusFilter !== "all") filtered = filtered.filter(r => r.status === statusFilter);
  if (typeFilter !== "all") filtered = filtered.filter(r => r.type === typeFilter);
  if (courseFilter !== "all") filtered = filtered.filter(r => r.course_id?.name === courseFilter);
  if (hwFilter === "homework") filtered = filtered.filter(r => r.homeWork);
  if (hwFilter === "exam") filtered = filtered.filter(r => !r.homeWork);
  if (searchText.trim()) {
    const q = searchText.trim().toLowerCase();
    filtered = filtered.filter(r =>
      (r.quiz?.title || r.quiz?.name || "").toLowerCase().includes(q) ||
      (r.course_id?.name || "").toLowerCase().includes(q)
    );
  }

  // ---- 排序 ----
  filtered = [...filtered].sort((a, b) => {
    if (sortBy === "deadline") {
      return new Date(b.quizEndTime || 0) - new Date(a.quizEndTime || 0);
    }
    if (sortBy === "grade") {
      return (b.grade ?? -1) - (a.grade ?? -1);
    }
    return (a.quiz?.title || "").localeCompare(b.quiz?.title || "", "zh-CN");
  });

  const shown = filtered.slice(0, viewLimit);

  // ---- 筛选按钮通用样式 ----
  const filterBtn = (active) => ({
    padding: "4px 10px", borderRadius: "6px", fontSize: "11px",
    cursor: "pointer", fontFamily: "var(--font)",
    border: active ? "1px solid rgba(192,133,82,0.3)" : "1px solid var(--border)",
    background: active ? "rgba(192,133,82,0.12)" : "var(--bg3)",
    color: active ? "#c08552" : "var(--text2)",
    transition: "all 0.15s", whiteSpace: "nowrap",
  });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
      {/* ---- 统计卡片 ---- */}
      <div style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))",
        gap: "10px",
      }}>
        {[
          { label: "总计", value: stats.total, color: "var(--text)" },
          { label: "完成率", value: `${stats.completionRate}%`, color: "#c08552" },
          { label: "平均分", value: stats.avgGrade, color: "#22d3ee" },
          { label: "进行中", value: stats.inProgress, color: "#fbbf24" },
          { label: "未开始", value: stats.pending, color: "var(--text2)" },
          { label: "考试", value: stats.exam, color: "#ef4444" },
        ].map((s, i) => (
          <div key={i} style={{
            background: "var(--bg2)",
            border: "1px solid var(--border)",
            borderRadius: "10px", padding: "14px 16px",
          }}>
            <div style={{ fontSize: "10px", color: "var(--text3)", textTransform: "uppercase", letterSpacing: "0.8px", marginBottom: "4px" }}>
              {s.label}
            </div>
            <div style={{ fontSize: "22px", fontWeight: 700, color: s.color }}>
              {s.value}
            </div>
          </div>
        ))}
      </div>

      {/* ---- 筛选栏 ---- */}
      <Card title="筛选" icon="⚙" onRefresh={onRefresh} loading={loading}>
        {/* 搜索框 */}
        <div style={{ marginBottom: "12px" }}>
          <input
            value={searchText}
            onChange={e => setSearchText(e.target.value)}
            placeholder="搜索题目或课程名…"
            style={{
              width: "100%", padding: "9px 12px",
              background: "var(--bg3)",
              border: "1px solid var(--border)",
              borderRadius: "8px", color: "var(--text)", fontSize: "12px",
              outline: "none", boxSizing: "border-box",
              fontFamily: "var(--font)",
            }}
          />
        </div>

        {/* 状态筛选 */}
        <div style={{ display: "flex", alignItems: "baseline", gap: "8px", marginBottom: "8px", flexWrap: "wrap" }}>
          <span style={{ fontSize: "11px", color: "var(--text3)", flexShrink: 0, minWidth: "28px" }}>状态</span>
          <div style={{ display: "inline-flex", flexWrap: "wrap", gap: "4px" }}>
            {[
              { id: "all", label: "全部" },
              { id: "0", label: `未开始(${data.filter(r => r.status === "0").length})` },
              { id: "1", label: `进行中(${data.filter(r => r.status === "1").length})` },
              { id: "2", label: `已提交(${data.filter(r => r.status === "2").length})` },
              { id: "3", label: `已完成(${data.filter(r => r.status === "3").length})` },
            ].map(o => (
              <button key={o.id} onClick={() => setStatusFilter(o.id)} style={filterBtn(statusFilter === o.id)}>
                {o.label}
              </button>
            ))}
          </div>
        </div>

        {/* 作业/考试 */}
        <div style={{ display: "flex", alignItems: "baseline", gap: "8px", marginBottom: "8px", flexWrap: "wrap" }}>
          <span style={{ fontSize: "11px", color: "var(--text3)", flexShrink: 0, minWidth: "28px" }}>分类</span>
          <div style={{ display: "inline-flex", flexWrap: "wrap", gap: "4px" }}>
            {[
              { id: "all", label: "全部" },
              { id: "homework", label: `作业(${stats.homework})` },
              { id: "exam", label: `考试(${stats.exam})` },
            ].map(o => (
              <button key={o.id} onClick={() => setHwFilter(o.id)} style={filterBtn(hwFilter === o.id)}>
                {o.label}
              </button>
            ))}
          </div>
        </div>

        {/* 类型筛选 */}
        <div style={{ display: "flex", alignItems: "baseline", gap: "8px", marginBottom: "8px", flexWrap: "wrap" }}>
          <span style={{ fontSize: "11px", color: "var(--text3)", flexShrink: 0, minWidth: "28px" }}>类型</span>
          <div style={{ display: "inline-flex", flexWrap: "wrap", gap: "4px" }}>
            <button onClick={() => setTypeFilter("all")} style={filterBtn(typeFilter === "all")}>全部</button>
            {types.map(t => (
              <button key={t} onClick={() => setTypeFilter(t)} style={filterBtn(typeFilter === t)}>
                {QUIZ_TYPE_MAP[t]?.label || t}({data.filter(r => r.type === t).length})
              </button>
            ))}
          </div>
        </div>

        {/* 课程筛选 */}
        <div style={{ display: "flex", alignItems: "baseline", gap: "8px", marginBottom: "8px", flexWrap: "wrap" }}>
          <span style={{ fontSize: "11px", color: "var(--text3)", flexShrink: 0, minWidth: "28px" }}>课程</span>
          <div style={{ display: "inline-flex", flexWrap: "wrap", gap: "4px" }}>
            <button onClick={() => setCourseFilter("all")} style={filterBtn(courseFilter === "all")}>全部</button>
            {courses.map(c => (
              <button key={c} onClick={() => setCourseFilter(c)} style={filterBtn(courseFilter === c)}>
                {shortCourseName(c)}
              </button>
            ))}
          </div>
        </div>

        {/* 排序 */}
        <div style={{ display: "flex", alignItems: "baseline", gap: "8px" }}>
          <span style={{ fontSize: "11px", color: "var(--text3)", flexShrink: 0, minWidth: "28px" }}>排序</span>
          <div style={{ display: "inline-flex", gap: "4px" }}>
            {[
              { id: "deadline", label: "截止时间" },
              { id: "grade", label: "成绩" },
              { id: "name", label: "名称" },
            ].map(o => (
              <button key={o.id} onClick={() => setSortBy(o.id)} style={filterBtn(sortBy === o.id)}>
                {o.label}
              </button>
            ))}
          </div>
        </div>
      </Card>

      {/* ---- 结果计数 ---- */}
      <div style={{ fontSize: "11px", color: "var(--text3)", padding: "0 2px" }}>
        显示 {Math.min(viewLimit, filtered.length)}/{filtered.length} 条
        {filtered.length !== data.length && ` (已筛选，总 ${data.length})`}
      </div>

      {/* ---- 列表 ---- */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: "8px" }}>
        {shown.map((r) => {
          const title = r.quiz?.title || r.quiz?.name || "未命名";
          const course = r.course_id?.name;
          const st = STATUS_MAP[r.status] || STATUS_MAP["0"];
          const tp = QUIZ_TYPE_MAP[r.type] || { label: r.type, color: "var(--text2)" };
          const deadline = (r.status === "0" || r.status === "1") ? getDeadlineInfo(r.quizEndTime) : null;
          const hasGrade = r.grade != null && r.grade >= 0 && r.status === "3";
          const maxGrade = r.quiz?.maxGrade || 100;
          const gradeRatio = hasGrade ? r.grade / maxGrade : 0;
          const expanded = expandedId === r._id;

          return (
            <div
              key={r._id}
              onClick={() => setExpandedId(expanded ? null : r._id)}
              style={{
                background: deadline?.urgent
                  ? "rgba(239,68,68,0.04)"
                  : "var(--bg3)",
                border: deadline?.urgent
                  ? "1px solid rgba(239,68,68,0.12)"
                  : "1px solid var(--border)",
                borderRadius: "10px",
                padding: "12px 14px",
                cursor: "pointer",
                transition: "all 0.15s",
                overflow: "hidden",
              }}
            >
              {/* 标题 + 课程 */}
              <div style={{ marginBottom: "8px" }}>
                <div style={{
                  fontSize: "13px", color: "var(--text)", fontWeight: 500,
                  lineHeight: 1.4, wordBreak: "break-word",
                }}>
                  {title}
                </div>
                {course && (
                  <div style={{ fontSize: "11px", color: "var(--text3)", marginTop: "3px" }}>
                    {shortCourseName(course)}
                  </div>
                )}
              </div>

              {/* 标签组 */}
              <div style={{ display: "flex", gap: "5px", alignItems: "center", flexWrap: "wrap" }}>
                {/* 状态点 */}
                <span style={{
                  width: "7px", height: "7px", borderRadius: "50%",
                  background: st.color, flexShrink: 0,
                  boxShadow: r.status === "1" ? `0 0 6px ${st.color}60` : "none",
                }} />
                  {/* 类型标签 */}
                  <span style={{
                    padding: "2px 7px", borderRadius: "4px", fontSize: "10px",
                    background: `${tp.color}15`, color: tp.color, fontWeight: 500,
                  }}>
                    {tp.label}
                  </span>

                  {/* 考试/作业 */}
                  {!r.homeWork && (
                    <span style={{
                      padding: "2px 7px", borderRadius: "4px", fontSize: "10px",
                      background: "rgba(239,68,68,0.1)", color: "#ef4444", fontWeight: 600,
                    }}>
                      考试
                    </span>
                  )}

                  {/* 成绩 */}
                  {hasGrade && (
                    <span style={{
                      padding: "2px 8px", borderRadius: "4px", fontSize: "11px", fontWeight: 700,
                      fontFamily: "var(--font)",
                      background: gradeRatio >= 0.8 ? "rgba(192,133,82,0.12)" :
                                  gradeRatio >= 0.6 ? "rgba(251,191,36,0.12)" :
                                  "rgba(239,68,68,0.12)",
                      color: gradeRatio >= 0.8 ? "#c08552" :
                             gradeRatio >= 0.6 ? "#fbbf24" : "#ef4444",
                    }}>
                      {r.grade}/{maxGrade}
                    </span>
                  )}

                  {/* 状态 */}
                  <span style={{
                    padding: "2px 7px", borderRadius: "4px", fontSize: "10px",
                    background: st.bg, color: st.color, fontWeight: 500,
                  }}>
                    {st.label}
                  </span>

                  {/* 截止倒计时 */}
                  {deadline && (
                    <span style={{
                      padding: "2px 7px", borderRadius: "4px", fontSize: "10px",
                      background: `${deadline.color}15`, color: deadline.color, fontWeight: 600,
                    }}>
                      {deadline.urgent ? "⚠ " : ""}{deadline.label}
                    </span>
                  )}
                </div>

              {/* 展开详情 */}
              {expanded && (
                <div style={{
                  marginTop: "12px", paddingTop: "10px",
                  borderTop: "1px solid var(--border)",
                  display: "grid", gridTemplateColumns: "1fr 1fr",
                  gap: "8px", fontSize: "11px",
                }}>
                  <div>
                    <span style={{ color: "var(--text3)" }}>课程　</span>
                    <span style={{ color: "var(--text2)" }}>{course || "无"}</span>
                  </div>
                  <div>
                    <span style={{ color: "var(--text3)" }}>类型　</span>
                    <span style={{ color: "var(--text2)" }}>{tp.label} / {r.homeWork ? "作业" : "考试"}</span>
                  </div>
                  <div>
                    <span style={{ color: "var(--text3)" }}>开始　</span>
                    <span style={{ color: "var(--text2)" }}>
                      {r.quizStartTime ? new Date(r.quizStartTime).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—"}
                    </span>
                  </div>
                  <div>
                    <span style={{ color: "var(--text3)" }}>截止　</span>
                    <span style={{ color: "var(--text2)" }}>
                      {r.quizEndTime ? new Date(r.quizEndTime).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—"}
                    </span>
                  </div>
                  {r.startTime && (
                    <div>
                      <span style={{ color: "var(--text3)" }}>实际开始　</span>
                      <span style={{ color: "var(--text2)" }}>
                        {new Date(r.startTime).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}
                      </span>
                    </div>
                  )}
                  {r.submitTime && (
                    <div>
                      <span style={{ color: "var(--text3)" }}>提交　</span>
                      <span style={{ color: "var(--text2)" }}>
                        {new Date(r.submitTime).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}
                      </span>
                    </div>
                  )}
                  {hasGrade && (
                    <>
                      <div>
                        <span style={{ color: "var(--text3)" }}>成绩　</span>
                        <span style={{ color: gradeRatio >= 0.8 ? "#c08552" : gradeRatio >= 0.6 ? "#fbbf24" : "#ef4444", fontWeight: 600 }}>
                          {r.grade} / {maxGrade}
                        </span>
                      </div>
                      {(r.quiz?.topGrade >= 0 || r.quiz?.avgGrade >= 0) && (
                        <div>
                          <span style={{ color: "var(--text3)" }}>班级　</span>
                          <span style={{ color: "var(--text2)" }}>
                            最高{r.quiz.topGrade >= 0 ? r.quiz.topGrade : "—"} / 
                            均{r.quiz.avgGrade >= 0 ? r.quiz.avgGrade : "—"} / 
                            最低{r.quiz.botGrade >= 0 ? r.quiz.botGrade : "—"}
                          </span>
                        </div>
                      )}
                    </>
                  )}
                  {r.feedback && (
                    <div style={{ gridColumn: "1 / -1" }}>
                      <span style={{ color: "var(--text3)" }}>评语　</span>
                      <span style={{ color: "#a78bfa" }}>{r.feedback}</span>
                    </div>
                  )}
                  {r.duration > 0 && (
                    <div>
                      <span style={{ color: "var(--text3)" }}>用时　</span>
                      <span style={{ color: "var(--text2)" }}>
                        {Math.round(r.duration / 60000)}分钟
                      </span>
                    </div>
                  )}
                  <div>
                    <span style={{ color: "var(--text3)" }}>ID　</span>
                    <span style={{ color: "var(--text3)", fontSize: "10px" }}>{r._id}</span>
                  </div>
                  {/* 作答按钮 */}
                  {(r.status === "0" || r.status === "1") && (
                    <div style={{ gridColumn: "1 / -1", marginTop: "4px" }}>
                      <button
                        onClick={(e) => { e.stopPropagation(); setActiveQuiz(r); }}
                        style={{
                          width: "100%", padding: "10px", borderRadius: "8px",
                          background: "rgba(192,133,82,0.1)",
                          border: "1px solid rgba(192,133,82,0.2)",
                          color: "#c08552", fontSize: "13px", fontWeight: 600,
                          cursor: "pointer", fontFamily: "var(--font)",
                        }}
                      >
                        {r.status === "0" ? "开始作答" : "继续作答"} →
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* 加载更多 */}
      {filtered.length > viewLimit && (
        <button
          onClick={() => setViewLimit(v => v + 30)}
          style={{
            padding: "10px", borderRadius: "8px",
            background: "var(--bg3)",
            border: "1px solid var(--border)",
            color: "var(--text2)", fontSize: "12px", cursor: "pointer",
            fontFamily: "var(--font)",
            textAlign: "center",
          }}
        >
          加载更多（剩余 {filtered.length - viewLimit} 条）
        </button>
      )}

      {/* 作答工作区浮层 */}
      {activeQuiz && api && (
        <QuizWorkspace
          quiz={activeQuiz}
          api={api}
          onClose={() => setActiveQuiz(null)}
          onSubmitted={() => { setActiveQuiz(null); onRefresh?.(); }}
        />
      )}
    </div>
  );
}

// ============================================================
// 主仪表盘
// ============================================================

function Dashboard({ workerUrl, cookie, onLogout }) {
  const api = useRef(createApi(workerUrl, cookie)).current;

  const [theme, setTheme] = useState(() => localStorage.getItem("lqwl_theme") || "light");
  const toggleTheme = () => { const n = theme === "dark" ? "light" : "dark"; setTheme(n); localStorage.setItem("lqwl_theme", n); };
  const dk = theme === "dark";

  const [user, setUser] = useState(null);
  const [schedule, setSchedule] = useState(null);
  const [attendance, setAttendance] = useState(null);
  const [notifications, setNotifications] = useState(null);
  const [appRules, setAppRules] = useState(null);
  const [quizData, setQuizData] = useState(null);

  const [activeTab, setActiveTab] = useState("overview");
  const [errors, setErrors] = useState({});
  const [loading, setLoading] = useState({});

  /**
   * useCallback 缓存函数引用，防止不必要的重新创建。
   * 依赖数组 [] 为空表示这个函数永远不会重新创建。
   */
  const load = useCallback(async (key, fn) => {
    setLoading((prev) => ({ ...prev, [key]: true }));
    try {
      const data = await fn();
      return data;
    } catch (e) {
      setErrors((prev) => ({ ...prev, [key]: e.message }));
      return null;
    } finally {
      setLoading((prev) => ({ ...prev, [key]: false }));
    }
  }, []);

  const loadAll = useCallback(async () => {
    const u = await load("user", api.getStudentInfo);
    if (u) setUser(u);
    const s = await load("schedule", api.getSchedule);
    if (s) setSchedule(s);
    const a = await load("attendance", api.getAttendanceSummary);
    if (a) setAttendance(a);
    const n = await load("notifications", api.getNotifications);
    if (n) setNotifications(n);
    const q = await load("quiz", api.getQuizAll);
    if (q) {
      const arr = Array.isArray(q) ? q : Array.isArray(q.data) ? q.data : Array.isArray(q.quizzes) ? q.quizzes : null;
      setQuizData(arr);
    }
  }, [api, load]);

  useEffect(() => { loadAll(); }, [loadAll]);

  const tabs = [
    { id: "overview", label: "概览", icon: "◉" },
    { id: "quiz", label: "作业", icon: "📝" },
    { id: "schedule", label: "课表", icon: "📅" },
    { id: "control", label: "管控", icon: "🛡" },
    { id: "api", label: "调试", icon: "⚡" },
  ];

  return (
    <div style={{
      minHeight: "100vh",
      background: dk ? "#111114" : "#f5f6f8",
      fontFamily: "-apple-system, 'SF Pro Display', 'Helvetica Neue', sans-serif",
      color: dk ? "#d8d8d8" : "#2c2c2c",
      transition: "background 0.3s, color 0.3s",
    }}>
      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes fadeIn { from { opacity:0; transform:translateY(4px); } to { opacity:1; transform:translateY(0); } }
        ::-webkit-scrollbar { width: 5px; }
        ::-webkit-scrollbar-thumb { background: ${dk ? "#333" : "#ccc"}; border-radius: 3px; }
        * { box-sizing: border-box; }
        :root {
          --bg: ${dk ? "#111114" : "#f5f6f8"};
          --bg2: ${dk ? "#1a1a1e" : "#fff"};
          --bg3: ${dk ? "#222226" : "#f0f1f3"};
          --border: ${dk ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.12)"};
          --text: ${dk ? "#d8d8d8" : "#2c2c2c"};
          --text2: ${dk ? "#888" : "#777"};
          --text3: ${dk ? "#555" : "#aaa"};
          --accent: #c08552;
          --font: -apple-system, 'SF Pro Display', 'Helvetica Neue', sans-serif;
          --font-mono: 'SF Mono', 'Menlo', 'Consolas', monospace;
        }
      `}</style>

      {/* Header */}
      <header style={{
        padding: "12px 24px",
        display: "flex", justifyContent: "space-between", alignItems: "center",
        borderBottom: `1px solid var(--border)`,
        position: "sticky", top: 0, zIndex: 100,
        background: dk ? "rgba(17,17,20,0.95)" : "rgba(245,246,248,0.95)",
        backdropFilter: "blur(12px)",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          <span style={{ fontSize: "16px", fontWeight: 700, color: "var(--accent)" }}>领启门户</span>
          {user && (
            <span style={{ fontSize: "13px", color: "var(--text2)" }}>
              {user.name || user.realName}
            </span>
          )}
        </div>
        <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
          <button onClick={toggleTheme} style={{
            background: "var(--bg3)", border: "1px solid var(--border)",
            borderRadius: "8px", color: "var(--text2)", padding: "6px 10px", cursor: "pointer", fontSize: "13px",
          }}>{dk ? "☀️" : "🌙"}</button>
          <button onClick={loadAll} style={{
            background: "var(--bg3)", border: "1px solid var(--border)",
            borderRadius: "8px", color: "var(--text2)", padding: "6px 12px", cursor: "pointer", fontSize: "13px",
          }}>↻</button>
          <button onClick={onLogout} style={{
            background: dk ? "rgba(255,80,80,0.08)" : "rgba(255,80,80,0.06)",
            border: "1px solid rgba(255,80,80,0.12)",
            borderRadius: "8px", color: "#e05050", padding: "6px 12px", cursor: "pointer", fontSize: "13px",
          }}>登出</button>
        </div>
      </header>

      {/* Tab Bar */}
      <nav style={{
        display: "flex", gap: "2px", padding: "8px 24px",
        borderBottom: `1px solid var(--border)`, overflowX: "auto",
      }}>
        {tabs.map((t) => (
          <button key={t.id}
            onClick={() => {
              setActiveTab(t.id);
              if (t.id === "quiz" && !quizData) {
                load("quiz", api.getQuizAll).then(d => {
                  if (d) { const arr = Array.isArray(d) ? d : Array.isArray(d.data) ? d.data : null; setQuizData(arr); }
                });
              }
              if (t.id === "control" && !appRules) {
                load("appRules", api.getAppRules).then(d => d && setAppRules(d));
              }
            }}
            style={{
              display: "flex", alignItems: "center", gap: "5px",
              padding: "7px 14px", borderRadius: "8px", border: "none",
              cursor: "pointer", fontSize: "13px", whiteSpace: "nowrap",
              fontFamily: "var(--font)",
              background: activeTab === t.id ? (dk ? "rgba(192,133,82,0.12)" : "rgba(192,133,82,0.08)") : "transparent",
              color: activeTab === t.id ? "var(--accent)" : "var(--text2)",
              fontWeight: activeTab === t.id ? 600 : 400,
              transition: "all 0.15s",
            }}
          >
            <span>{t.icon}</span> {t.label}
          </button>
        ))}
      </nav>

      {/* Content */}
      <main style={{
        padding: "20px 24px", maxWidth: "1100px", margin: "0 auto",
        animation: "fadeIn 0.2s ease",
      }}>

        {/* 概览 */}
        {activeTab === "overview" && (
          <div style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
            gap: "14px",
          }}>
            <Card title="个人信息" icon="👤" loading={loading.user}>
              {user ? (
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "14px" }}>
                  <Stat label="姓名" value={user.name || user.realName} />
                  <Stat label="学校" value={user.school || user.schoolName} />
                  <Stat label="班级" value={user.classNumber || user.className} />
                  <Stat label="年级" value={user.classYear || user.gradeName} />
                  <Stat label="学号" value={user.sid || user.studentNo} />
                  <Stat label="学部" value={user.division || user.departmentName} />
                </div>
              ) : errors.user ? (
                <div style={{ color: "#ff5050", fontSize: "12px" }}>{errors.user}</div>
              ) : null}
            </Card>

            <Card title="考勤" icon="✓" loading={loading.attendance}
              onRefresh={() => load("attendance", api.getAttendanceSummary).then(d => d && setAttendance(d))}>
              {attendance ? (
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "14px" }}>
                  <Stat label="出勤" value={attendance.attendanceCount ?? attendance.present} color="#c08552" />
                  <Stat label="迟到" value={attendance.lateCount ?? attendance.late} color="#fbbf24" />
                  <Stat label="缺勤" value={attendance.absenceCount ?? attendance.absent} color="#ff5050" />
                </div>
              ) : (
                <div style={{ color: "var(--text3)", fontSize: "12px" }}>{errors.attendance || "暂无数据"}</div>
              )}
            </Card>

            <Card title="通知" icon="🔔" loading={loading.notifications}
              onRefresh={() => load("notifications", api.getNotifications).then(d => d && setNotifications(d))}>
              {Array.isArray(notifications) ? (
                <div style={{ display: "flex", flexDirection: "column", gap: "6px", maxHeight: "180px", overflowY: "auto" }}>
                  {notifications.length === 0 && <div style={{ color: "var(--text3)", fontSize: "12px" }}>暂无</div>}
                  {notifications.slice(0, 5).map((n, i) => (
                    <div key={i} style={{
                      padding: "8px 10px", background: "var(--bg3)",
                      borderRadius: "6px", fontSize: "12px",
                    }}>
                      <div style={{ color: "var(--text)" }}>{n.title || n.content || JSON.stringify(n).slice(0, 60)}</div>
                      {n.createdAt && <div style={{ color: "var(--text3)", fontSize: "11px", marginTop: "3px" }}>
                        {new Date(n.createdAt).toLocaleDateString("zh-CN")}
                      </div>}
                    </div>
                  ))}
                </div>
              ) : notifications ? (
                <JsonPreview data={notifications} maxHeight="180px" />
              ) : (
                <div style={{ color: "var(--text3)", fontSize: "12px" }}>{errors.notifications || "暂无"}</div>
              )}
            </Card>

            <Card title="待完成作业" icon="📝" loading={loading.quiz}>
              {Array.isArray(quizData) ? (() => {
                const pending = quizData
                  .filter(r => r.status === "0" || r.status === "1")
                  .sort((a, b) => new Date(a.quizEndTime || 0) - new Date(b.quizEndTime || 0));
                if (pending.length === 0) return <div style={{ color: "var(--text3)", fontSize: "12px" }}>全部完成 ✓</div>;
                return (
                  <div style={{ display: "flex", flexDirection: "column", gap: "6px", maxHeight: "200px", overflowY: "auto" }}>
                    {pending.slice(0, 8).map((r) => {
                      const dl = getDeadlineInfo(r.quizEndTime);
                      const st = STATUS_MAP[r.status];
                      return (
                        <div key={r._id} style={{
                          display: "flex", alignItems: "center", gap: "8px",
                          padding: "7px 10px",
                          background: dl?.urgent ? "rgba(239,68,68,0.04)" : "var(--bg3)",
                          border: dl?.urgent ? "1px solid rgba(239,68,68,0.08)" : "none",
                          borderRadius: "6px",
                        }}>
                          <span style={{
                            width: "7px", height: "7px", borderRadius: "50%", flexShrink: 0,
                            background: st.color,
                            boxShadow: r.status === "1" ? `0 0 5px ${st.color}60` : "none",
                          }} />
                          <span style={{ fontSize: "12px", color: "var(--text)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {r.quiz?.title || r.quiz?.name || "未命名"}
                          </span>
                          {dl && (
                            <Tag color={dl.color}>
                              {dl.urgent ? "⚠ " : ""}{dl.label}
                            </Tag>
                          )}
                          <Tag color={st.color}>{st.label}</Tag>
                        </div>
                      );
                    })}
                    {pending.length > 8 && (
                      <div style={{ fontSize: "11px", color: "var(--text3)", textAlign: "center", padding: "4px" }}>
                        还有 {pending.length - 8} 项，点击"考试/作业"tab 查看全部
                      </div>
                    )}
                  </div>
                );
              })() : (
                <div style={{ color: "var(--text3)", fontSize: "12px" }}>{errors.quiz || "加载中…"}</div>
              )}
            </Card>

            <Card title="Session 信息" icon="🔑">
              <div style={{ fontSize: "12px", color: "var(--text2)", lineHeight: "1.8" }}>
                <div>
                  <span style={{ color: "var(--text3)" }}>Cookie: </span>
                  <code style={{ color: "#c08552", fontSize: "11px", wordBreak: "break-all" }}>
                    sessionID={extractSessionValue(cookie).slice(0, 20)}...
                  </code>
                </div>
                <div>
                  <span style={{ color: "var(--text3)" }}>Worker: </span>
                  <code style={{ color: "var(--text2)", fontSize: "11px" }}>{workerUrl}</code>
                </div>
                <div>
                  <span style={{ color: "var(--text3)" }}>后端: </span>
                  <code style={{ color: "var(--text2)", fontSize: "11px" }}>Express + express-session</code>
                </div>
              </div>
            </Card>
          </div>
        )}

        {/* 课表 */}
        {activeTab === "schedule" && (
          <Card title="课程表" icon="📅" loading={loading.schedule}
            onRefresh={() => load("schedule", api.getSchedule).then(d => d && setSchedule(d))}>
            <ScheduleTable data={schedule} />
          </Card>
        )}

        {/* 考试/作业 */}
        {activeTab === "quiz" && (
          <QuizPanel
            quizData={quizData}
            loading={loading.quiz}
            error={errors.quiz}
            api={api}
            onRefresh={() => load("quiz", api.getQuizAll).then(d => {
              if (d) {
                const arr = Array.isArray(d) ? d : Array.isArray(d.data) ? d.data : null;
                setQuizData(arr);
              }
            })}
          />
        )}

        {/* 管控分析 */}
        {activeTab === "control" && (
          <Card title="管控规则分析" icon="🛡" loading={loading.appRules}
            onRefresh={() => load("appRules", api.getAppRules).then(d => d && setAppRules(d))}>
            <div style={{ fontSize: "12px", color: "var(--text2)", marginBottom: "10px", lineHeight: "1.6" }}>
              服务器下发的应用限制规则。你的 LSPosed 模块在平板本地拦截这些规则的执行。
            </div>
            <JsonPreview data={appRules} />
          </Card>
        )}

        {/* API 调试 */}
        {activeTab === "api" && (
          <ApiDebugger workerUrl={workerUrl} cookie={cookie} />
        )}
      </main>
    </div>
  );
}

// ============================================================
// 根组件
// ============================================================

/**
 * App 决定显示哪个页面：
 *   - 没有保存的凭证 → SetupScreen
 *   - 有凭证 → Dashboard
 */
export default function App() {
  const [ready, setReady] = useState(false);
  const [workerUrl, setWorkerUrl] = useState("");
  const [cookie, setCookie] = useState("");

  useEffect(() => {
    const w = localStorage.getItem("lqwl_worker");
    const c = localStorage.getItem("lqwl_cookie");
    if (w && c) {
      setWorkerUrl(w);
      setCookie(c);
      setReady(true);
    }
  }, []);

  if (!ready) {
    return (
      <SetupScreen onComplete={(w, c) => {
        setWorkerUrl(w);
        setCookie(c);
        setReady(true);
      }} />
    );
  }

  return (
    <Dashboard
      workerUrl={workerUrl}
      cookie={cookie}
      onLogout={() => {
        localStorage.removeItem("lqwl_worker");
        localStorage.removeItem("lqwl_cookie");
        localStorage.removeItem("lqwl_session_raw");
        setReady(false);
      }}
    />
  );
}
