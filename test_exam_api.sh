#!/bin/bash
# ============================================================
# 领启未来 考试 & 作业 API 结构测试脚本
#
# 【作用】
# 逐个请求考试相关的 API 端点，保存返回的 JSON 结构。
# 拿到真实数据结构后，才能准确构建前端界面。
#
# 【用法】
#   bash test_exam_api.sh "sessionID=s%3Axxxx"
#   或
#   bash test_exam_api.sh          (从 ./lqwl_cookie.txt 读取)
#
# 【环境切换】
#   修改下面的 BASE 变量：
#     生产: https://api.07future.com
#     测试: https://test.api.07future.com
#
# 【输出】
#   ./api_responses/ 目录下每个端点一个 JSON 文件
#   脚本末尾会自动生成结构摘要
# ============================================================

set -e

# ---- 读取 Cookie ----
if [ -n "$1" ]; then
    COOKIE="$1"
elif [ -f "./lqwl_cookie.txt" ]; then
    COOKIE=$(cat ./lqwl_cookie.txt | tr -d '\n\r')
else
    echo "用法: bash test_exam_api.sh \"sessionID=s%3Axxxx\""
    echo "  或先运行 extract_cookie.sh 生成 lqwl_cookie.txt"
    exit 1
fi

# ---- 配置 ----
BASE="https://api.07future.com"
OUT="./api_responses"
mkdir -p "$OUT"

# ---- 通用请求函数 ----
# 参数: $1=文件名  $2=HTTP方法  $3=路径  $4=POST body(可选)
call_api() {
    local name="$1"
    local method="$2"
    local path="$3"
    local body="$4"
    local url="${BASE}${path}"
    local file="${OUT}/${name}.json"

    echo -n "  [$method] $path ... "

    # 构建 curl 参数数组
    local curl_args=(
        -s
        -w "\n---HTTP_CODE:%{http_code}"
        -H "Cookie: $COOKIE"
        -H "Content-Type: application/json"
        -X "$method"
    )
    if [ -n "$body" ]; then
        curl_args+=(-d "$body")
    fi

    # 发请求
    local raw
    raw=$(curl "${curl_args[@]}" "$url" 2>/dev/null || echo "---HTTP_CODE:000")

    # 分离 body 和状态码
    local http_code
    http_code=$(echo "$raw" | grep -o 'HTTP_CODE:[0-9]*' | cut -d: -f2)
    local body_content
    body_content=$(echo "$raw" | sed '/---HTTP_CODE:/d')

    # 保存并格式化
    echo "$body_content" > "$file"
    if command -v python3 &>/dev/null; then
        python3 -m json.tool "$file" > "${file}.tmp" 2>/dev/null && mv "${file}.tmp" "$file" || rm -f "${file}.tmp"
    fi

    # 显示结果
    local size
    size=$(wc -c < "$file" | tr -d ' ')
    if [ "$http_code" = "200" ]; then
        echo "✓ ${http_code} (${size} bytes) → $file"
    elif [ "$http_code" = "401" ] || [ "$http_code" = "403" ]; then
        echo "✗ ${http_code} — Cookie 过期"
    elif [ "$http_code" = "000" ]; then
        echo "✗ 网络错误"
    else
        echo "? ${http_code} (${size} bytes)"
    fi
}

# ============================================================
echo "╔══════════════════════════════════════════════════╗"
echo "║   领启未来 考试 & 作业 API 结构测试              ║"
echo "╚══════════════════════════════════════════════════╝"
echo ""
echo "  环境: $BASE"
echo "  Cookie: ${COOKIE:0:40}..."
echo "  输出: $OUT/"
echo ""

# ---- 0. 验证 Cookie ----
echo "═══ 0. Cookie 验证 ═══"
call_api "00_user_me" "GET" "/api/v2/users/me"
call_api "00_student_info" "GET" "/api/users/info/student?versionName=7.3.8&mac=00:00:00:00:00:00"
echo ""

