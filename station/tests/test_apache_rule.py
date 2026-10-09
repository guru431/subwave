"""Правило доступа Apache из `deploy/apache-fm.conf.example` — по таблице путей.

Зачем. Снаружи станция приходит через Apache, а до контроллера — одним адресом
docker-шлюза (Caddy не верит X-Forwarded-For от Apache). `requireAdmin`
контроллера засчитывает неудачей и анонимный запрос, а после 10 неудач
закрывает вход на 15 минут — по `clientIp()`, то есть для всех внешних разом.
Поэтому под `/api/` снаружи пускается только белый список ручек слушателя:
ручка под `requireAdmin`, оставшаяся открытой, — это десять анонимных запросов
из интернета и закрытая владельцу админка через домен.

Тест читает только шаблон конфига и исходники; живой Apache не трогает.
Проверки трёх родов:
- таблицы путей: что закрыто и что открыто снаружи, включая варианты регистра;
- маршруты контроллера, собранные из `controller/src/routes/**` и `server.ts`:
  каждый под `requireAdmin`/`requireAdminUi` закрыт снаружи своим методом,
  каждый открытый — либо в белом списке, либо в `NOT_FOR_LISTENERS` с причиной.
  Новая ручка апстрима роняет тест, пока её не разнесут по спискам, — это и
  есть сверка при обновлении апстрима;
- вызовы плеера `web/` и приложения `app/` проходят правило.

Модель Apache 2.4 (mod_authz_core), воспроизведённая здесь:
- `<LocationMatch "re">` сравнивается с путём URL после декодирования и
  нормализации, без строки запроса; поиск по регэкспу не заякорен (якоря — в
  самом шаблоне). Регэксп — PCRE; использованные конструкции (`(?i)`, `^`, `$`,
  `(?!…)`, `[^/]`, `\\.`, альтернативы) в `re` Python значат то же самое;
- несколько `Require` в секции без контейнера — неявный `<RequireAny>`:
  хватает одного выполненного;
- провайдеры — только `ip` (сети IPv4/IPv6) и `method` (GET и HEAD для него
  одно и то же); незнакомый провайдер роняет тест, а не пропускается;
- путь, не совпавший ни с одной секцией, разрешён: авторизации на нём нет,
  так работает весь остальной vhost (`ProxyPass /` без `Require`);
- слияние секций НЕ моделируется. При `AuthMerging Off` (умолчание) правила
  поздней совпавшей секции заменяют ранние, и итог зависит от порядка.
  Вместо этого тест требует, чтобы каждый проверяемый путь совпадал не больше
  чем с одной секцией, — тогда порядок неважен и модель точна. Другие
  конструкции доступа (`<Location>`, `<If>`, `<Limit>`, `AuthMerging`,
  `Require` вне `<LocationMatch>`/`<Directory>`) шаблону запрещены тестом.
"""
import ipaddress
import re
from dataclasses import dataclass
from pathlib import Path

import pytest

STATION = Path(__file__).resolve().parent.parent
REPO = STATION.parent
CONF = STATION / "deploy" / "apache-fm.conf.example"
CONTROLLER_SRC = REPO / "controller" / "src"

EXTERNAL = "203.0.113.7"   # TEST-NET-3: клиент из интернета
LAN = "10.20.30.40"        # клиент из приватной сети

# Открытые ручки контроллера (без requireAdmin), которые снаружи не нужны
# никому из слушателей и потому закрыты правилом вместе с прочим /api/*.
NOT_FOR_LISTENERS = {
    "/mcp": "агент оператора; админские инструменты пересылают Authorization, "
            "анонимный вызов — та же неудача входа",
    "/listener-auth": "обратный вызов Icecast внутри стека; Caddy и так отвечает 404",
    "/similar-tracks": "читает агент оператора (MCP); плеер и приложение не зовут",
    "/personas": "публичный состав персон; плеер берёт персону из /dj и /schedule",
    "/geocode": "выбор места погоды — мастер и админка (LocationPicker)",
    "/skills/community": "каталог читает сервер Next.js напрямую, не браузер",
    "/personas/community": "каталог читает сервер Next.js напрямую, не браузер",
    "/shows/community": "каталог читает сервер Next.js напрямую, не браузер",
}

