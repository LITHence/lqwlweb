#!/bin/bash
# ============================================================
# 领启未来 (com.pad.lingqiweilai) Cookie 提取脚本
# 
# 【背景知识】
# 这个应用使用 OkGo 网络库（基于 OkHttp 的封装），它的 Cookie 存储方式是：
#   SPCookieStore → SharedPreferences → XML 文件
#
# 【存储位置】
# Android 应用的 SharedPreferences 存储在：
#   /data/data/<包名>/shared_prefs/<文件名>.xml
# 对于领启未来，OkGo 的 cookie 存储文件名硬编码为 "okgo_cookie"，所以完整路径是：
#   /data/data/com.pad.lingqiweilai/shared_prefs/okgo_cookie.xml
#
# 【XML 结构】
# OkGo 的 SPCookieStore 用两层 key-value 存储 cookie：
#
#   第一层（索引）：key = 域名, value = cookie token 列表（逗号分隔）
#     <string name="api.07future.com">sessionID@api.07future.com</string>
#     ↑ 意思是: 对于 api.07future.com 这个域名，有一个叫 "sessionID" 的 cookie
#
#   第二层（数据）：key = "cookie_" + token, value = Java 序列化对象的 hex 编码
#     <string name="cookie_sessionID@api.07future.com">ACED0005...</string>
#     ↑ 意思是: 这个 cookie 的完整数据（名称、值、过期时间等）被序列化成了 hex 字符串
#
# 【序列化格式】
# 值是 Java ObjectOutputStream 序列化的 SerializableCookie 对象，转成了大写 hex。
# ACED0005 是 Java 序列化的固定魔数（magic bytes），相当于文件头标识。
# 里面的字段写入顺序（参考 SerializableCookie.writeObject 源码）：
#   1. defaultWriteObject → domain, host, name（类的成员变量，自动序列化）
#   2. cookie.name()      → String   cookie 名称
#   3. cookie.value()     → String   cookie 值 ← 我们要提取的东西！
#   4. cookie.expiresAt() → long     过期时间戳（毫秒）
#   5. cookie.domain()    → String   域名
#   6. cookie.path()      → String   路径
#   7. cookie.secure()    → boolean  是否仅 HTTPS
#   8. cookie.httpOnly()  → boolean  是否禁止 JS 访问
#   9. cookie.hostOnly()  → boolean  是否精确匹配域名
#   10. cookie.persistent() → boolean 是否持久化
#
# 【为什么不能直接 grep 明文】
# 因为 cookie 值不是明文存储的，而是经过 Java 序列化 + hex 编码的。
# 所以我们需要：读取 hex → 解析 Java 序列化格式 → 提取出 cookie.value()
#
# 用法: bash extract_cookie.sh
# 前提: ADB 已连接平板, 平板已 root, 本机已安装 Python 3
# ============================================================

set -e  # 任何命令失败立即退出（安全习惯）

echo "╔══════════════════════════════════════════╗"
echo "║   领启未来 Cookie 提取工具 v2.0         ║"
echo "╚══════════════════════════════════════════╝"
echo ""

# ================================================================
# Step 0: 环境检查
# ================================================================

# 检查 ADB 是否连接
# "adb devices" 的输出格式：
#   List of devices attached
#   XXXXXXXX    device        ← 正常连接
#   XXXXXXXX    unauthorized  ← 未授权（需要在平板上点"允许"）
#   XXXXXXXX    offline       ← 离线
#
# grep -q "device$" 解释：
#   -q     静默模式，不输出匹配结果，只返回 0（找到）或 1（没找到）
#   device$  正则表达式，$ 表示行尾，所以只匹配 "device" 在行尾的情况
#            这样就不会误匹配 "List of devices attached" 这一行
if ! adb devices | grep -q "device$"; then
    echo "✗ 未检测到 ADB 设备"
    echo "  排查步骤:"
    echo "  1. USB 线是否连接？"
    echo "  2. 平板「设置 → 开发者选项 → USB 调试」是否开启？"
    echo "  3. 平板上是否弹出 USB 授权对话框？点「允许」"
    echo "  4. 运行 adb devices 看看输出"
    exit 1
fi
echo "✓ ADB 设备已连接"

# 检查 Python3（需要它来解码 Java 序列化数据）
# command -v 检查某个命令是否存在于 PATH 中
# &>/dev/null 把 stdout 和 stderr 都丢弃（只关心返回码）
if ! command -v python3 &>/dev/null; then
    echo "✗ 未找到 python3，请先安装"
    echo "  macOS: brew install python3"
    exit 1
fi
echo "✓ Python3 可用"

# ================================================================
# Step 1: 从平板读取 okgo_cookie.xml
# ================================================================

# /data/data/ 目录需要 root 权限才能访问
# adb shell su -c "..." = 在平板上以 root 身份执行命令
# 2>/dev/null = 把 stderr（错误输出）丢弃，防止无关报错信息干扰
# || true = 即使命令失败也不要让脚本退出（因为我们设了 set -e）
SP_FILE="/data/data/com.pad.lingqiweilai/shared_prefs/okgo_cookie.xml"