# ---- 1. 考试列表 ----
echo "═══ 1. 考试列表 & 实例 ═══"
call_api "01a_quiz_by_student" "GET" "/api/quiz/byStudent"
call_api "01b_quiz_by_student_page" "GET" "/api/quiz/byStudent/pageView?page=1&pageSize=5"
call_api "01c_quiz_by_student_homework" "GET" "/api/quiz/byStudent?homeWork=true"
call_api "01d_quiz_by_student_exam" "GET" "/api/quiz/byStudent?homeWork=false"
call_api "01e_quiz_by_student_toefl" "GET" "/api/quiz/byStudent?toefl=true"
call_api "01f_quiz_by_student_word" "GET" "/api/quiz/byStudent?wordTest=true"
call_api "01g_quiz_homework_progress" "GET" "/api/quiz/get-homework-progress"
call_api "01h_quiz_all_instants" "GET" "/api/quiz/allContentInstents2"
call_api "01i_quiz_word_list" "GET" "/api/quiz/wordList"
echo ""

# ---- 2. 考试结果 ----
echo "═══ 2. 考试结果 & 分析 ═══"
call_api "02a_quiz_result" "GET" "/api/quiz/quizResult/studyCore"
call_api "02b_quiz_good_instant" "GET" "/api/quiz/goodInstant"
call_api "02c_ai_max_grade" "GET" "/api/quiz/ai-maxGrade"
call_api "02d_ai_error_color" "GET" "/api/quiz/ai-errorColor"
call_api "02e_report_instants" "GET" "/api/quiz/reportInstants"
call_api "02f_qucent_analysis_set" "GET" "/api/quiz/quCent/analysis/set"
echo ""

# ---- 3. TOEFL 练习 ----
echo "═══ 3. TOEFL 练习系统 ═══"
call_api "03a_toefl_reading" "GET" "/api/quiz/toefl/bankList?practiceType=reading"
call_api "03b_toefl_listening" "GET" "/api/quiz/toefl/bankList?practiceType=listening"
call_api "03c_toefl_writing" "GET" "/api/quiz/toefl/bankList?practiceType=writing"
call_api "03d_toefl_speaking" "GET" "/api/quiz/toefl/bankList?practiceType=speaking"
call_api "03e_toefl_record_list" "GET" "/api/quiz/practiceRecord/list"
call_api "03f_toefl_analysis_reading" "GET" "/api/quiz/toeflPractice/analysis/student?practiceType=reading"
call_api "03g_toefl_analysis_listening" "GET" "/api/quiz/toeflPractice/analysis/student?practiceType=listening"
call_api "03h_toefl_class_rank_reading" "GET" "/api/quiz/toeflPractice/analysis/classRank?practiceType=reading"
echo ""

# ---- 4. Benson 口语 ----
echo "═══ 4. Benson 口语 ═══"
call_api "04a_speaking_credential" "GET" "/api/quiz/SpeakingContent/Credential"
call_api "04b_benson_tpo_list" "GET" "/api/quiz/SpeakingTPOContent/list"
call_api "04c_benson_level" "GET" "/api/quiz/BensonSpeakingLevel"
call_api "04d_benson_league" "GET" "/api/quiz/LeagueOfBensonSpeaking"
call_api "04e_speaking_corpus" "GET" "/api/word/SpeakingCorpus"
echo ""

# ---- 5. AP/ALevel 刷题 ----
echo "═══ 5. AP/ALevel 刷题 ═══"
call_api "05a_ap_list" "GET" "/api/course/APClassRoomExam/list"
call_api "05b_alevel_list" "GET" "/api/course/APClassRoomExam/AlevelList"
call_api "05c_ap_all_courses" "GET" "/api/course/APClassRoomExam/allCourses"
call_api "05d_preparation_list" "GET" "/api/course/PreparationExam/list"
call_api "05e_oxbridge" "GET" "/api/course/APClassRoomExam/Oxbridge"
echo ""

# ---- 6. 错题 & 学习记录 ----
echo "═══ 6. 错题本 & 学习记录 ═══"
call_api "06a_wrong_courses_v2" "GET" "/api/quiz/qmq/wrong/student/courses"
call_api "06b_wrong_log_v1" "GET" "/api/studyCore/myStudyCoreWrongLog/"
call_api "06c_wrong_keypoint" "GET" "/api/studyCore/myStudyCoreWrongLogKeyPoint"
call_api "06d_heart_course_v1" "GET" "/api/studyCore/myStudyCoreCourseHeart/"
call_api "06e_student_log" "GET" "/api/studyCore/myStudyCoreStudentLog"
echo ""

# ---- 7. 雅思自练 ----
echo "═══ 7. 雅思自练 ═══"
call_api "07a_ielts_self" "GET" "/api/quiz/selfPractice/quizBank"
echo ""