# Пути плеера, которые не видны грепом по вызовам: адрес аватара приходит в
# ответах /dj и /schedule (`persona.avatar` = `/persona-avatar/<id>`), web
# склеивает его `client.resolve()` (PlayerCore, ScheduleDrawer), приложение —
# `api.avatar()`.
LISTENER_EXTRA = ["/persona-avatar/p_x1"]

CLOSED_OUTSIDE = [
    ("/admin", "GET"),
    ("/Admin", "GET"),
    ("/admin/dash", "GET"),
    ("/room/admin/dislikes", "GET"),
    ("/ROOM/admin", "GET"),
    ("/Room/Admin/dislikes/decide", "POST"),
    ("/api/settings", "GET"),
    ("/api/Settings", "POST"),
    ("/API/settings", "GET"),
    ("/api/mcp", "POST"),
    ("/api/backup/export", "GET"),
    ("/api/stations", "GET"),
    ("/api/admin-auth", "GET"),
    ("/api/stream-stop", "POST"),
    ("/api/onboarding/save", "POST"),
    ("/api/requests", "GET"),            # соседство с открытым /request
    ("/api/likes", "GET"),               # соседство с открытым /like
    ("/api/schedule", "PUT"),            # тот же путь, что открытое чтение
    ("/api/themes", "POST"),             # тот же путь, что открытое чтение
    ("/api/schedule/next-change", "GET"),
    ("/api/themes/refresh", "POST"),
    ("/api/personas/community/x1/install", "POST"),
    ("/api/", "GET"),
    ("/api/now-playing/", "GET"),        # белый список точный: неизвестное закрыто
]

OPEN_OUTSIDE = [
    ("/", "GET"),
    ("/listen", "GET"),
    ("/onboarding", "GET"),
    ("/manifest.webmanifest", "GET"),
    ("/sw.js", "GET"),
    ("/robots.txt", "GET"),
    ("/stream.mp3", "GET"),
    ("/listen.pls", "GET"),
    ("/room/messages", "GET"),
    ("/room/messages", "POST"),
    ("/room/resolve", "GET"),
    ("/room/push/subscribe", "POST"),
    ("/api/now-playing", "GET"),
    ("/Api/Now-Playing", "GET"),
    ("/api/onboarding/status", "GET"),
    ("/api/schedule", "GET"),
    ("/api/schedule", "HEAD"),
    ("/api/themes", "GET"),
    ("/api/request", "POST"),
    ("/api/request/abc", "GET"),
    ("/api/cover/al-1", "GET"),
]


# ─── Модель Apache ─────────────────────────────────────────────────────────


@dataclass
class Section:
    regex: str
    requires: list[tuple[str, list[str]]]


_SECTION = re.compile(r'^[ \t]*<LocationMatch\s+"([^"]+)">[ \t]*\n(.*?)^[ \t]*</LocationMatch>',
                      re.M | re.S)
_DIRECTORY = re.compile(r"^[ \t]*<Directory\b.*?^[ \t]*</Directory>", re.M | re.S)


def _sections() -> list[Section]:
    text = CONF.read_text(encoding="utf-8")
    result = []
    for m in _SECTION.finditer(text):
        requires = []
        for line in m.group(2).splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            parts = line.split()
            assert parts[0] == "Require" and len(parts) > 2, \
                f"в <LocationMatch> строка, которую модель не знает: {line}"
            requires.append((parts[1], parts[2:]))
        result.append(Section(m.group(1), requires))
    return result


SECTIONS = _sections()


def _satisfied(provider: str, args: list[str], method: str, client: str) -> bool:
    if provider == "ip":
        addr = ipaddress.ip_address(client)
        return any(addr in ipaddress.ip_network(a, strict=False) for a in args)
    if provider == "method":
        return ("GET" if method == "HEAD" else method) in {a.upper() for a in args}
    raise AssertionError(f"Require {provider}: провайдер вне модели")


def allowed(path: str, method: str, client: str) -> bool:
    hits = [s for s in SECTIONS if re.search(s.regex, path)]
    assert len(hits) <= 1, \
        f"{path}: совпали {len(hits)} секции — порядок слияния вне модели"
    if not hits:
        return True
    return any(_satisfied(p, a, method, client) for p, a in hits[0].requires)


# ─── Маршруты контроллера ──────────────────────────────────────────────────