echo ""
echo "[1/3] 读取 $SP_FILE ..."

RAW_XML=$(adb shell su -c "cat '$SP_FILE'" 2>/dev/null || true)

if [ -z "$RAW_XML" ]; then
    echo "✗ 无法读取 cookie 文件"
    echo "  可能原因:"
    echo "  1. 平板未 root（su 命令不可用）"
    echo "  2. 领启未来从未登录过（文件不存在）"
    echo "  3. 包名不对（检查: adb shell pm list packages | grep lingqi）"
    exit 1
fi

echo "✓ 成功读取 cookie 文件"

# ================================================================
# Step 2: 从 XML 中提取 hex 编码的 cookie 数据
# ================================================================

echo ""
echo "[2/3] 提取 hex 编码的 cookie ..."

# 从 XML 中抓取 name 以 "cookie_" 开头的 <string> 标签内容
#
# grep -o 解释：
#   -o = only matching，只输出正则匹配到的部分（而不是整行）
#   'cookie_[^"]*">[^<]*'  这个正则的意思是：
#     cookie_     字面匹配 "cookie_"
#     [^"]*       匹配任意多个非双引号字符（即 name 属性的剩余部分）
#     ">          匹配 "> 
#     [^<]*       匹配任意多个非 < 字符（即标签的文本内容 = hex 数据）
#
# sed 's/.*>//' 解释：
#   s/正则/替换/  是替换命令
#   .*>           匹配从开头到最后一个 > 的所有内容
#   替换为空      即删掉前缀，只留 hex 数据
#
# head -1：只取第一个匹配（通常只有一个 cookie）

HEX_DATA=$(echo "$RAW_XML" | grep -o 'cookie_[^"]*">[^<]*' | sed 's/.*>//' | head -1)

if [ -z "$HEX_DATA" ]; then
    echo "✗ 未找到 cookie 数据"
    echo "  XML 文件内容："
    echo "$RAW_XML"
    exit 1
fi

# ${#HEX_DATA} 是 bash 语法，获取变量的字符长度
# ${HEX_DATA:0:40} 是子串截取，从第 0 位开始取 40 个字符
echo "✓ 找到 hex 数据 (${#HEX_DATA} 字符)"
echo "  前缀: ${HEX_DATA:0:40}..."

# ================================================================
# Step 3: 用 Python 解码 Java 序列化对象
# ================================================================

echo ""
echo "[3/3] 解码 Java 序列化数据..."

# 这里用 here document（<< 'PYEOF'）把 Python 代码内联在 bash 里
# 单引号 'PYEOF' 表示不做变量替换（$符号原样传给Python）
# 但我们需要传入 $HEX_DATA，所以用不带引号的 PYEOF
# 这样 bash 会先把 $HEX_DATA 替换成实际值，再传给 python3

RESULT=$(python3 << PYEOF
import struct
from datetime import datetime

hex_str = "$HEX_DATA"
data = bytes.fromhex(hex_str)

# ---- 提取所有 Java 序列化字符串 ----
#
# 【Java 序列化中字符串的编码方式】
# 标记字节 0x74 (TC_STRING) + 2字节长度（大端序/Big-Endian）+ UTF-8 字节
#
# 例如 "hello" (5个字符) 会被编码为：
#   74 00 05 68 65 6C 6C 6F
#   ↑  ↑───↑  ↑───────────↑
#   |  长度=5  h  e  l  l  o
#   TC_STRING
#
# 还有一种 0x71 (TC_REFERENCE)，表示引用之前出现过的对象，
# 后面跟 4 字节的引用 handle，我们跳过它。
#
# struct.unpack('>H', ...) 解释：
#   >  大端序（Java 默认字节序）
#   H  unsigned short（2字节无符号整数）

strings = []
i = 0
while i < len(data):
    if data[i] == 0x74 and i + 2 < len(data):
        length = struct.unpack('>H', data[i+1:i+3])[0]
        if i + 3 + length <= len(data) and 0 < length < 1000:
            s = data[i+3:i+3+length].decode('utf-8', errors='replace')
            strings.append(s)
            i += 3 + length
            continue
    i += 1

# ---- 识别各个字段 ----
#
# Java 序列化流里会包含类描述符的字符串（如 "Ljava/lang/String;"），
# 这些不是 cookie 数据，需要跳过。
#
# 对于领启未来 + express-session 的组合：
#   cookie 名称 = "sessionID"
#   cookie 值以 "s%3A" 开头（express-session 签名 cookie 的特征）
#     s%3A 是 URL 编码的 "s:"
#     "s:" 后面是 session ID，"." 后面是 HMAC-SHA256 签名
#     例如: s%3A<sessionId>.<signature>

cookie_name = None
cookie_value = None
cookie_domain = None

for s in strings:
    # 跳过 Java 内部的类描述符字符串
    if 'java' in s or 'String' in s:
        continue
    if s.startswith('s%3A'):
        cookie_value = s
    elif '07future' in s and cookie_domain is None:
        cookie_domain = s
    elif s == 'sessionID':
        cookie_name = s

# 兜底策略：如果没找到 s%3A 开头的，取最长的非元数据字符串
if cookie_value is None:
    candidates = [s for s in strings if 'java' not in s and 'String' not in s and len(s) > 20]
    if candidates:
        cookie_value = max(candidates, key=len)

# ---- 提取过期时间 ----
# expiresAt 是 Java 的 long 类型（8字节有符号整数，大端序）
# 值是 Unix 毫秒时间戳
# struct.unpack('>q', ...) 中 q = signed long long（8字节）
expire_str = "未知"
for i in range(len(data) - 7):
    ts = struct.unpack('>q', data[i:i+8])[0]
    # 过滤合理范围：2024-01-01 ~ 2030-01-01（毫秒）
    if 1704067200000 < ts < 1893456000000:
        expire_str = datetime.fromtimestamp(ts / 1000).strftime('%Y-%m-%d %H:%M:%S')
        break

# ---- 输出（用固定格式，方便 bash 解析）----
if cookie_value:
    print(f"STATUS:OK")
    print(f"NAME:{cookie_name or 'unknown'}")
    print(f"VALUE:{cookie_value}")
    print(f"DOMAIN:{cookie_domain or 'unknown'}")
    print(f"EXPIRES:{expire_str}")
    print(f"HEADER:{cookie_name or 'sessionID'}={cookie_value}")
else:
    print(f"STATUS:FAIL")
    print(f"DEBUG:found strings = {strings}")
PYEOF
)