# ---- 8. 专项训练 ----
echo "═══ 8. 专项训练 ═══"
call_api "08a_specialized_setting" "GET" "/api/quCentPractice/pool/studentSet"
call_api "08b_specialized_history" "GET" "/api/quCentPractice/practiceInstant/list"
echo ""

# ---- 9. 词汇量测试 ----
echo "═══ 9. 词汇量测试 ═══"
call_api "09a_vocab_test_list" "GET" "/api/word/VocabularyTest/my"
echo ""

# ---- 10. 线下作业 ----
echo "═══ 10. 线下作业 ═══"
call_api "10a_upload_code" "GET" "/api/quiz/homeWorkUploadCode"
echo ""

# ============================================================
# 结构分析
# ============================================================
echo ""
echo "════════════════════════════════════════════════════"
echo "  所有响应已保存到 $OUT/"
echo "════════════════════════════════════════════════════"
echo ""

# 统计
total=0; ok=0; fail=0; empty=0
for f in "$OUT"/*.json; do
    total=$((total + 1))
    size=$(wc -c < "$f" | tr -d ' ')
    if [ "$size" -lt 5 ]; then
        empty=$((empty + 1))
    elif grep -q '"error"\|"statusCode"' "$f" 2>/dev/null; then
        fail=$((fail + 1))
    else
        ok=$((ok + 1))
    fi
done
echo "  统计: $total 个端点 | ✓ $ok 有数据 | ✗ $fail 错误 | ○ $empty 空"
echo ""

# 用 Python 生成详细结构摘要
echo "═══ 数据结构摘要 ═══"
echo ""

python3 << 'PYEOF'
import json, os, glob, sys

out_dir = "./api_responses"
files = sorted(glob.glob(os.path.join(out_dir, "*.json")))

def describe(obj, depth=0, max_depth=2):
    """递归描述 JSON 结构，最多展开 max_depth 层"""
    indent = "    " * depth
    if isinstance(obj, list):
        if len(obj) == 0:
            return "[]"
        sample = obj[0]
        inner = describe(sample, depth + 1, max_depth)
        return f"Array[{len(obj)}] of:\n{indent}  {inner}"
    elif isinstance(obj, dict):
        if depth >= max_depth:
            return "{" + ", ".join(list(obj.keys())[:6]) + ("..." if len(obj) > 6 else "") + "}"
        lines = []
        for k, v in list(obj.items())[:12]:
            vtype = describe(v, depth + 1, max_depth)
            lines.append(f"{indent}    {k}: {vtype}")
        if len(obj) > 12:
            lines.append(f"{indent}    ... (+{len(obj)-12} more keys)")
        return "{\n" + "\n".join(lines) + f"\n{indent}" + "}"
    elif isinstance(obj, str):
        if len(obj) > 40:
            return f'String "{obj[:40]}..."'
        return f'String "{obj}"'
    elif isinstance(obj, bool):
        return f"Boolean ({obj})"
    elif isinstance(obj, int):
        return f"Integer ({obj})"
    elif isinstance(obj, float):
        return f"Float ({obj})"
    elif obj is None:
        return "null"
    else:
        return type(obj).__name__

for f in files:
    name = os.path.basename(f).replace(".json", "")
    size = os.path.getsize(f)

    try:
        with open(f) as fp:
            content = fp.read().strip()
            if not content or content in ('""', 'null', ''):
                print(f"  [{name}] → 空响应")
                print()
                continue
            data = json.loads(content)
    except json.JSONDecodeError as e:
        # 可能不是 JSON
        preview = content[:80] if content else "(empty)"
        print(f"  [{name}] → 非 JSON: {preview}")
        print()
        continue

    desc = describe(data, depth=0, max_depth=2)
    print(f"  [{name}] ({size} bytes)")
    print(f"    {desc}")
    print()

PYEOF

echo ""
echo "═══ 下一步 ═══"
echo ""
echo "  查看完整响应:"
echo "    cat $OUT/01a_quiz_by_student.json | python3 -m json.tool | less"
echo ""
echo "  查看某个端点前 30 行:"
echo "    head -30 $OUT/03a_toefl_reading.json"
echo ""
echo "  把结果发给 Claude，让我根据真实结构构建前端界面。"
echo ""
echo "完成。"