@dataclass
class Route:
    method: str
    path: str
    admin: bool
    source: str


_CALL = re.compile(r"\b(?:router|app)\.(get|post|put|patch|delete)\(")


def _skip_string(src: str, i: int) -> int:
    """Позиция за строковым литералом, начатым в `i` (с `${…}` у шаблонных)."""
    quote, j = src[i], i + 1
    while j < len(src):
        c = src[j]
        if c == "\\":
            j += 2
            continue
        if c == quote:
            return j + 1
        if quote == "`" and src.startswith("${", j):
            depth, j = 1, j + 2
            while depth:
                if src[j] in "'\"`":
                    j = _skip_string(src, j)
                    continue
                depth += {"{": 1, "}": -1}.get(src[j], 0)
                j += 1
            continue
        j += 1
    raise AssertionError("незакрытый строковый литерал")


def _head_args(src: str, i: int) -> list[str]:
    """Аргументы вызова `router.X(` до обработчика: путь и middleware.

    Разбор останавливается на первом аргументе-обработчике (`async`,
    `function`, `(…) =>`), поэтому тело обработчика с его регэкспами и
    строками не читается вовсе. Именованный обработчик (`writeHandler`)
    попадает в список как обычный идентификатор — admin он не делает.
    """
    args, cur, depth = [], [], 0
    at_start = True
    while i < len(src):
        if src.startswith("//", i):
            i = src.index("\n", i)
            continue
        if src.startswith("/*", i):
            i = src.index("*/", i) + 2
            continue
        c = src[i]
        if at_start and not c.isspace():
            if depth == 0 and re.match(r"async\b|function\b|\(", src[i:]):
                return args
            at_start = False
        if c in "'\"`":
            j = _skip_string(src, i)
            cur.append(src[i:j])
            i = j
            continue
        if c in "([{":
            depth += 1
        elif c in ")]}":
            if depth == 0:
                args.append("".join(cur))
                return args
            depth -= 1
        elif c == "," and depth == 0:
            args.append("".join(cur))
            cur, at_start = [], True
            i += 1
            continue
        cur.append(c)
        i += 1
    raise AssertionError("незакрытый вызов")


def _controller_routes() -> list[Route]:
    files = sorted((CONTROLLER_SRC / "routes").rglob("*.ts")) + [CONTROLLER_SRC / "server.ts"]
    routes = []
    for f in files:
        src = f.read_text(encoding="utf-8")
        for m in _CALL.finditer(src):
            args = [a.strip() for a in _head_args(src, m.end())]
            lit = re.fullmatch(r"(['\"`])(/[^'\"`]*)\1", args[0])
            assert lit, f"{f.name}: путь маршрута не литерал: {args[0]!r}"
            admin = any(a in ("requireAdmin", "requireAdminUi") for a in args[1:])
            routes.append(Route(m.group(1).upper(), lit.group(2), admin,
                                f"{f.relative_to(CONTROLLER_SRC)}"))
    return routes


ROUTES = _controller_routes()


def _sample(route_path: str) -> str:
    return re.sub(r":\w+", "x1", route_path)


def _route_regex(route_path: str) -> re.Pattern:
    parts = ["[^/]+" if seg.startswith(":") else re.escape(seg)
             for seg in route_path.split("/")]
    return re.compile("(?i)" + "/".join(parts) + "$")


# ─── Вызовы плеера и приложения ────────────────────────────────────────────

# (файл, регэксп пути после базы /api); `${…}` внутри пути — параметр.
CLIENT_SOURCES = [
    ("web/lib/stationClient.ts", r"\$\{api\}(/[^`'\"?]*)"),
    ("web/lib/stationAuth.ts", r"\$\{apiBase\}(/[^`'\"?]*)"),
    ("web/components/manual/ListenLinks.tsx", r"\$\{origin\}/api(/[^`'\"?]*)"),
    ("app/src/lib/api.ts", r"\bapi\(\s*[`'\"](/[^`'\"?]*)"),
]


def _client_paths() -> list[tuple[str, str]]:
    found = []
    for rel, pattern in CLIENT_SOURCES:
        src = (REPO / rel).read_text(encoding="utf-8")
        paths = {re.sub(r"\$\{[^}]*\}", "x1", p) for p in re.findall(pattern, src)}
        assert paths, f"{rel}: ни одного вызова — разбор устарел"
        found += [(rel, p) for p in sorted(paths)]
    return found + [("LISTENER_EXTRA", p) for p in LISTENER_EXTRA]