# ================================================================
# Step 4: 解析 Python 输出并显示结果
# ================================================================

echo ""

# 从 Python 的多行输出中提取各字段
# grep '^STATUS:' = 匹配以 "STATUS:" 开头的行
# cut -d: -f2 = 以冒号为分隔符，取第2个字段
# cut -d: -f2- = 取第2个字段及之后所有内容（cookie 值里可能包含冒号）
STATUS=$(echo "$RESULT" | grep '^STATUS:' | cut -d: -f2)

if [ "$STATUS" = "OK" ]; then
    NAME=$(echo "$RESULT" | grep '^NAME:' | cut -d: -f2)
    VALUE=$(echo "$RESULT" | grep '^VALUE:' | cut -d: -f2-)
    DOMAIN=$(echo "$RESULT" | grep '^DOMAIN:' | cut -d: -f2)
    EXPIRES=$(echo "$RESULT" | grep '^EXPIRES:' | cut -d: -f2-)
    HEADER=$(echo "$RESULT" | grep '^HEADER:' | cut -d: -f2-)

    echo "╔══════════════════════════════════════════╗"
    echo "║           ✓ Cookie 提取成功！           ║"
    echo "╚══════════════════════════════════════════╝"
    echo ""
    echo "  Cookie 名称:  $NAME"
    echo "  Cookie 域名:  $DOMAIN"
    echo "  过期时间:     $EXPIRES"
    echo ""
    echo "  完整 Cookie Header:"
    echo "  $HEADER"

    # 保存到文件方便后续使用
    echo "$HEADER" > ./lqwl_cookie.txt
    echo ""
    echo "  已保存到 ./lqwl_cookie.txt"

    # ---- 可选：验证 cookie 是否有效 ----
    echo ""
    echo "  验证 Cookie 有效性..."

    # curl 参数解释：
    #   -s              静默模式（不显示进度条）
    #   -o /dev/null    丢弃响应体（我们只关心状态码）
    #   -w "%{http_code}"  输出 HTTP 状态码
    HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
        -H "Cookie: $HEADER" \
        "https://api.07future.com/api/v2/users/me" 2>/dev/null || echo "000")

    if [ "$HTTP_CODE" = "200" ]; then
        echo "  ✓ Cookie 有效 (HTTP 200)"
        echo ""
        echo "  用户数据预览:"
        # python3 -m json.tool = Python 自带的 JSON 格式化工具
        curl -s -H "Cookie: $HEADER" \
            "https://api.07future.com/api/v2/users/me" 2>/dev/null \
            | python3 -m json.tool 2>/dev/null \
            | head -20
    elif [ "$HTTP_CODE" = "401" ] || [ "$HTTP_CODE" = "403" ]; then
        echo "  ✗ Cookie 已过期 (HTTP $HTTP_CODE)"
        echo "    在平板上打开领启未来重新登录，然后再跑一次本脚本"
    else
        echo "  ? 无法验证 (HTTP $HTTP_CODE)，可能是网络问题"
    fi
else
    echo "✗ 解码失败"
    echo "$RESULT"
    echo ""
    echo "原始 XML:"
    echo "$RAW_XML"
fi

echo ""
echo "完成。"