CLIENT_PATHS = _client_paths()


# ─── Тесты ─────────────────────────────────────────────────────────────────


def test_template_has_access_sections():
    assert len(SECTIONS) >= 1
    assert all(s.requires for s in SECTIONS)


def test_every_section_is_case_insensitive():
    # Caddy (path, handle_path) и Express сравнивают путь без учёта регистра,
    # а <LocationMatch> — с учётом: без (?i) /Room/admin и /API/settings
    # проходили правило (station-pitfalls.md, «Сеть и внешние службы»)
    for s in SECTIONS:
        assert s.regex.startswith("(?i)"), s.regex


def test_model_covers_every_access_directive():
    text = CONF.read_text(encoding="utf-8")
    code = "\n".join(l for l in text.splitlines() if not l.lstrip().startswith("#"))
    for construct in ("<Location ", "<Location>", "<If", "<Limit", "AuthMerging", "<Require"):
        assert construct not in code, f"{construct}: вне модели теста"
    rest = _DIRECTORY.sub("", _SECTION.sub("", code))
    assert "Require" not in rest, "Require вне <LocationMatch>/<Directory> — вне модели"


@pytest.mark.parametrize("path,method", CLOSED_OUTSIDE)
def test_closed_outside_open_from_lan(path, method):
    assert not allowed(path, method, EXTERNAL)
    assert allowed(path, method, LAN)
    assert allowed(path, method, "127.0.0.1")


@pytest.mark.parametrize("path,method", OPEN_OUTSIDE)
def test_open_outside(path, method):
    assert allowed(path, method, EXTERNAL)


def test_routes_parsed():
    # разбор исходников контроллера жив: иначе проверки ниже пусты и зелены
    assert len(ROUTES) > 150
    assert sum(r.admin for r in ROUTES) > 100
    assert any(r.path == "/now-playing" and not r.admin for r in ROUTES)
    assert any(r.path == "/settings" and r.admin for r in ROUTES)


def test_admin_routes_closed_outside():
    leaks = [f"{r.method} /api{r.path} ({r.source})" for r in ROUTES
             if r.admin and allowed("/api" + _sample(r.path), r.method, EXTERNAL)]
    assert not leaks, "ручки под requireAdmin открыты снаружи:\n" + "\n".join(leaks)
    blocked = [f"{r.method} /api{r.path}" for r in ROUTES
               if r.admin and not allowed("/api" + _sample(r.path), r.method, LAN)]
    assert not blocked, "из LAN закрыто:\n" + "\n".join(blocked)


def test_open_routes_whitelisted_or_explained():
    wrong = []
    for r in ROUTES:
        if r.admin:
            continue
        outside = allowed("/api" + _sample(r.path), r.method, EXTERNAL)
        if r.path in NOT_FOR_LISTENERS:
            if outside:
                wrong.append(f"{r.method} /api{r.path}: в NOT_FOR_LISTENERS, но открыт")
        elif not outside:
            wrong.append(f"{r.method} /api{r.path} ({r.source}): открытая ручка закрыта "
                         "снаружи — в белый список или в NOT_FOR_LISTENERS с причиной")
    assert not wrong, "\n".join(wrong)


def test_not_for_listeners_entries_still_exist():
    open_paths = {r.path for r in ROUTES if not r.admin}
    stale = sorted(set(NOT_FOR_LISTENERS) - open_paths)
    assert not stale, f"таких открытых ручек у контроллера больше нет: {stale}"


def test_client_sources_parsed():
    paths = {p for _, p in CLIENT_PATHS}
    assert {"/now-playing", "/request", "/station-auth", "/listen.pls", "/dj"} <= paths


@pytest.mark.parametrize("source,path", CLIENT_PATHS)
def test_listener_calls_pass(source, path):
    routes = [r for r in ROUTES if not r.admin and _route_regex(r.path).match(path)]
    assert routes, f"{source} зовёт {path}, а открытой ручки с таким путём нет"
    for r in routes:
        assert allowed("/api" + path, r.method, EXTERNAL), f"{r.method} /api{path}"
